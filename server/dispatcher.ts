import { randomUUID } from "node:crypto";
import type { AuditTee } from "./audit.js";
import type { BridgeConfig } from "./config.js";
import { log } from "./logger.js";
import type { OutboundQueueItem, PendingRequest, StateStore } from "./state.js";
import type { TelegramClient, TelegramMessage } from "./telegram.js";

/**
 * Correlates outbound dispatch requests with Claw's Telegram replies and
 * surfaces streamed progress to MCP clients.
 *
 * Tagging strategy:
 *   - Every outbound message gets a "[req:<id>] " prefix, where <id> is an
 *     8-char URL-safe slice of a uuid.
 *   - If Claw quotes/echoes the tag, we match exactly (tagged match).
 *   - If not, we fall back to "next reply from Claw to our message" within a
 *     quiet window: the first inbound message after our send timestamp.
 *
 * FIFO race protection (improvement over earlier behaviour):
 *   When a tagged dispatch is in flight and an untagged reply arrives, we
 *   used to attach it to the OLDEST untagged-pending resolver in FIFO order.
 *   That mis-attributes Claw's streamed second sentence to a later dispatch
 *   when an earlier one is mid-response. Instead, we now prefer the most
 *   RECENTLY hard-matched resolver inside the quiet window; only after that
 *   window closes do we fall through to FIFO.
 *
 * Unattributed messages (improvement over earlier behaviour):
 *   Previously we silently dropped messages we couldn't route. That hides
 *   Claw's proactive escalations and "what happened?" messages. Now: if the
 *   message starts with the escalation marker we record a pending escalation
 *   with `unattributed=true` so claw_check_escalations surfaces it; otherwise
 *   we log a warning so operators see drops in the audit log.
 *
 * Escalations:
 *   - Replies prefixed with the escalation marker are routed to the
 *     escalation hook BEFORE being treated as a normal reply. They keep
 *     the dispatch open so that any extra context Claw streams along with
 *     the marker (lines after [ASK-CLAUDE]) gets captured.
 */

const TAG_REGEX = /\[req:([A-Za-z0-9_-]{6,12})\]/;

export interface DispatchOptions {
  /** Override the default reply timeout for this single dispatch. */
  timeoutMs?: number;
  /** Stream incremental Claw replies via this callback. */
  onProgress?: (chunk: ProgressChunk) => void | Promise<void>;
  /**
   * AbortSignal that cancels the dispatch. The dispatcher will mark the
   * request cancelled and reject with the abort reason.
   */
  signal?: AbortSignal;
  /**
   * Prefix a Claw chat command (e.g. "/think high") before the task. The
   * command and the task are sent as a single message so they are processed
   * in order.
   */
  command?: string;
  /**
   * Skip the [req:] tag entirely. Used for chat-command-only dispatches
   * (e.g. /status, /reset) where matching by next-reply is more reliable.
   */
  untagged?: boolean;
}

export interface DispatchResult {
  requestId: string;
  /** Full concatenated text of all matched reply messages. */
  reply: string;
  /** True if Claw raised an escalation during this dispatch. */
  escalated: boolean;
  /** Set when escalated. The escalation id Claude can answer with. */
  escalationId?: string;
  /** Set when escalated. Body of Claw's question, marker stripped. */
  escalationQuestion?: string;
  /** Telegram message_id of our outbound message. */
  outboundMessageId: number;
  /** Telegram message_ids of every reply we attributed to this request. */
  inboundMessageIds: number[];
}

export interface ProgressChunk {
  requestId: string;
  /** Cumulative reply text up to and including this chunk. */
  text: string;
  /** Just the new fragment from this latest message. */
  delta: string;
  messageId: number;
  /** True if this chunk carried the escalation marker. */
  escalation: boolean;
}

interface PendingResolver {
  requestId: string;
  /** Telegram message_id of our outbound. */
  outboundMessageId: number;
  sentAt: number;
  /** True if the outbound carried a [req:] tag. */
  tagged: boolean;
  /** Tag id (without brackets/prefix), undefined if untagged. */
  tagId?: string;
  /** Buffered reply messages. */
  parts: TelegramMessage[];
  /**
   * Set when at least one tagged reply was matched. From then on, this
   * resolver "owns" any untagged streamed continuations that arrive inside
   * the quiet window (Claw splits long replies across messages and only
   * tags the first one).
   */
  hardMatched: boolean;
  /** Set when the *quiet window* is open after the most recent matched part. */
  lastAttachedAt: number;
  /** Timer that finalizes the request after a quiet-window expires. */
  quietTimer: NodeJS.Timeout | null;
  /** Timeout timer for the whole dispatch. */
  overallTimer: NodeJS.Timeout;
  resolve: (result: DispatchResult) => void;
  reject: (err: Error) => void;
  options: DispatchOptions;
  task: string;
  command?: string;
  /** Set by the escalation hook when Claw escalates within this dispatch. */
  escalationInfo?: { id: string; question: string };
  /** True if finalize() has been called (idempotency guard). */
  finalized: boolean;
}

export type EscalationHook = (args: {
  requestId: string;
  message: TelegramMessage;
  body: string;
}) => string | null;

export class Dispatcher {
  private readonly config: BridgeConfig;
  private readonly state: StateStore;
  private readonly telegram: TelegramClient;
  private readonly audit: AuditTee;
  /** Maps request_id -> resolver. */
  private readonly pending = new Map<string, PendingResolver>();
  /** FIFO of request_ids for fallback matching. */
  private readonly pendingOrder: string[] = [];
  private unsubscribe: (() => void) | null = null;
  private escalationHook: EscalationHook | null = null;

  /**
   * Quiet-window (ms) after the last inbound message before we consider the
   * reply complete when no further matching messages arrive. Tuned to be
   * forgiving for streamed/multi-part replies.
   */
  private readonly quietWindowMs = 4_000;

  /** Outbound retry plumbing for queued messages (e.g. /reset cancellations). */
  private outboundFlushTimer: NodeJS.Timeout | null = null;
  private readonly outboundRetryIntervalMs = 5_000;

  constructor(opts: {
    config: BridgeConfig;
    state: StateStore;
    telegram: TelegramClient;
    audit: AuditTee;
  }) {
    this.config = opts.config;
    this.state = opts.state;
    this.telegram = opts.telegram;
    this.audit = opts.audit;
  }

  /** Set by escalation.ts to intercept [ASK-CLAUDE] messages. */
  setEscalationHook(hook: EscalationHook): void {
    this.escalationHook = hook;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.telegram.subscribe((msg) => this.handleIncoming(msg));
    this.scheduleOutboundFlush();
    // Drain anything we owe Claw left over from a previous crashed run.
    void this.flushOutboundQueue();
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.outboundFlushTimer) {
      clearTimeout(this.outboundFlushTimer);
      this.outboundFlushTimer = null;
    }
    for (const resolver of this.pending.values()) {
      this.cancelResolver(resolver, new Error("Dispatcher shutting down"));
    }
  }

  /**
   * Send a task and wait for the full reply. Throws on timeout/abort.
   */
  async dispatch(task: string, opts: DispatchOptions = {}): Promise<DispatchResult> {
    this.start();
    const requestId = randomUUID().replaceAll("-", "").slice(0, 8);
    const tag = opts.untagged ? "" : `[req:${requestId}] `;
    const commandPrefix = opts.command ? `${opts.command}\n` : "";
    const payload = `${tag}${commandPrefix}${task}`;

    const sentAt = Date.now();
    const sent = await this.telegram.sendMessage(payload);
    await this.audit.mirrorOutbound({ requestId, text: payload, messageId: sent.message_id });

    const persisted: PendingRequest = {
      requestId,
      task,
      sentAt,
      status: "pending",
    };
    this.state.upsertRequest(persisted);

    const timeoutMs = opts.timeoutMs ?? this.config.defaultTimeoutMs;

    return await new Promise<DispatchResult>((resolve, reject) => {
      const overallTimer = setTimeout(() => {
        const resolver = this.pending.get(requestId);
        if (!resolver) return;
        if (resolver.parts.length > 0) {
          void this.finalize(resolver, /*timedOut*/ true);
          return;
        }
        this.dropResolver(requestId);
        void this.markRequestStatus(requestId, "timeout");
        reject(new Error(`Dispatch ${requestId} timed out after ${timeoutMs}ms with no reply.`));
      }, timeoutMs);

      const resolver: PendingResolver = {
        requestId,
        outboundMessageId: sent.message_id,
        sentAt,
        tagged: !opts.untagged,
        tagId: opts.untagged ? undefined : requestId,
        parts: [],
        hardMatched: false,
        lastAttachedAt: 0,
        quietTimer: null,
        overallTimer,
        resolve,
        reject,
        options: opts,
        task,
        command: opts.command,
        finalized: false,
      };
      this.pending.set(requestId, resolver);
      this.pendingOrder.push(requestId);

      if (opts.signal) {
        if (opts.signal.aborted) {
          this.cancelResolver(resolver, new Error("Dispatch aborted before send"));
          return;
        }
        opts.signal.addEventListener(
          "abort",
          () => {
            this.cancelResolver(resolver, new Error("Dispatch aborted by caller"));
          },
          { once: true },
        );
      }
    });
  }

  /**
   * Fire-and-forget variant. Returns immediately with the request_id; the
   * resolver lives in this.pending and the result is stashed onto the
   * persisted PendingRequest as it streams in.
   */
  async dispatchAsync(task: string, opts: DispatchOptions = {}): Promise<string> {
    this.start();
    const requestId = randomUUID().replaceAll("-", "").slice(0, 8);
    const tag = opts.untagged ? "" : `[req:${requestId}] `;
    const commandPrefix = opts.command ? `${opts.command}\n` : "";
    const payload = `${tag}${commandPrefix}${task}`;
    const sentAt = Date.now();
    const sent = await this.telegram.sendMessage(payload);
    await this.audit.mirrorOutbound({ requestId, text: payload, messageId: sent.message_id });

    const persisted: PendingRequest = {
      requestId,
      task,
      sentAt,
      status: "pending",
    };
    this.state.upsertRequest(persisted);

    const timeoutMs = opts.timeoutMs ?? this.config.defaultTimeoutMs;

    const resolver: PendingResolver = {
      requestId,
      outboundMessageId: sent.message_id,
      sentAt,
      tagged: !opts.untagged,
      tagId: opts.untagged ? undefined : requestId,
      parts: [],
      hardMatched: false,
      lastAttachedAt: 0,
      quietTimer: null,
      overallTimer: setTimeout(() => {
        const r = this.pending.get(requestId);
        if (!r) return;
        if (r.parts.length > 0) {
          void this.finalize(r, true);
        } else {
          this.dropResolver(requestId);
          void this.markRequestStatus(requestId, "timeout");
        }
      }, timeoutMs),
      resolve: (result) => {
        // Persist durably so a `claw_poll` immediately after this resolves
        // never sees an empty reply due to a flush still being debounced.
        void this.state
          .upsertRequestDurable({
            requestId,
            task,
            sentAt,
            status: "completed",
            reply: result.reply,
          })
          .catch((err) => log.warn("dispatch.persist_failed", { error: String(err) }));
      },
      reject: () => {
        void this.markRequestStatus(requestId, "timeout");
      },
      options: opts,
      task,
      command: opts.command,
      finalized: false,
    };
    this.pending.set(requestId, resolver);
    this.pendingOrder.push(requestId);
    return requestId;
  }

  /** Look up the current accumulated reply text for an async dispatch. */
  pollAsync(requestId: string): {
    status: PendingRequest["status"];
    reply: string;
    task: string;
    sentAt: number;
    inFlight: boolean;
  } | null {
    const persisted = this.state.getRequest(requestId);
    if (!persisted) return null;
    const live = this.pending.get(requestId);
    const reply = live
      ? live.parts
          .map((p) => p.text ?? p.caption ?? "")
          .join("\n")
          .trim()
      : (persisted.reply ?? "");
    return {
      status: persisted.status,
      reply,
      task: persisted.task,
      sentAt: persisted.sentAt,
      inFlight: live !== undefined,
    };
  }

  /**
   * Cancel an in-flight async dispatch. Sends /reset to Claw and marks the
   * request cancelled. If the Telegram send fails (network, 5xx, etc.) we
   * enqueue the /reset on the outbound queue so it's retried until it lands.
   */
  async cancelAsync(requestId: string): Promise<boolean> {
    const resolver = this.pending.get(requestId);
    if (!resolver) {
      const persisted = this.state.getRequest(requestId);
      if (!persisted) return false;
      if (persisted.status !== "pending") return false;
      await this.markRequestStatus(requestId, "cancelled");
      this.enqueueReset(requestId);
      return true;
    }
    this.cancelResolver(resolver, new Error("Cancelled by caller"));
    this.enqueueReset(requestId);
    // Try once now for a snappy interactive feel; if it fails the queued
    // item will retry it on the next tick.
    await this.flushOutboundQueue();
    return true;
  }

  private enqueueReset(requestId: string): void {
    const item: OutboundQueueItem = {
      id: `reset-${requestId}-${Date.now()}`,
      enqueuedAt: Date.now(),
      text: `[req:${requestId}] /reset`,
      attempts: 0,
      maxAttempts: 20,
    };
    this.state.enqueueOutbound(item);
  }

  private scheduleOutboundFlush(): void {
    if (this.outboundFlushTimer) return;
    const tick = (): void => {
      this.outboundFlushTimer = setTimeout(() => {
        this.outboundFlushTimer = null;
        void this.flushOutboundQueue().finally(() => {
          if (this.unsubscribe) tick();
        });
      }, this.outboundRetryIntervalMs);
    };
    tick();
  }

  private async flushOutboundQueue(): Promise<void> {
    const items = this.state.outboundQueueSnapshot();
    for (const item of items) {
      const max = item.maxAttempts ?? 20;
      if (item.attempts >= max) {
        log.warn("dispatch.outbound_giving_up", {
          id: item.id,
          attempts: item.attempts,
          text_preview: item.text.slice(0, 80),
        });
        this.state.dequeueOutbound(item.id);
        continue;
      }
      try {
        const sent = await this.telegram.sendMessage(item.text);
        await this.audit.mirrorOutbound({
          requestId: item.id,
          text: item.text,
          messageId: sent.message_id,
        });
        this.state.dequeueOutbound(item.id);
        log.info("dispatch.outbound_flushed", {
          id: item.id,
          attempts: item.attempts + 1,
        });
      } catch (err) {
        this.state.recordOutboundAttempt(item.id);
        log.warn("dispatch.outbound_retry_failed", {
          id: item.id,
          attempts: item.attempts + 1,
          error: String(err),
        });
        // Don't try the rest right now; wait for the next tick.
        return;
      }
    }
  }

  // ----- incoming routing -----

  private async handleIncoming(msg: TelegramMessage): Promise<void> {
    const text = (msg.text ?? msg.caption ?? "").trim();
    if (!text) return;
    await this.audit.mirrorInbound({ text, messageId: msg.message_id });

    // Strip [CLAUDE-REPLY:...] echoes so Claw quoting our own answer doesn't
    // come back to us as a duplicate inbound. (Telegram doesn't echo bot
    // messages today but Claw might quote them.)
    if (/^\[CLAUDE-REPLY:[A-Za-z0-9_-]+\]/.test(text)) {
      log.debug("dispatch.skip_self_echo", { message_id: msg.message_id });
      return;
    }

    // 1) Tagged match always wins. Tagged messages mark the resolver as
    //    hard-matched and reset its quiet window.
    const tagMatch = TAG_REGEX.exec(text);
    let resolver: PendingResolver | undefined;
    let matchKind: "tagged" | "stream-continuation" | "fifo" | null = null;
    if (tagMatch) {
      resolver = this.pending.get(tagMatch[1]);
      if (resolver) matchKind = "tagged";
    }

    // 2) If no tagged match, prefer the most recently hard-matched resolver
    //    whose quiet window is still open. This handles the common case
    //    where Claw streams a long reply across several messages and only
    //    tags the first one. Without this, the second sentence races and
    //    gets attributed to whichever dispatch is oldest in FIFO.
    if (!resolver) {
      const now = Date.now();
      let best: PendingResolver | undefined;
      for (const id of this.pendingOrder) {
        const candidate = this.pending.get(id);
        if (!candidate || !candidate.hardMatched) continue;
        if (now - candidate.lastAttachedAt > this.quietWindowMs) continue;
        if (!best || candidate.lastAttachedAt > best.lastAttachedAt) best = candidate;
      }
      if (best) {
        resolver = best;
        matchKind = "stream-continuation";
      }
    }

    // 3) Final fallback: FIFO. Oldest pending, untagged, that has NOT yet
    //    been hard-matched (so we don't pull untagged streamed continuations
    //    away from an active resolver) and whose outbound predates this msg.
    if (!resolver) {
      for (const id of this.pendingOrder) {
        const candidate = this.pending.get(id);
        if (!candidate) continue;
        if (candidate.hardMatched) continue;
        if (msg.date * 1000 < candidate.sentAt - 1000) continue;
        resolver = candidate;
        matchKind = "fifo";
        break;
      }
    }

    // 4) Escalation parsing happens regardless of whether we matched a
    //    resolver, so a proactive [ASK-CLAUDE] without a tag is still
    //    captured for Claude to see via claw_check_escalations.
    let escalation = false;
    let body = text;
    if (tagMatch) {
      body = body.replace(tagMatch[0], "").trim();
    }
    if (body.startsWith(this.config.escalationMarker)) {
      escalation = true;
      body = body.slice(this.config.escalationMarker.length).trim();
      const escalationId =
        this.escalationHook?.({
          requestId: resolver?.requestId ?? "",
          message: msg,
          body,
        }) ?? null;
      log.info("dispatch.escalation_routed", {
        requestId: resolver?.requestId ?? null,
        escalationId,
      });
      if (!resolver && escalationId) {
        // Surface unattributed proactive escalations so Claude can see them
        // via claw_check_escalations. We mark them so the check tool can
        // distinguish "Claw asked a follow-up to your request" from "Claw
        // asked something on its own".
        const existing = this.state.getEscalation(escalationId);
        if (existing) {
          existing.unattributed = true;
          this.state.upsertEscalation(existing);
        }
        return;
      }
    }

    if (!resolver) {
      log.warn("dispatch.unattributed_message", {
        message_id: msg.message_id,
        text_preview: text.slice(0, 80),
        had_tag: tagMatch !== null,
      });
      return;
    }

    log.debug("dispatch.matched", {
      request_id: resolver.requestId,
      kind: matchKind,
    });

    // Tagged matches mark hard-matched immediately so the next streamed
    // continuation prefers this resolver under rule 2.
    if (matchKind === "tagged") {
      resolver.hardMatched = true;
    }

    resolver.parts.push({
      ...msg,
      text: body,
    });
    resolver.lastAttachedAt = Date.now();

    if (resolver.options.onProgress) {
      const cumulative = resolver.parts
        .map((p) => p.text ?? p.caption ?? "")
        .join("\n")
        .trim();
      try {
        await resolver.options.onProgress({
          requestId: resolver.requestId,
          text: cumulative,
          delta: body,
          messageId: msg.message_id,
          escalation,
        });
      } catch (err) {
        log.warn("dispatch.progress_callback_threw", { error: String(err) });
      }
    }

    // Escalations: keep the quiet window alive so any context Claw streams
    // alongside the marker (e.g. "[ASK-CLAUDE] should I delete /tmp?\n\n
    // here's what's there:\n- a.txt\n- b.txt") is also captured before we
    // resolve. Without this, the escalation collapsed the dispatch the
    // instant the marker landed and we lost everything after it.
    if (resolver.quietTimer) clearTimeout(resolver.quietTimer);
    resolver.quietTimer = setTimeout(() => {
      void this.finalize(resolver!, false);
    }, this.quietWindowMs);
  }

  private async finalize(resolver: PendingResolver, timedOut: boolean): Promise<void> {
    if (!this.pending.has(resolver.requestId)) return;
    if (resolver.finalized) return;
    resolver.finalized = true;
    clearTimeout(resolver.overallTimer);
    if (resolver.quietTimer) clearTimeout(resolver.quietTimer);
    this.dropResolver(resolver.requestId);

    const replyText = resolver.parts
      .map((p) => p.text ?? p.caption ?? "")
      .join("\n")
      .trim();

    const result: DispatchResult = {
      requestId: resolver.requestId,
      reply: replyText,
      escalated: resolver.escalationInfo !== undefined,
      escalationId: resolver.escalationInfo?.id,
      escalationQuestion: resolver.escalationInfo?.question,
      outboundMessageId: resolver.outboundMessageId,
      inboundMessageIds: resolver.parts.map((p) => p.message_id),
    };

    // Persist DURABLY before resolving so a caller that immediately polls
    // state.json (or another tool call that reads it) sees the reply.
    const persisted = this.state.getRequest(resolver.requestId);
    if (persisted) {
      persisted.status = timedOut && replyText.length === 0 ? "timeout" : "completed";
      persisted.reply = replyText;
      try {
        await this.state.upsertRequestDurable(persisted);
      } catch (err) {
        log.warn("dispatch.finalize_persist_failed", { error: String(err) });
      }
    }

    try {
      resolver.resolve(result);
    } catch (err) {
      log.warn("dispatch.resolve_threw", { error: String(err) });
    }
  }

  private cancelResolver(resolver: PendingResolver, err: Error): void {
    if (!this.pending.has(resolver.requestId)) return;
    if (resolver.finalized) return;
    resolver.finalized = true;
    clearTimeout(resolver.overallTimer);
    if (resolver.quietTimer) clearTimeout(resolver.quietTimer);
    this.dropResolver(resolver.requestId);
    void this.markRequestStatus(resolver.requestId, "cancelled");
    try {
      resolver.reject(err);
    } catch (innerErr) {
      log.warn("dispatch.reject_threw", { error: String(innerErr) });
    }
  }

  private dropResolver(requestId: string): void {
    this.pending.delete(requestId);
    const idx = this.pendingOrder.indexOf(requestId);
    if (idx !== -1) this.pendingOrder.splice(idx, 1);
  }

  private async markRequestStatus(
    requestId: string,
    status: PendingRequest["status"],
  ): Promise<void> {
    const persisted = this.state.getRequest(requestId);
    if (!persisted) return;
    persisted.status = status;
    try {
      await this.state.upsertRequestDurable(persisted);
    } catch (err) {
      log.warn("dispatch.markstatus_persist_failed", { error: String(err) });
    }
  }

  /**
   * Set during incoming handling so finalize can carry the escalation info
   * into the DispatchResult without re-parsing.
   */
  noteEscalation(resolverId: string, escalationId: string, question: string): void {
    const r = this.pending.get(resolverId);
    if (!r) return;
    r.escalationInfo = { id: escalationId, question };
  }
}
