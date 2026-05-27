import { log } from "./logger.js";
import type { StateStore } from "./state.js";

/**
 * Thin Telegram Bot API client.
 *
 * Uses the global fetch shipped with Node 20+. Designed for the bridge's needs
 * only: send a message, long-poll for new messages, and edit a message in
 * place. No webhook server, no third-party SDK.
 *
 * Long-poll loop is reference-counted: it runs while at least one consumer is
 * subscribed via subscribe() and stops when the last one unsubscribes. This
 * matters for stdio MCP servers where the host can keep us alive between
 * tool calls.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number | string; type: string; title?: string };
  from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
  reply_to_message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface SendMessageOptions {
  /** parse_mode passed to Telegram. Default: undefined (plain text). */
  parseMode?: "MarkdownV2" | "HTML";
  /** Disable link previews on the sent message. */
  disableWebPagePreview?: boolean;
  /** Reply to a specific message in the chat. */
  replyToMessageId?: number;
}

export type MessageListener = (msg: TelegramMessage) => void | Promise<void>;

export class TelegramClient {
  private readonly token: string;
  private readonly state: StateStore;
  private readonly chatId: string;

  private listeners = new Set<MessageListener>();
  private pollLoop: Promise<void> | null = null;
  private stopRequested = false;
  private inFlightController: AbortController | null = null;

  constructor(opts: { token: string; state: StateStore; chatId: string }) {
    this.token = opts.token;
    this.state = opts.state;
    this.chatId = opts.chatId;
  }

  /**
   * Send a message to a chat (defaults to the configured Claw chat).
   */
  async sendMessage(
    text: string,
    opts: SendMessageOptions & { chatId?: string } = {},
  ): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: opts.chatId ?? this.chatId,
      text,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.disableWebPagePreview) body.disable_web_page_preview = true;
    if (opts.replyToMessageId) body.reply_to_message_id = opts.replyToMessageId;

    const result = await this.call<TelegramMessage>("sendMessage", body);
    log.debug("telegram.send", {
      chat_id: body.chat_id,
      message_id: result.message_id,
      bytes: text.length,
    });
    return result;
  }

  /**
   * Edit an existing message in place. Useful for live "thinking..." style
   * status updates we never use here, but kept available for callers.
   */
  async editMessageText(
    messageId: number,
    text: string,
    opts: SendMessageOptions & { chatId?: string } = {},
  ): Promise<TelegramMessage | boolean> {
    const body: Record<string, unknown> = {
      chat_id: opts.chatId ?? this.chatId,
      message_id: messageId,
      text,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.disableWebPagePreview) body.disable_web_page_preview = true;
    return await this.call<TelegramMessage | boolean>("editMessageText", body);
  }

  /**
   * Verify the bot token by calling getMe. Throws on auth failure.
   * Returns the bot's user info.
   */
  async getMe(): Promise<{ id: number; is_bot: boolean; username?: string; first_name?: string }> {
    return await this.call("getMe", {});
  }

  subscribe(fn: MessageListener): () => void {
    this.listeners.add(fn);
    this.ensurePolling();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  }

  private ensurePolling(): void {
    if (this.pollLoop) return;
    this.stopRequested = false;
    this.pollLoop = this.runPollLoop().catch((err) => {
      log.error("telegram.poll_loop_crashed", { error: String(err) });
    });
  }

  private stop(): void {
    this.stopRequested = true;
    if (this.inFlightController) {
      this.inFlightController.abort();
    }
  }

  /**
   * Wait for the poll loop to exit. Called on shutdown.
   */
  async drain(): Promise<void> {
    this.stop();
    if (this.pollLoop) {
      await this.pollLoop;
      this.pollLoop = null;
    }
  }

  private async runPollLoop(): Promise<void> {
    log.info("telegram.poll_start", { offset: this.state.state.lastUpdateId + 1 });
    let consecutiveErrors = 0;

    while (!this.stopRequested) {
      const offset = this.state.state.lastUpdateId + 1;

      try {
        const updates = await this.getUpdates({ offset, timeout: 50 });
        consecutiveErrors = 0;

        for (const upd of updates) {
          const msg =
            upd.message ?? upd.edited_message ?? upd.channel_post ?? upd.edited_channel_post;
          let deliveredCleanly = true;
          if (msg) {
            // Filter: only deliver messages from the configured Claw chat.
            if (String(msg.chat.id) !== String(this.chatId)) {
              log.debug("telegram.skip_other_chat", {
                chat_id: msg.chat.id,
                expected: this.chatId,
              });
            } else {
              for (const listener of this.listeners) {
                try {
                  await listener(msg);
                } catch (err) {
                  // If a listener throws we still want to advance the
                  // watermark - otherwise the same poisoned update keeps
                  // re-arriving every getUpdates cycle. But we log loudly
                  // so operators see the bug.
                  deliveredCleanly = false;
                  log.warn("telegram.listener_threw", {
                    error: String(err),
                    update_id: upd.update_id,
                  });
                }
              }
            }
          }
          // Advance the watermark *after* listener delivery so a hard crash
          // (process kill, OOM) replays the in-flight update next start. The
          // listener side is idempotent: tagged matching means a replayed
          // message attaches to the same resolver if it still exists, and
          // the state store dedupes by message_id when persisting parts.
          this.state.setLastUpdateId(upd.update_id);
          if (!deliveredCleanly) {
            log.warn("telegram.update_processed_with_errors", {
              update_id: upd.update_id,
            });
          }
        }
      } catch (err) {
        if (this.stopRequested) break;
        consecutiveErrors += 1;
        const backoffMs = Math.min(30_000, 500 * 2 ** Math.min(consecutiveErrors, 6));
        log.warn("telegram.poll_error_backing_off", {
          error: String(err),
          consecutive_errors: consecutiveErrors,
          backoff_ms: backoffMs,
        });
        await sleep(backoffMs);
      }
    }
    log.info("telegram.poll_stop");
  }

  private async getUpdates(opts: {
    offset: number;
    timeout: number;
  }): Promise<TelegramUpdate[]> {
    const controller = new AbortController();
    this.inFlightController = controller;
    try {
      // The HTTP request waits up to `timeout` seconds for new updates. We add
      // a small buffer on top of that for the network so we don't abort the
      // valid long-poll early.
      const result = await this.call<TelegramUpdate[]>(
        "getUpdates",
        {
          offset: opts.offset,
          timeout: opts.timeout,
          allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post"],
        },
        {
          signal: controller.signal,
          requestTimeoutMs: (opts.timeout + 10) * 1000,
        },
      );
      return result;
    } finally {
      if (this.inFlightController === controller) this.inFlightController = null;
    }
  }

  /**
   * Low-level API caller with retry on 429 (Too Many Requests) and 5xx, plus
   * basic transport-error retry.
   */
  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    opts: { signal?: AbortSignal; requestTimeoutMs?: number; maxAttempts?: number } = {},
  ): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? 4;
    const url = `${TELEGRAM_API_BASE}/bot${this.token}/${method}`;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timeoutMs = opts.requestTimeoutMs ?? 30_000;
      const timeoutController = new AbortController();
      const onAbort = () => timeoutController.abort();
      if (opts.signal) {
        if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

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

        if (payload.ok && payload.result !== undefined) {
          return payload.result;
        }

        const code = payload.error_code ?? res.status;
        const desc = payload.description ?? res.statusText;

        // 429: respect retry_after
        if (code === 429 && attempt < maxAttempts) {
          const retryAfterSec = payload.parameters?.retry_after ?? 1;
          log.warn("telegram.rate_limited", { method, retry_after_sec: retryAfterSec });
          await sleep(retryAfterSec * 1000);
          continue;
        }

        // 5xx: backoff and retry
        if (code >= 500 && code < 600 && attempt < maxAttempts) {
          const backoff = 500 * 2 ** (attempt - 1);
          log.warn("telegram.server_error_retrying", { method, code, backoff_ms: backoff });
          await sleep(backoff);
          continue;
        }

        throw new Error(`Telegram ${method} failed: ${code} ${desc}`);
      } catch (err) {
        const isAbort = (err as Error)?.name === "AbortError";
        if (isAbort && opts.signal?.aborted) {
          throw err;
        }
        if (attempt >= maxAttempts) throw err;
        const backoff = 500 * 2 ** (attempt - 1);
        log.warn("telegram.transport_error_retrying", {
          method,
          attempt,
          backoff_ms: backoff,
          error: String(err),
        });
        await sleep(backoff);
      } finally {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      }
    }
    throw new Error(`Telegram ${method} exhausted retries`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
