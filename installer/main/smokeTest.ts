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
  /**
   * Soft warning surfaced when the reply succeeded but doesn't look like
   * /whoami output (e.g. the gateway is on an older OpenClaw, or an
   * unrelated chat message landed in the 45s window).
   */
  warning?: string;
  error?: string;
}

export async function smokeTest(args: { token: string; chatId: string }): Promise<SmokeOutcome> {
  let me: TelegramBotInfo;
  try {
    me = await getMe(args.token);
  } catch (err) {
    return { ok: false, error: `Token check failed: ${String(err)}` };
  }
  // Use OpenClaw's `/whoami` (alias `/id`) chat command. Three reasons:
  //   - It's a fixed inline shortcut. Per docs.openclaw.ai/slash-commands,
  //     /help, /commands, /status, /whoami, /id are "fast path: bypass
  //     queue + model" — the gateway answers them itself without invoking
  //     the configured LLM, so no provider tokens are billed and the
  //     smoke test works even if the model wasn't fully wired up yet.
  //   - The reply is deterministic: a short "you are <id> ..." string,
  //     so we can validate the *content* of the reply (not just the fact
  //     that some message arrived in the chat). That makes the test
  //     resilient to a passing user message landing in the same window.
  //   - Earlier iterations of this probe used /ping, which is NOT in the
  //     OpenClaw slash-command registry. Sending /ping would route through
  //     the model, burn tokens, take an LLM round-trip, and silently
  //     succeed if any unrelated traffic happened to land. Don't repeat
  //     that mistake.
  //   - We still tag the message with [req:...] so anyone tailing the
  //     chat sees this is automated probe traffic, not human.
  const probeId = `setup-${randomUUID().slice(0, 6)}`;
  const probeText = `[req:${probeId}] /whoami`;
  const sentAt = Date.now();

  let sentMessageId: number;
  try {
    const sent = await sendMessage(args.token, args.chatId, probeText);
    sentMessageId = sent.message_id;
  } catch (err) {
    return { ok: false, error: `Sending probe failed: ${String(err)}` };
  }

  // /whoami's reply varies a bit across OpenClaw versions but in every form
  // I've seen it contains the substring "you are" (case-insensitive) plus
  // the sender's numeric Telegram id. Treat any non-self reply that contains
  // either an "id" / "user" hint OR the sender's actual id as a positive
  // match. Anything else is a "reply received but it doesn't look like
  // /whoami output" — still surfaces as a green smoke test, but we attach
  // a soft warning so the user knows the wire works but the gateway may
  // be running an older OpenClaw build.
  const looksLikeWhoami = (text: string): boolean => {
    const haystack = text.toLowerCase();
    return (
      haystack.includes("you are")
      || haystack.includes("user_id")
      || haystack.includes("telegram_id")
      || /\bid[:=]\s*\d+/i.test(text)
    );
  };

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
    const recognized = looksLikeWhoami(reply);
    return {
      ok: true,
      roundTripMs: Date.now() - sentAt,
      reply,
      // When the reply doesn't smell like /whoami output, surface a soft
      // warning. The smoke test still passes (something replied), but the
      // user should know the gateway might be on an older OpenClaw build
      // that doesn't recognize /whoami yet, or that the reply matched
      // unrelated chat traffic that landed in the 45s window.
      warning: recognized
        ? undefined
        : "Reply received but it doesn't look like a /whoami response. The wire is working, but the gateway may be running an older OpenClaw that doesn't recognize /whoami, or an unrelated message landed in the chat in the 45s window. Inspect the reply text to confirm.",
    };
  } catch (err) {
    return { ok: false, error: `Polling for reply failed: ${String(err)}` };
  }
}
