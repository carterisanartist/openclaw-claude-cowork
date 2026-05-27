/**
 * Tests for server/state.ts.
 *
 * Covers the things most likely to silently corrupt data:
 *   - load() merging legacy lastUpdateId from state.json into watermark.json
 *   - watermark advances strictly monotonically
 *   - upsertRequest debounce + upsertRequestDurable flush-through
 *   - acquireLock contention against a live PID and reclaim of stale locks
 *   - garbage collect respects status
 *   - outbound queue FIFO + attempt counter
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../dist/state.js";

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), "ccb-state-"));
  const store = new StateStore(dir);
  await store.load();
  return { store, dir };
}

test("state: load migrates legacy lastUpdateId from state.json into watermark.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccb-state-"));
  // Pre-seed an old-style state.json that puts lastUpdateId at the root.
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify({ requests: {}, escalations: {}, lastUpdateId: 999 }),
    "utf8",
  );
  const store = new StateStore(dir);
  await store.load();
  assert.equal(store.state.lastUpdateId, 999);
  await store.drain();
  // After drain, the watermark file should also reflect it.
  const wm = JSON.parse(await readFile(join(dir, "watermark.json"), "utf8"));
  assert.equal(wm.lastUpdateId, 999);
});

test("state: setLastUpdateId is strictly monotonic", async () => {
  const { store } = await freshStore();
  store.setLastUpdateId(10);
  assert.equal(store.state.lastUpdateId, 10);
  store.setLastUpdateId(5);
  assert.equal(store.state.lastUpdateId, 10);
  store.setLastUpdateId(11);
  assert.equal(store.state.lastUpdateId, 11);
});

test("state: upsertRequestDurable persists before resolving", async () => {
  const { store, dir } = await freshStore();
  await store.upsertRequestDurable({
    requestId: "abc",
    task: "do thing",
    sentAt: Date.now(),
    status: "completed",
    reply: "ok",
  });
  // No drain needed - durable variant must flush synchronously.
  const onDisk = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  assert.equal(onDisk.requests.abc.reply, "ok");
});

test("state: upsertRequest debounce coalesces writes", async () => {
  const { store, dir } = await freshStore();
  for (let i = 0; i < 10; i += 1) {
    store.upsertRequest({
      requestId: `r${i}`,
      task: "t",
      sentAt: Date.now(),
      status: "pending",
    });
  }
  // Immediately after the burst, the file should NOT yet contain all 10
  // entries because writes are debounced.
  // (We can't assert the count is < 10 deterministically since the timer
  // could fire fast; but drain MUST flush all of them.)
  await store.drain();
  const onDisk = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  assert.equal(Object.keys(onDisk.requests).length, 10);
});

test("state: acquireLock blocks a second instance pointing at the same dir", async () => {
  const { store, dir } = await freshStore();
  await store.acquireLock();
  const second = new StateStore(dir);
  await second.load();
  await assert.rejects(() => second.acquireLock(), /already running/);
  await store.releaseLock();
  // After release, the second can claim it.
  await second.acquireLock();
  await second.releaseLock();
});

test("state: acquireLock reclaims a stale lock from a dead PID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccb-state-"));
  // Write a lock pointing at a PID that's almost certainly dead. PID 1 is
  // reliably alive on every host; we want a dead one. Use a very large pid.
  await writeFile(
    join(dir, ".lock"),
    JSON.stringify({ pid: 999_999_999, startedAt: 1 }),
    "utf8",
  );
  const store = new StateStore(dir);
  await store.load();
  await store.acquireLock(); // must not throw
  // And the lock file now points at us.
  const owner = JSON.parse(await readFile(join(dir, ".lock"), "utf8"));
  assert.equal(owner.pid, process.pid);
  await store.releaseLock();
});

test("state: garbageCollect drops completed requests older than the cutoff", async () => {
  const { store } = await freshStore();
  store.upsertRequest({
    requestId: "old",
    task: "t",
    sentAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    status: "completed",
  });
  store.upsertRequest({
    requestId: "recent",
    task: "t",
    sentAt: Date.now(),
    status: "completed",
  });
  store.upsertRequest({
    requestId: "old-pending",
    task: "t",
    sentAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    status: "pending",
  });
  store.garbageCollect(7 * 24 * 60 * 60 * 1000);
  assert.equal(store.getRequest("old"), undefined);
  assert.ok(store.getRequest("recent"));
  // Pending requests must survive GC even when old.
  assert.ok(store.getRequest("old-pending"));
});

test("state: outbound queue is FIFO with per-item attempt counter", async () => {
  const { store } = await freshStore();
  store.enqueueOutbound({ id: "a", enqueuedAt: 1, text: "/reset", attempts: 0 });
  store.enqueueOutbound({ id: "b", enqueuedAt: 2, text: "/reset", attempts: 0 });
  const snap1 = store.outboundQueueSnapshot();
  assert.deepEqual(snap1.map((s) => s.id), ["a", "b"]);

  store.recordOutboundAttempt("a");
  store.recordOutboundAttempt("a");
  const snap2 = store.outboundQueueSnapshot();
  assert.equal(snap2[0].attempts, 2);
  assert.equal(snap2[1].attempts, 0);

  store.dequeueOutbound("a");
  const snap3 = store.outboundQueueSnapshot();
  assert.deepEqual(snap3.map((s) => s.id), ["b"]);
});

test("state: durable writes are atomic - no tmp file lingers after drain", async () => {
  const { store, dir } = await freshStore();
  store.upsertRequest({
    requestId: "x",
    task: "t",
    sentAt: Date.now(),
    status: "completed",
  });
  await store.drain();
  await assert.rejects(
    () => stat(join(dir, "state.json.tmp")),
    /ENOENT/,
    "atomic write should have renamed the .tmp away",
  );
});

test("state: load tolerates a corrupt state.json by resetting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccb-state-"));
  await writeFile(join(dir, "state.json"), "{not valid json", "utf8");
  const store = new StateStore(dir);
  // Should not throw.
  await store.load();
  assert.deepEqual(store.state.requests, {});
  assert.deepEqual(store.state.escalations, {});
});
