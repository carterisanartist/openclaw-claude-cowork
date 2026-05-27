/**
 * Tests for server/dispatcher.ts.
 *
 * We drive the dispatcher with a stub TelegramClient and a stub AuditTee so
 * the tests don't touch the network. The key invariants exercised here are
 * the ones we just rewrote dispatcher.ts for: tagged-vs-fallback matching,
 * stream-continuation preference for hard-matched resolvers, unattributed
 * escalation surfacing, persisted reply on async finalize, and outbound
 * /reset enqueueing on cancel.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../dist/state.js";
import { Dispatcher } from "../dist/dispatcher.js";

class FakeTelegram {
  constructor() {
    this.sent = [];
    this.listeners = new Set();
    this.nextMessageId = 1000;
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  async sendMessage(text) {
    const message_id = this.nextMessageId++;
    this.sent.push({ text, message_id });
    return { message_id, date: Math.floor(Date.now() / 1000), text, chat: { id: 1, type: "private" } };
  }
  /** Push an inbound message through the subscribers. */
  async push(msg) {
    for (const l of this.listeners) await l(msg);
  }
}

class FakeAudit {
  constructor() { this.entries = []; }
  async mirrorOutbound(x) { this.entries.push({ kind: "out", ...x }); }
  async mirrorInbound(x) { this.entries.push({ kind: "in", ...x }); }
  async mirrorEscalationAnswer(x) { this.entries.push({ kind: "esc", ...x }); }
}

const baseConfig = {
  telegramBotToken: "t",
  clawChatId: "1",
  auditChatId: null,
  devMirror: false,
  defaultTimeoutMs: 5_000,
  escalationMarker: "[ASK-CLAUDE]",
  stateDir: "/tmp",
  startupHealthCheck: false,
};

async function harness(t) {
  const dir = await mkdtemp(join(tmpdir(), "ccb-disp-"));
  const state = new StateStore(dir);
  await state.load();
  const telegram = new FakeTelegram();
  const audit = new FakeAudit();
  const config = { ...baseConfig, stateDir: dir };
  const dispatcher = new Dispatcher({ config, state, telegram, audit });
  dispatcher.start();
  // Crucial: tear down the dispatcher so its 5s outbound-flush setInterval
  // doesn't keep the event loop alive between tests.
  t.after(async () => {
    await dispatcher.stop();
    await state.drain();
  });
  return { dispatcher, state, telegram, audit };
}

/**
 * Wait until dispatcher.dispatch has finished its initial sendMessage step
 * and the resolver is in this.pending. We can detect that by the FakeTelegram
 * having logged the outbound message.
 */
async function waitForSent(telegram, prevCount = 0) {
  for (let i = 0; i < 100; i += 1) {
    if (telegram.sent.length > prevCount) return telegram.sent[telegram.sent.length - 1];
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("timed out waiting for sendMessage");
}

test("dispatcher: tagged reply resolves the right request", async (t) => {
  const { dispatcher, telegram } = await harness(t);
  const p = dispatcher.dispatch("hello", { timeoutMs: 8_000 });
  const sent = await waitForSent(telegram);
  const tag = /\[req:([A-Za-z0-9_-]{6,12})\]/.exec(sent.text)[1];
  await telegram.push({
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 1, type: "private" },
    text: `[req:${tag}] hi back`,
  });
  // Wait for the quiet window to expire.
  await new Promise((r) => setTimeout(r, 4_200));
  const res = await p;
  assert.equal(res.reply, "hi back");
  assert.equal(res.escalated, false);
});

test("dispatcher: untagged streamed continuation attaches to the hard-matched resolver", async (t) => {
  const { dispatcher, telegram } = await harness(t);
  const p = dispatcher.dispatch("hello", { timeoutMs: 10_000 });
  const sent = await waitForSent(telegram);
  const tag = /\[req:([A-Za-z0-9_-]{6,12})\]/.exec(sent.text)[1];

  // First message tags. Second message is a streamed continuation with no tag.
  await telegram.push({
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 1, type: "private" },
    text: `[req:${tag}] part 1`,
  });
  await telegram.push({
    message_id: 2,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 1, type: "private" },
    text: `part 2`,
  });
  await new Promise((r) => setTimeout(r, 4_300));
  const res = await p;
  assert.match(res.reply, /part 1/);
  assert.match(res.reply, /part 2/);
});

test("dispatcher: untagged proactive [ASK-CLAUDE] surfaces as unattributed escalation", async (t) => {
  const { dispatcher, state, telegram } = await harness(t);
  // Install an escalation hook that mints an id like escalation.ts does.
  dispatcher.setEscalationHook(({ requestId, body }) => {
    const id = `esc-${Date.now()}`;
    state.upsertEscalation({
      escalationId: id,
      requestId: requestId || undefined,
      question: body,
      raisedAt: Date.now(),
      status: "pending",
    });
    return id;
  });
  await telegram.push({
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 1, type: "private" },
    text: `[ASK-CLAUDE] should I deploy?`,
  });
  // Allow the listener microtasks to flush.
  await new Promise((r) => setImmediate(r));
  const pending = state.pendingEscalations();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].unattributed, true);
  assert.equal(pending[0].question, "should I deploy?");
});

test("dispatcher: cancelAsync enqueues a /reset on the outbound queue", async (t) => {
  const { dispatcher, telegram } = await harness(t);
  const id = await dispatcher.dispatchAsync("long task");
  // Saturate the fake telegram so the in-line flush attempt fails - but
  // since FakeTelegram.sendMessage always succeeds, the queued reset will
  // just be drained immediately. We still get to see it was enqueued
  // because we check the queue before the flush runs.
  // Cancel the request.
  const ok = await dispatcher.cancelAsync(id);
  assert.equal(ok, true);
  // The outbound queue should be empty (drained) but the cancel sent /reset.
  const resetSent = telegram.sent.find((m) => m.text.includes("/reset"));
  assert.ok(resetSent, "cancel must send /reset on the wire");
});

test("dispatcher: async finalize persists reply durably", async (t) => {
  const { dispatcher, state, telegram } = await harness(t);
  const id = await dispatcher.dispatchAsync("do work");
  const sent = await waitForSent(telegram);
  const tag = /\[req:([A-Za-z0-9_-]{6,12})\]/.exec(sent.text)[1];
  await telegram.push({
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 1, type: "private" },
    text: `[req:${tag}] done!`,
  });
  await new Promise((r) => setTimeout(r, 4_300));
  const persisted = state.getRequest(id);
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.reply, "done!");
});
