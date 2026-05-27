/**
 * Read/write claude_desktop_config.json.
 *
 * Claude Desktop's manual MCP config lives at:
 *   - macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   - Windows: %APPDATA%\Claude\claude_desktop_config.json
 *
 * It uses an `mcpServers` map of name -> { command, args, env? }. We register
 * the bridge as `company-claw-bridge` pointing at the bundled .mcpb (which we
 * unpack to ~/.company-claw-bridge/bundle/), wiring the user_config values
 * into env exactly like the MCPB host would.
 *
 * Why we don't try to drive Claude Desktop's native .mcpb installer flow:
 *   Claude Desktop's "install extension" UI requires user interaction and a
 *   running Claude Desktop window; it can't be automated from outside. The
 *   manual mcpServers entry achieves the same runtime behaviour without any
 *   click-through, with the side benefit that uninstall is a single edit.
 */

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { fileExists } from "./detect";

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export const BRIDGE_SERVER_NAME = "company-claw-bridge";

/** Where we unpack the bundle for runtime use. */
export function bundleInstallDir(): string {
  return join(homedir(), ".company-claw-bridge", "bundle");
}

/**
 * Read the Claude Desktop config or return an empty default if it doesn't
 * exist yet. Preserves unknown keys so we don't trample on other settings.
 */
export async function readClaudeConfig(configPath: string): Promise<ClaudeConfig> {
  if (!(await fileExists(configPath))) return {};
  const raw = await readFile(configPath, "utf8");
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as ClaudeConfig;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed;
  } catch {
    throw new Error(
      `Existing Claude Desktop config at ${configPath} is not valid JSON. Please fix or remove it before continuing.`,
    );
  }
}

/**
 * Write the config atomically, returning the backup path when an existing
 * file was renamed out of the way before the write.
 */
export async function writeClaudeConfig(
  configPath: string,
  config: ClaudeConfig,
): Promise<{ backupPath: string | null }> {
  await mkdir(dirname(configPath), { recursive: true });
  let backupPath: string | null = null;
  if (await fileExists(configPath)) {
    backupPath = `${configPath}.bak-${Date.now()}`;
    await copyFile(configPath, backupPath);
  }
  const tmp = `${configPath}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
  await rename(tmp, configPath);
  return { backupPath };
}

/**
 * Build the env map a runtime bridge instance needs. Mirrors the mcp_config.env
 * block from manifest.json so the manual mcpServers entry is equivalent to a
 * MCPB-managed install.
 */
export function buildBridgeEnv(input: {
  token: string;
  chatId: string;
  auditChatId?: string | null;
  devMirror?: boolean;
  defaultTimeoutMs?: number;
  escalationMarker?: string;
  stateDir?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: input.token,
    CLAW_CHAT_ID: input.chatId,
  };
  if (input.auditChatId) env.AUDIT_CHAT_ID = input.auditChatId;
  if (input.devMirror !== undefined) env.DEV_MIRROR = String(input.devMirror);
  if (input.defaultTimeoutMs !== undefined) {
    env.DEFAULT_TIMEOUT_MS = String(input.defaultTimeoutMs);
  }
  if (input.escalationMarker) env.ESCALATION_MARKER = input.escalationMarker;
  if (input.stateDir) env.STATE_DIR = input.stateDir;
  return env;
}
