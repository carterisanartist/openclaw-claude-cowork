import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "./logger.js";

/**
 * On-disk state shared across plugin runs.
 *
 * Two files, two cadences:
 *   - `state.json`     - slow-moving structures (pending requests, escalations).
 *                        Debounced flush; fsync'd on write for durability.
 *   - `watermark.json` - the Telegram getUpdates offset alone. Updated on
 *                        every message; debounced separately so a busy poll
 *                        loop doesn't trigger a state.json rewrite per tick.
 *
 * Cross-process safety:
 *   - `acquireLock()` writes a `.lock` sentinel with our PID + start time.
 *     If a lock file is present and the owning PID is still alive, we throw.
 *     This prevents two bridge instances (e.g. installed in both Claude Code
 *     and Claude Desktop on the same machine) from racing the Telegram
 *     getUpdates long-poll and silently dropping each other's messages.
 *   - The lock is released on graceful shutdown. If the bridge crashes hard,
 *     the next start finds the lock, checks the PID, finds it dead, and
 *     reclaims.
 *
 * Single writer assumption (within a process): only one StateStore instance
 * per state dir. Multiple readers are fine but no concurrent flushes.
 */

export interface PendingRequest {
  requestId: string;
  task: string;
  sentAt: number;
  status: "pending" | "completed" | "cancelled" | "timeout";
  reply?: string;
  /** True once we returned the result for a synchronous dispatch. */
  consumed?: boolean;
}

export interface PendingEscalation {
  escalationId: string;
  /** request_id this escalation belongs to, if known. */
  requestId?: string;
  /** Body of Claw's message with the marker stripped. */
  question: string;
  /** Epoch ms. */
  raisedAt: number;
  status: "pending" | "answered";
  answer?: string;
  answeredAt?: number;
  /**
   * When true, this escalation was raised in a message we couldn't attribute
   * to any in-flight dispatch (e.g. Claw escalated proactively without our
   * tag). Surfaced by claw_check_escalations so Claude still sees it.
   */
  unattributed?: boolean;
}

/**
 * Queued chat-command sends the bridge owes Claw. Used today by the
 * cancellation path: when the user calls claw_cancel and our local resolver
 * is dropped, we still need to make sure Claw sees `/reset`. If Telegram is
 * down at that moment we'd lose the reset, so we persist it and retry on
 * every poll tick until it lands.
 */
export interface OutboundQueueItem {
  id: string;
  /** When the item was first enqueued (epoch ms). */
  enqueuedAt: number;
  text: string;
  attempts: number;
  /** Optional ceiling on attempts; default 20. */
  maxAttempts?: number;
}

export interface PersistedState {
  requests: Record<string, PendingRequest>;
  escalations: Record<string, PendingEscalation>;
  outboundQueue: OutboundQueueItem[];
}

interface PersistedWatermark {
  lastUpdateId: number;
}

const DEFAULT_STATE: PersistedState = {
  requests: {},
  escalations: {},
  outboundQueue: [],
};

const DEFAULT_WATERMARK: PersistedWatermark = { lastUpdateId: 0 };

/**
 * How long to wait after a dirty mark before flushing to disk. Coalesces
 * bursts (e.g. several updates arriving in the same long-poll batch) into a
 * single write. Tuned to be invisible to humans but small enough that a
 * crash within the window loses at most this much progress.
 */
const STATE_FLUSH_DEBOUNCE_MS = 250;
const WATERMARK_FLUSH_DEBOUNCE_MS = 500;

export class StateStore {
  private stateCache: PersistedState = structuredClone(DEFAULT_STATE);
  private watermarkCache: PersistedWatermark = structuredClone(DEFAULT_WATERMARK);
  private loaded = false;

  private writeChain: Promise<void> = Promise.resolve();
  private stateDirty = false;
  private stateFlushTimer: NodeJS.Timeout | null = null;
  private watermarkDirty = false;
  private watermarkFlushTimer: NodeJS.Timeout | null = null;

  private readonly statePath: string;
  private readonly watermarkPath: string;
  private readonly lockPath: string;
  private readonly stateDir: string;
  private lockHeld = false;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.statePath = join(stateDir, "state.json");
    this.watermarkPath = join(stateDir, "watermark.json");
    this.lockPath = join(stateDir, ".lock");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.stateDir, { recursive: true });

    // state.json
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState> & {
        // Backwards compatibility: older bridges stored lastUpdateId here.
        lastUpdateId?: number;
      };
      this.stateCache = {
        requests:
          parsed.requests && typeof parsed.requests === "object" ? parsed.requests : {},
        escalations:
          parsed.escalations && typeof parsed.escalations === "object"
            ? parsed.escalations
            : {},
        outboundQueue: Array.isArray(parsed.outboundQueue)
          ? parsed.outboundQueue.filter(
              (item): item is OutboundQueueItem =>
                typeof item === "object" &&
                item !== null &&
                typeof (item as OutboundQueueItem).id === "string" &&
                typeof (item as OutboundQueueItem).text === "string",
            )
          : [],
      };
      // Migrate legacy lastUpdateId from state.json into watermark.json on
      // first load. Older builds wrote everything into state.json.
      if (typeof parsed.lastUpdateId === "number") {
        this.watermarkCache.lastUpdateId = parsed.lastUpdateId;
        this.markWatermarkDirty();
      }
      log.debug("state.loaded", { path: this.statePath });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn("state.load_failed_resetting", {
          path: this.statePath,
          error: String(err),
        });
      }
      this.stateCache = structuredClone(DEFAULT_STATE);
    }

    // watermark.json
    try {
      const raw = await readFile(this.watermarkPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedWatermark>;
      if (typeof parsed.lastUpdateId === "number" && parsed.lastUpdateId > this.watermarkCache.lastUpdateId) {
        this.watermarkCache.lastUpdateId = parsed.lastUpdateId;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn("state.watermark_load_failed_resetting", {
          path: this.watermarkPath,
          error: String(err),
        });
      }
    }

    this.loaded = true;
    // Ensure both files exist on disk after first load so subsequent crashes
    // don't trigger the ENOENT warning path next time.
    await this.flushStateNow();
    await this.flushWatermarkNow();
  }

  /**
   * Try to acquire an exclusive lock on this state dir.
   *
   * Implementation: `wx` open of `.lock` containing JSON `{pid, startedAt}`.
   * If the file already exists, read it; if the recorded PID is alive,
   * throw with actionable guidance. If it's dead, reclaim the lock.
   */
  async acquireLock(): Promise<void> {
    if (this.lockHeld) return;
    await mkdir(this.stateDir, { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fh = await open(this.lockPath, "wx");
        try {
          const payload = JSON.stringify({
            pid: process.pid,
            startedAt: Date.now(),
          });
          await fh.writeFile(payload, "utf8");
          await fh.sync();
        } finally {
          await fh.close();
        }
        this.lockHeld = true;
        log.debug("state.lock_acquired", { path: this.lockPath, pid: process.pid });
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw err;
        // Inspect existing lock.
        const existing = await this.readLockOwner();
        if (existing && pidAlive(existing.pid)) {
          throw new Error(
            `Another company-claw-bridge instance is already running ` +
              `(pid ${existing.pid}, started ${new Date(existing.startedAt).toISOString()}). ` +
              `If that's stale, delete ${this.lockPath} and retry.`,
          );
        }
        // Stale lock; remove and try again exactly once.
        try {
          await unlink(this.lockPath);
          log.warn("state.lock_stale_reclaimed", {
            stalePid: existing?.pid ?? null,
          });
        } catch {
          // Race: another process may have removed it. Loop and try again.
        }
      }
    }
    throw new Error(`Failed to acquire state lock at ${this.lockPath}`);
  }

  async releaseLock(): Promise<void> {
    if (!this.lockHeld) return;
    try {
      const existing = await this.readLockOwner();
      // Only delete the lock if it's still ours - protects against the rare
      // case where another process reclaimed our lock thinking we'd died.
      if (existing && existing.pid === process.pid) {
        await unlink(this.lockPath);
      }
    } catch {
      // best-effort
    }
    this.lockHeld = false;
  }

  private async readLockOwner(): Promise<{ pid: number; startedAt: number } | null> {
    try {
      const raw = await readFile(this.lockPath, "utf8");
      const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
      if (typeof parsed.pid !== "number") return null;
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Convenience getter used by older code paths. Returns a synthetic view
   * combining the persisted state with the current watermark, so callers
   * that previously read `state.lastUpdateId` still work.
   */
  get state(): PersistedState & { lastUpdateId: number } {
    if (!this.loaded) {
      throw new Error("StateStore not loaded; call load() before use.");
    }
    return {
      ...this.stateCache,
      lastUpdateId: this.watermarkCache.lastUpdateId,
    };
  }

  /**
   * Advance the Telegram watermark. No-op if `id` is not strictly greater
   * than the current value.
   */
  setLastUpdateId(id: number): void {
    if (id <= this.watermarkCache.lastUpdateId) return;
    this.watermarkCache.lastUpdateId = id;
    this.markWatermarkDirty();
  }

  upsertRequest(req: PendingRequest): void {
    this.stateCache.requests[req.requestId] = req;
    this.markStateDirty();
  }

  /**
   * Synchronous variant: mark dirty AND immediately schedule a flush we can
   * await. Used by the dispatcher's `finalize()` so a `claw_poll` immediately
   * after a sync dispatch sees the persisted reply.
   */
  async upsertRequestDurable(req: PendingRequest): Promise<void> {
    this.stateCache.requests[req.requestId] = req;
    this.stateDirty = true;
    if (this.stateFlushTimer) {
      clearTimeout(this.stateFlushTimer);
      this.stateFlushTimer = null;
    }
    await this.runFlushNow("state");
  }

  getRequest(requestId: string): PendingRequest | undefined {
    return this.stateCache.requests[requestId];
  }

  upsertEscalation(esc: PendingEscalation): void {
    this.stateCache.escalations[esc.escalationId] = esc;
    this.markStateDirty();
  }

  getEscalation(id: string): PendingEscalation | undefined {
    return this.stateCache.escalations[id];
  }

  pendingEscalations(): PendingEscalation[] {
    return Object.values(this.stateCache.escalations).filter((e) => e.status === "pending");
  }

  /** Enqueue a chat-command send we'll retry until Claw acks it. */
  enqueueOutbound(item: OutboundQueueItem): void {
    this.stateCache.outboundQueue.push(item);
    this.markStateDirty();
  }

  /** Return a shallow copy of the queue, ordered FIFO. */
  outboundQueueSnapshot(): OutboundQueueItem[] {
    return [...this.stateCache.outboundQueue];
  }

  dequeueOutbound(id: string): void {
    const before = this.stateCache.outboundQueue.length;
    this.stateCache.outboundQueue = this.stateCache.outboundQueue.filter(
      (item) => item.id !== id,
    );
    if (this.stateCache.outboundQueue.length !== before) this.markStateDirty();
  }

  recordOutboundAttempt(id: string): void {
    const item = this.stateCache.outboundQueue.find((i) => i.id === id);
    if (!item) return;
    item.attempts += 1;
    this.markStateDirty();
  }

  /**
   * Drop requests + escalations older than `maxAgeMs`. Keeps the state file
   * from growing unbounded across long-running sessions.
   */
  garbageCollect(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    let dirty = false;
    for (const [id, req] of Object.entries(this.stateCache.requests)) {
      if (req.sentAt < cutoff && req.status !== "pending") {
        delete this.stateCache.requests[id];
        dirty = true;
      }
    }
    for (const [id, esc] of Object.entries(this.stateCache.escalations)) {
      if (esc.raisedAt < cutoff && esc.status === "answered") {
        delete this.stateCache.escalations[id];
        dirty = true;
      }
    }
    if (dirty) this.markStateDirty();
  }

  // ----- flush plumbing -----

  private markStateDirty(): void {
    this.stateDirty = true;
    if (this.stateFlushTimer) return;
    this.stateFlushTimer = setTimeout(() => {
      this.stateFlushTimer = null;
      void this.runFlushNow("state");
    }, STATE_FLUSH_DEBOUNCE_MS);
  }

  private markWatermarkDirty(): void {
    this.watermarkDirty = true;
    if (this.watermarkFlushTimer) return;
    this.watermarkFlushTimer = setTimeout(() => {
      this.watermarkFlushTimer = null;
      void this.runFlushNow("watermark");
    }, WATERMARK_FLUSH_DEBOUNCE_MS);
  }

  private runFlushNow(target: "state" | "watermark"): Promise<void> {
    // Chain all flushes through writeChain so we never have overlapping
    // writes to the same file (atomic rename helps but still: predictable
    // ordering avoids surprising the OS scheduler).
    this.writeChain = this.writeChain
      .then(async () => {
        if (target === "state") await this.flushStateNow();
        else await this.flushWatermarkNow();
      })
      .catch((err) => {
        log.warn("state.flush_failed", { target, error: String(err) });
      });
    return this.writeChain;
  }

  private async flushStateNow(): Promise<void> {
    if (!this.stateDirty && (await fileExists(this.statePath))) return;
    await this.writeJsonDurable(this.statePath, this.stateCache);
    this.stateDirty = false;
  }

  private async flushWatermarkNow(): Promise<void> {
    if (!this.watermarkDirty && (await fileExists(this.watermarkPath))) return;
    await this.writeJsonDurable(this.watermarkPath, this.watermarkCache);
    this.watermarkDirty = false;
  }

  /**
   * Atomic + durable write: write to `tmp`, fsync the file, rename over the
   * target. The fsync guarantees the bytes reach disk before the rename, so
   * a crash mid-rename leaves either the old file or the new file intact
   * (never a torn write).
   */
  private async writeJsonDurable(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const payload = JSON.stringify(value, null, 2);
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(payload, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  }

  /** Await any in-flight write. Called on shutdown. */
  async drain(): Promise<void> {
    if (this.stateFlushTimer) {
      clearTimeout(this.stateFlushTimer);
      this.stateFlushTimer = null;
      void this.runFlushNow("state");
    }
    if (this.watermarkFlushTimer) {
      clearTimeout(this.watermarkFlushTimer);
      this.watermarkFlushTimer = null;
      void this.runFlushNow("watermark");
    }
    await this.writeChain;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    // signal 0 doesn't kill - it just probes whether we're allowed to signal
    // the target, which throws ESRCH when the process is gone.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it (different user);
    // for our purposes that's still "alive enough to assume the lock is real".
    return code === "EPERM";
  }
}

