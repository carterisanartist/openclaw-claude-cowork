import type { BridgeConfig } from "./config.js";
import { log } from "./logger.js";
import type { TelegramClient } from "./telegram.js";

/**
 * Optional development-time tee that mirrors every outbound and inbound
 * message into a designated Telegram audit chat.
 *
 * Behaviour:
 *   - Inert when config.devMirror === false OR config.auditChatId is null.
 *   - Failures are swallowed and logged; auditing never blocks the bridge.
 *   - Messages are truncated to MAX_MIRROR_BYTES to avoid Telegram's 4096-char
 *     message limit hard-failing on long Claw outputs.
 */

const MAX_MIRROR_BYTES = 3500;

export class AuditTee {
  private readonly config: BridgeConfig;
  private readonly telegram: TelegramClient;
  private readonly enabled: boolean;

  constructor(opts: { config: BridgeConfig; telegram: TelegramClient }) {
    this.config = opts.config;
    this.telegram = opts.telegram;
    this.enabled = Boolean(this.config.devMirror && this.config.auditChatId);
    if (this.enabled) {
      log.info("audit.enabled", { audit_chat_id: this.config.auditChatId });
    }
  }

  async mirrorOutbound(args: {
    requestId: string;
    text: string;
    messageId: number;
  }): Promise<void> {
    if (!this.enabled || !this.config.auditChatId) return;
    const header = `OUT req=${args.requestId} msg=${args.messageId}`;
    await this.send(`${header}\n${this.clip(args.text)}`);
  }

  async mirrorInbound(args: { text: string; messageId: number }): Promise<void> {
    if (!this.enabled || !this.config.auditChatId) return;
    const header = `IN msg=${args.messageId}`;
    await this.send(`${header}\n${this.clip(args.text)}`);
  }

  async mirrorEscalationAnswer(args: {
    escalationId: string;
    answer: string;
    messageId: number;
  }): Promise<void> {
    if (!this.enabled || !this.config.auditChatId) return;
    const header = `ANSWER esc=${args.escalationId} msg=${args.messageId}`;
    await this.send(`${header}\n${this.clip(args.answer)}`);
  }

  private async send(text: string): Promise<void> {
    if (!this.config.auditChatId) return;
    try {
      await this.telegram.sendMessage(text, {
        chatId: this.config.auditChatId,
        disableWebPagePreview: true,
      });
    } catch (err) {
      log.warn("audit.mirror_failed", { error: String(err) });
    }
  }

  private clip(text: string): string {
    if (text.length <= MAX_MIRROR_BYTES) return text;
    return `${text.slice(0, MAX_MIRROR_BYTES)}\n…[truncated]`;
  }
}
