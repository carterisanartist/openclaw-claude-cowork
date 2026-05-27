import { randomUUID } from "node:crypto";
import type { AuditTee } from "./audit.js";
import type { Dispatcher } from "./dispatcher.js";
import { log } from "./logger.js";
import type { StateStore, PendingEscalation } from "./state.js";
import type { TelegramClient, TelegramMessage } from "./telegram.js";

/**
 * Tracks escalations Claw raises with the configured marker (default
 * [ASK-CLAUDE]) and lets Claude answer them via claw_answer_escalation.
 *
 * Wiring:
 *   - The dispatcher's escalation hook calls into recordEscalation when an
 *     inbound message body starts with the marker. We mint a fresh
 *     escalation_id, persist a PendingEscalation, and return the id so the
 *     dispatcher can attach it to its DispatchResult.
 *   - claw_answer_escalation posts "[CLAUDE-REPLY:<id>] <answer>" back into
 *     the Telegram chat so Claw can correlate Claude's response with its
 *     original question. We do NOT use a [req:] tag here because the
 *     conversation belongs to the original request, which Claw already knows
 *     about; the reply is a follow-up message in the same thread.
 */

export class EscalationManager {
  private readonly state: StateStore;
  private readonly telegram: TelegramClient;
  private readonly dispatcher: Dispatcher;
  private readonly audit: AuditTee;

  constructor(opts: {
    state: StateStore;
    telegram: TelegramClient;
    dispatcher: Dispatcher;
    audit: AuditTee;
  }) {
    this.state = opts.state;
    this.telegram = opts.telegram;
    this.dispatcher = opts.dispatcher;
    this.audit = opts.audit;
  }

  install(): void {
    this.dispatcher.setEscalationHook(({ requestId, message, body }) => {
      return this.recordEscalation({ requestId, message, body });
    });
  }

  private recordEscalation(args: {
    requestId: string;
    message: TelegramMessage;
    body: string;
  }): string {
    const id = randomUUID().replaceAll("-", "").slice(0, 10);
    const escalation: PendingEscalation = {
      escalationId: id,
      requestId: args.requestId,
      question: args.body,
      raisedAt: Date.now(),
      status: "pending",
    };
    this.state.upsertEscalation(escalation);
    this.dispatcher.noteEscalation(args.requestId, id, args.body);
    log.info("escalation.recorded", {
      escalation_id: id,
      request_id: args.requestId,
      from_message_id: args.message.message_id,
    });
    return id;
  }

  list(): PendingEscalation[] {
    return this.state
      .pendingEscalations()
      .sort((a, b) => a.raisedAt - b.raisedAt);
  }

  get(id: string): PendingEscalation | undefined {
    return this.state.getEscalation(id);
  }

  async answer(escalationId: string, answer: string): Promise<{
    escalationId: string;
    posted: boolean;
    messageId: number;
  }> {
    const esc = this.state.getEscalation(escalationId);
    if (!esc) {
      throw new Error(`Unknown escalation_id ${escalationId}`);
    }
    if (esc.status === "answered") {
      throw new Error(`Escalation ${escalationId} has already been answered`);
    }
    const payload = `[CLAUDE-REPLY:${escalationId}] ${answer}`;
    const sent = await this.telegram.sendMessage(payload);
    await this.audit.mirrorEscalationAnswer({
      escalationId,
      answer: payload,
      messageId: sent.message_id,
    });

    esc.status = "answered";
    esc.answer = answer;
    esc.answeredAt = Date.now();
    this.state.upsertEscalation(esc);

    log.info("escalation.answered", {
      escalation_id: escalationId,
      reply_message_id: sent.message_id,
    });

    return {
      escalationId,
      posted: true,
      messageId: sent.message_id,
    };
  }
}
