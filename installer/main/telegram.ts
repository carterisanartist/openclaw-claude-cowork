/**
 * Minimal Telegram Bot API client used by the installer.
 *
 * We intentionally do NOT reuse the runtime bridge's client. The installer
 * runs only briefly and only needs three calls (getMe, getUpdates,
 * sendMessage), so a stripped-down version keeps the installer's bundle
 * trivial.
 */

import { setTimeout as delay } from "node:timers/promises";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: {
    id: number;
    type: string;
    title?: string;
    username?: string;
    first_name?: string;
  };
  from?: {
    id: number;
    is_bot: boolean;
    username?: string;
    first_name?: string;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramApiError extends Error {
  code: number;
  constructor(method: string, code: number, description: string) {
    super(`Telegram ${method} failed: ${code} ${description}`);
    this.code = code;
  }
}

export async function callTelegram<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal; timeoutMs?: number; maxAttempts?: number } = {},
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const maxAttempts = opts.maxAttempts ?? 3;
  const requestTimeoutMs = opts.timeoutMs ?? 30_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timeoutController = new AbortController();
    const onAbort = () => timeoutController.abort();
    if (opts.signal) {
      if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => timeoutController.abort(), requestTimeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: timeoutController.signal,
      });
      let payload: TelegramApiResponse<T>;
      try {
        payload = (await res.json()) as TelegramApiResponse<T>;
      } catch {
        throw new Error(`Telegram ${method} returned non-JSON (status ${res.status})`);
      }
      if (payload.ok && payload.result !== undefined) return payload.result;

      const code = payload.error_code ?? res.status;
      const desc = payload.description ?? res.statusText;
      if (code === 429 && attempt < maxAttempts) {
        const retryAfter = payload.parameters?.retry_after ?? 1;
        await delay(retryAfter * 1000);
        continue;
      }
      if (code >= 500 && code < 600 && attempt < maxAttempts) {
        await delay(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new TelegramApiError(method, code, desc);
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      if ((err as Error).name === "AbortError" && opts.signal?.aborted) throw err;
      await delay(500 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    }
  }
  throw new Error(`Telegram ${method} exhausted retries`);
}

export async function getMe(token: string): Promise<TelegramBotInfo> {
  return callTelegram<TelegramBotInfo>(token, "getMe", {}, { timeoutMs: 10_000 });
}

export async function sendMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<TelegramMessage> {
  return callTelegram<TelegramMessage>(
    token,
    "sendMessage",
    { chat_id: chatId, text },
    { timeoutMs: 15_000 },
  );
}

/**
 * Pull recent updates without committing an offset. We use offset=0 so the
 * installer doesn't accidentally interfere with the runtime bridge's update
 * watermark - Telegram returns the same updates again next time.
 */
export async function recentUpdates(token: string): Promise<TelegramUpdate[]> {
  return callTelegram<TelegramUpdate[]>(
    token,
    "getUpdates",
    {
      offset: 0,
      timeout: 0,
      limit: 100,
      allowed_updates: ["message", "edited_message"],
    },
    { timeoutMs: 10_000 },
  );
}

/**
 * Long-poll for an inbound message that matches a predicate. Used for the
 * smoke test where we need to see our own outbound bounce back through
 * Claw's reply.
 */
export async function pollForMatching(
  token: string,
  predicate: (msg: TelegramMessage) => boolean,
  opts: { totalTimeoutMs: number; pollTimeoutSec?: number; signal?: AbortSignal },
): Promise<TelegramMessage | null> {
  const deadline = Date.now() + opts.totalTimeoutMs;
  let offset = 0;
  // Bootstrap offset to the latest seen update so we don't replay old messages.
  const seed = await recentUpdates(token);
  if (seed.length > 0) {
    offset = seed[seed.length - 1].update_id + 1;
  }

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return null;
    const remaining = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
    const pollSec = Math.min(opts.pollTimeoutSec ?? 25, remaining);
    const updates = await callTelegram<TelegramUpdate[]>(
      token,
      "getUpdates",
      {
        offset,
        timeout: pollSec,
        limit: 50,
        allowed_updates: ["message", "edited_message"],
      },
      { timeoutMs: (pollSec + 10) * 1000, signal: opts.signal },
    );
    for (const upd of updates) {
      offset = upd.update_id + 1;
      const msg = upd.message ?? upd.edited_message;
      if (msg && predicate(msg)) return msg;
    }
  }
  return null;
}
