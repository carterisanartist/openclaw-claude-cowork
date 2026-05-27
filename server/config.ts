import { homedir } from "node:os";
import { resolve } from "node:path";

export interface BridgeConfig {
  telegramBotToken: string;
  clawChatId: string;
  auditChatId: string | null;
  devMirror: boolean;
  defaultTimeoutMs: number;
  escalationMarker: string;
  stateDir: string;
  /**
   * When true, round-trip a /status through Claw at startup so the MCP host
   * log gets a clear "Claw is reachable" or "Claw isn't reachable" verdict
   * before any tool call. Defaults to false because it adds ~1s of startup
   * latency on a healthy setup and the failure mode is recoverable.
   */
  startupHealthCheck: boolean;
}

function readString(key: string, fallback?: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(
      `Missing required user_config value '${key}'. Configure it in Claude Desktop > Settings > Extensions > Company Claw Bridge.`,
    );
  }
  return raw;
}

function readOptionalString(key: string): string | null {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return null;
  return raw;
}

function readBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const lower = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  return fallback;
}

function readNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function loadConfig(): BridgeConfig {
  const stateDirRaw = readString("STATE_DIR", `${homedir()}/.company-claw-bridge`);
  return {
    telegramBotToken: readString("TELEGRAM_BOT_TOKEN"),
    clawChatId: readString("CLAW_CHAT_ID"),
    auditChatId: readOptionalString("AUDIT_CHAT_ID"),
    devMirror: readBoolean("DEV_MIRROR", false),
    defaultTimeoutMs: readNumber("DEFAULT_TIMEOUT_MS", 180_000, 5_000, 3_600_000),
    escalationMarker: readString("ESCALATION_MARKER", "[ASK-CLAUDE]"),
    stateDir: resolve(stateDirRaw),
    startupHealthCheck: readBoolean("STARTUP_HEALTH_CHECK", false),
  };
}
