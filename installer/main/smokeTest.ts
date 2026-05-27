/**
 * End-to-end smoke test from the installer's perspective.
 *
 * 1. Send a tagged probe to the configured Claw chat.
 * 2. Long-poll for a reply that arrives from anyone other than ourselves
 *    after the send. Any non-self reply is considered success at this stage
 *    of installation, because Claw might respond with a /help-style nudge if
 *    it hasn't fully digested the binding yet.
 * 3. Measure the round-trip time and surface up to 500 chars of the reply.
 *
 * We deliberately do not try to interpret Claw's reply contents. The point is
 * to confirm the plumbing works; semantic correctness is something the user
 * verifies in Claude Desktop afterward.
 */

import { randomUUID } from "node:crypto";

import {
  type TelegramBotInfo,
  type TelegramMessage,
  getMe,
  pollForMatching,
  sendMessage,
} from "./telegram";

const PROBE_TIMEOUT_MS = 45_000;

export interface SmokeOutcome {
  ok: boolean;
  roundTripMs?: number;
  reply?: string;
  noReply?: boolean;
  error?: string;
}

export async function smokeTest(args: { token: string; chatId: string }): Promise<SmokeOutcome> {
  let me: TelegramBotInfo;
  try {
    me = await getMe(args.token);
  } catch (err) {
    return { ok: false, error: `Token check failed: ${String(err)}` };
  }
  // Use OpenClaw's `/ping` chat command. Three reasons:
  //   - It's a fixed, predictable command name, so the response is "pong"
  //     and never gets aliased to a random skill invocation. The earlier
  //     "please reply with /status or 'pong'" version was a natural-language
  //     instruction Claw was free to interpret - and sometimes did, e.g.
  //     by actually running /status and posting a multi-page health report
  //     into the user's chat.
  //   - It bypasses any "approval required" prompts most providers attach
  //     to model calls (no LLM tokens are spent), so the smoke test works
  //     even on a brand new install with strict provider quotas.
  //   - We tag it with [req:...] so anyone tailing the chat understands
  //     this is an automated probe and not human traffic.
  const probeId = `setup-${randomUUID().slice(0, 6)}`;
  const probeText = `[req:${probeId}] /ping`;
  const sentAt = Date.now();

  let sentMessageId: number;
  try {
    const sent = await sendMessage(args.token, args.chatId, probeText);
    sentMessageId = sent.message_id;
  } catch (err) {
    return { ok: false, error: `Sending probe failed: ${String(err)}` };
  }

  const predicate = (msg: TelegramMessage): boolean => {
    if (String(msg.chat.id) !== String(args.chatId)) return false;
    if (msg.message_id === sentMessageId) return false;
    if (msg.from?.id === me.id) return false;
    // We require a date strictly after our send to avoid matching the user's
    // earlier /start ping.
    if (msg.date * 1000 < sentAt) return false;
    return true;
  };

  try {
    const match = await pollForMatching(args.token, predicate, {
      totalTimeoutMs: PROBE_TIMEOUT_MS,
    });
    if (!match) {
      return { ok: false, noReply: true };
    }
    const reply = (match.text ?? match.caption ?? "").slice(0, 500);
    return {
      ok: true,
      roundTripMs: Date.now() - sentAt,
      reply,
    };
  } catch (err) {
    return { ok: false, error: `Polling for reply failed: ${String(err)}` };
  }
}
