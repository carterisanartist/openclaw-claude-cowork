/**
 * Read and edit ~/.openclaw/openclaw.json to ensure the Telegram channel is
 * wired up with our bot token and a numeric-ID allowlist that matches what
 * the user gave.
 *
 * IMPORTANT: For LLM provider/model configuration we deliberately DO NOT hand
 * roll config. Instead `buildOnboardArgs()` produces a `openclaw onboard
 * --non-interactive ...` command, and the caller spawns the OpenClaw CLI so
 * the upstream wizard owns provider auth, model selection, default writes,
 * and `models.json` registry merge. This avoids drift with OpenClaw's
 * actual config shape (which uses `agents.defaults.model.primary` +
 * `models.providers.<id>`, not a flat `llm.*` map).
 *
 * Telegram writes are still done in-process because:
 *   1. They are simple (single token, single allowFrom list).
 *   2. The CLI does not yet expose a non-interactive `channels add telegram`
 *      flag that takes both a token and an allowlist in one call.
 *   3. We preserve all other channel keys verbatim.
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname } from "node:path";

import type { ClawProviderId, InitOpenclawInput } from "../shared/ipc";
import { fileExists } from "./detect";

/**
 * Lightly-typed view of openclaw.json that matches the keys we actually
 * read/write. We keep `[k: string]: unknown` open everywhere so existing
 * user-authored keys round-trip untouched.
 */
export interface OpenClawConfig {
  channels?: {
    telegram?: {
      enabled?: boolean;
      botToken?: string;
      allowFrom?: string[];
      dmPolicy?: "pairing" | "allowlist" | "open" | "disabled" | string;
      groupPolicy?: "allowlist" | "open" | "disabled" | string;
      groupAllowFrom?: string[];
      groups?: Record<string, unknown>;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  /**
   * OpenClaw's actual model/provider keys. We don't write into these from the
   * installer - we leave provider auth entirely to `openclaw onboard`.
   * The shape is captured here for read-side detection only.
   */
  agents?: {
    defaults?: {
      model?:
        | string
        | {
            primary?: string;
            fallbacks?: string[];
          };
      models?: Record<string, unknown>;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  models?: {
    providers?: Record<string, unknown>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export async function readOpenClawConfig(configPath: string): Promise<OpenClawConfig> {
  if (!(await fileExists(configPath))) return {};
  const raw = await readFile(configPath, "utf8");
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as OpenClawConfig;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed;
  } catch {
    throw new Error(
      `Existing OpenClaw config at ${configPath} is not valid JSON. Please fix or remove it before continuing.`,
    );
  }
}

/**
 * Telegram user IDs are positive integers (up to 53 bits today; we accept
 * anything that parses as a base-10 integer). Group / supergroup chat IDs are
 * negative and belong under `channels.telegram.groups`, NOT in allowFrom -
 * we filter them out here so a copy-paste mistake from `getUpdates` doesn't
 * silently break group routing.
 *
 * "*" is allowed for the `dmPolicy: "open"` use case (see docs).
 */
const TELEGRAM_PREFIX = /^(?:telegram:|tg:)/i;
const NUMERIC_USER_ID = /^[1-9]\d{0,18}$/;

export interface TelegramAllowFromNormalization {
  /** Sanitized list ready to write to channels.telegram.allowFrom. */
  allowFrom: string[];
  /** Strings the user typed that we dropped (with reasons), for UI display. */
  dropped: Array<{ raw: string; reason: string }>;
  /** True iff caller passed "*". */
  hasWildcard: boolean;
}

export function normalizeTelegramAllowFrom(input: string[]): TelegramAllowFromNormalization {
  const dropped: Array<{ raw: string; reason: string }> = [];
  const out: string[] = [];
  let hasWildcard = false;

  for (const rawValue of input) {
    const trimmed = String(rawValue ?? "").trim();
    if (trimmed.length === 0) continue;
    if (trimmed === "*") {
      hasWildcard = true;
      out.push("*");
      continue;
    }
    const withoutPrefix = trimmed.replace(TELEGRAM_PREFIX, "");
    if (withoutPrefix.startsWith("@") || /[a-z]/i.test(withoutPrefix)) {
      dropped.push({
        raw: trimmed,
        reason: "@usernames are not accepted by OpenClaw - use the numeric Telegram user ID instead.",
      });
      continue;
    }
    if (withoutPrefix.startsWith("-")) {
      dropped.push({
        raw: trimmed,
        reason: "Negative IDs are Telegram group/supergroup chat IDs; put them under channels.telegram.groups, not allowFrom.",
      });
      continue;
    }
    if (!NUMERIC_USER_ID.test(withoutPrefix)) {
      dropped.push({ raw: trimmed, reason: "Not a valid numeric Telegram user ID." });
      continue;
    }
    out.push(withoutPrefix);
  }

  return {
    allowFrom: uniqueStrings(out),
    dropped,
    hasWildcard,
  };
}

export interface ApplyTelegramInput {
  token: string;
  allowFrom: string[];
  /** "pairing" (safest default) | "allowlist" | "open" | "disabled". */
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
}

export interface ApplyTelegramResult {
  next: OpenClawConfig;
  changed: boolean;
  warnings: string[];
}

/**
 * Merge our requested Telegram channel settings into existing config.
 *
 * Guarantees on the way out:
 *   - channels.telegram.enabled === true (required to activate the channel).
 *   - channels.telegram.botToken === input.token.
 *   - channels.telegram.allowFrom is a deduped union of existing + caller IDs,
 *     filtered to numeric IDs (or "*" iff dmPolicy === "open").
 *   - channels.telegram.dmPolicy is set to the requested value.
 *   - "allowlist" with an empty resulting allowFrom is REJECTED via warning
 *     (OpenClaw's config validator rejects that combo and we want the user to
 *     know before the gateway barfs at startup).
 */
export function applyTelegramChannelConfig(
  current: OpenClawConfig,
  input: ApplyTelegramInput,
): ApplyTelegramResult {
  const next: OpenClawConfig = JSON.parse(JSON.stringify(current));
  next.channels = next.channels ?? {};
  const existing: Record<string, unknown> = { ...(next.channels.telegram ?? {}) };
  const warnings: string[] = [];

  const normalized = normalizeTelegramAllowFrom(input.allowFrom);
  for (const drop of normalized.dropped) {
    warnings.push(`Dropped "${drop.raw}": ${drop.reason}`);
  }

  let changed = false;

  if (existing.enabled !== true) {
    existing.enabled = true;
    changed = true;
  }
  if (existing.botToken !== input.token) {
    existing.botToken = input.token;
    changed = true;
  }

  const existingAllow = Array.isArray(existing.allowFrom)
    ? uniqueStrings(existing.allowFrom.filter((v): v is string => typeof v === "string"))
    : [];
  // Preserve any existing wildcard / numeric IDs the user already had configured,
  // even if they're not in the new input - the installer should be additive, not
  // destructive.
  const merged = uniqueStrings([...existingAllow, ...normalized.allowFrom]);
  if (!sameArray(existingAllow, merged)) {
    existing.allowFrom = merged;
    changed = true;
  }

  const desiredPolicy = input.dmPolicy;
  if (existing.dmPolicy !== desiredPolicy) {
    existing.dmPolicy = desiredPolicy;
    changed = true;
  }

  if (desiredPolicy === "allowlist" && merged.length === 0) {
    warnings.push(
      "dmPolicy is set to \"allowlist\" but allowFrom is empty after normalization. " +
        "OpenClaw will reject this at startup. Add at least one numeric Telegram user ID, " +
        "or switch to dmPolicy: \"pairing\".",
    );
  }
  if (desiredPolicy === "open" && !merged.includes("*")) {
    warnings.push(
      "dmPolicy is set to \"open\" but allowFrom does not include \"*\". " +
        "OpenClaw requires the wildcard for fully public access.",
    );
  }

  next.channels.telegram = existing as OpenClawConfig["channels"] extends infer T
    ? T
    : never;
  return { next, changed, warnings };
}

export async function writeOpenClawConfig(
  configPath: string,
  config: OpenClawConfig,
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

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface CliRunOpts {
  timeoutMs?: number;
  /** Extra env to merge over `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export async function runOpenClawCli(
  cliPath: string,
  args: string[],
  opts: CliRunOpts = {},
): Promise<CliResult> {
  // On Windows, npm's global shim is a `.cmd` file. Node's child_process.spawn
  // will route .cmd/.bat through cmd.exe automatically when the *path itself*
  // ends in those extensions. We've already done that in findOnPath() by
  // preferring .cmd, but be defensive: if the path doesn't carry an extension
  // (extremely unusual), fall back to shell: true so cmd.exe is still in the
  // loop. We never interpolate user-controlled strings into a shell-on-true
  // call - args are always passed via spawn's args[] which it quotes.
  const isWin = platform() === "win32";
  const needsShell = isWin && !/\.(cmd|bat|exe|com|ps1)$/i.test(cliPath);
  return await new Promise((resolve) => {
    const proc = spawn(cliPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: needsShell,
      windowsHide: true,
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    proc.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
    }, opts.timeoutMs ?? 30_000);
    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr: `${stderr}\n[spawn error] ${String(err)}`.trim(),
        exitCode: null,
        signal: null,
      });
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code, signal });
    });
  });
}

/**
 * Build the argv we feed to `openclaw onboard --non-interactive ...` for a
 * given provider selection. Returns both the CLI args and the env we want to
 * inject (so secrets never appear on the command line where they'd hit
 * Windows command-line logging, parent process listings, or shell history).
 *
 * Mapping rules:
 *   - "anthropic-api-key"  -> --auth-choice anthropic-api-key ; key via ANTHROPIC_API_KEY
 *   - "openai-api-key"     -> --auth-choice openai-api-key    ; key via OPENAI_API_KEY
 *   - "openai-codex-oauth" -> --auth-choice openai-codex-oauth (interactive browser; we can't fully
 *                             automate it but onboarding will print a URL we surface)
 *   - "google-api-key"     -> --auth-choice google-api-key    ; key via GEMINI_API_KEY
 *   - "ollama"             -> --auth-choice ollama --custom-base-url <baseUrl> --custom-model-id <model>
 *   - "moonshot"           -> --auth-choice moonshot-api-key  ; key via MOONSHOT_API_KEY
 *   - "zai-api-key"        -> --auth-choice zai-api-key       ; --zai-api-key flag
 *   - "custom-api-key"     -> --auth-choice custom-api-key --custom-base-url ... --custom-model-id ...
 *                             --custom-api-key via CUSTOM_API_KEY env
 */
export interface OnboardArgs {
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function buildOnboardArgs(input: InitOpenclawInput): OnboardArgs {
  const args: string[] = ["onboard", "--non-interactive", "--accept-risk"];
  const env: NodeJS.ProcessEnv = {};

  const setModel = (modelRef: string) => {
    // Onboarding writes the provider's default model itself in most paths;
    // we re-assert it via the model flag pairs OpenClaw documents per
    // provider. The safest cross-provider path is to let onboarding pick
    // the default and then run `openclaw models set <ref>` afterwards (the
    // caller does this).
    void modelRef;
  };

  switch (input.provider) {
    case "anthropic-api-key": {
      args.push("--auth-choice", "anthropic-api-key");
      if (input.apiKey) env.ANTHROPIC_API_KEY = input.apiKey;
      setModel(input.model);
      break;
    }
    case "openai-api-key": {
      args.push("--auth-choice", "openai-api-key");
      if (input.apiKey) env.OPENAI_API_KEY = input.apiKey;
      setModel(input.model);
      break;
    }
    case "openai-codex-oauth": {
      // OAuth flow cannot be fully automated; onboarding will print a
      // device code / URL for the user. We still launch it so the user can
      // complete the pairing inside their browser, then return.
      args.push("--auth-choice", "openai-codex-oauth");
      setModel(input.model);
      break;
    }
    case "google-api-key": {
      args.push("--auth-choice", "google-api-key");
      if (input.apiKey) env.GEMINI_API_KEY = input.apiKey;
      setModel(input.model);
      break;
    }
    case "ollama": {
      args.push("--auth-choice", "ollama");
      const baseUrl = (input.baseUrl ?? "").trim() || "http://127.0.0.1:11434";
      args.push("--custom-base-url", baseUrl);
      const localId = stripProviderPrefix(input.model);
      if (localId.length > 0) args.push("--custom-model-id", localId);
      break;
    }
    case "moonshot": {
      args.push("--auth-choice", "moonshot-api-key");
      if (input.apiKey) env.MOONSHOT_API_KEY = input.apiKey;
      setModel(input.model);
      break;
    }
    case "zai-api-key": {
      args.push("--auth-choice", "zai-api-key");
      if (input.apiKey) {
        // ZAI flow accepts the key via flag OR env; use the flag form
        // OpenClaw documents.
        args.push("--zai-api-key", input.apiKey);
      }
      setModel(input.model);
      break;
    }
    case "custom-api-key": {
      args.push("--auth-choice", "custom-api-key");
      const baseUrl = (input.baseUrl ?? "").trim();
      if (baseUrl.length > 0) args.push("--custom-base-url", baseUrl);
      const localId = stripProviderPrefix(input.model);
      if (localId.length > 0) args.push("--custom-model-id", localId);
      if (input.apiKey) env.CUSTOM_API_KEY = input.apiKey;
      args.push("--custom-compatibility", input.customCompatibility ?? "openai");
      break;
    }
    default: {
      const exhaustive: never = input.provider;
      void exhaustive;
      throw new Error(`Unsupported provider: ${String(input.provider)}`);
    }
  }

  // Skip the bootstrap ritual when we're just wiring a model - it's noisy and
  // not needed for the installer's "give Claw a brain" step. Users who want
  // bootstrap files can re-run `openclaw onboard` themselves.
  args.push("--skip-bootstrap");
  // Skip the health probe so the install step is fast; we run it separately
  // via `openclaw status --deep` afterwards.
  args.push("--skip-health");

  return { args, env };
}

/**
 * Returns the model id without its provider prefix - e.g.
 * "ollama/qwen3.5:9b" -> "qwen3.5:9b". OpenClaw's `--custom-model-id` flag
 * does not want a prefix.
 */
export function stripProviderPrefix(modelRef: string): string {
  const idx = modelRef.indexOf("/");
  if (idx === -1) return modelRef;
  return modelRef.slice(idx + 1);
}

/**
 * Resolve a provider id back to the actual key OpenClaw uses in
 * `models.providers` (for our own detection logic). Most are 1:1 with the
 * suffix-stripped auth-choice; "openai-codex-oauth" maps to "openai-codex".
 */
export function providerIdToConfigKey(provider: ClawProviderId): string {
  switch (provider) {
    case "anthropic-api-key":
      return "anthropic";
    case "openai-api-key":
      return "openai";
    case "openai-codex-oauth":
      return "openai-codex";
    case "google-api-key":
      return "google";
    case "ollama":
      return "ollama";
    case "moonshot":
      return "moonshot";
    case "zai-api-key":
      return "zai";
    case "custom-api-key":
      return "custom";
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))).sort();
}

function sameArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
