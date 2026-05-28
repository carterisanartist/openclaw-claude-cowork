/**
 * Cross-platform detection for Claude Desktop, OpenClaw CLI, and the bundled
 * .mcpb file the installer ships with.
 */

import { spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import JSON5 from "json5";

import type { OpenClawDetect } from "../shared/ipc";

export interface ClaudeDesktopLocation {
  installed: boolean;
  configPath: string | null;
  appPath: string | null;
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where Claude Desktop stores its config and where the .app/.exe lives.
 *
 * macOS:
 *   App:    /Applications/Claude.app
 *   Config: ~/Library/Application Support/Claude/claude_desktop_config.json
 *
 * Windows:
 *   App:    %LOCALAPPDATA%\AnthropicClaude\Claude.exe (current installer
 *           location at time of writing; also %PROGRAMFILES%\Claude\Claude.exe
 *           in some packaged distributions)
 *   Config: %APPDATA%\Claude\claude_desktop_config.json
 *
 * Linux:
 *   No official Claude Desktop. Treated as not installed.
 */
export async function detectClaudeDesktop(): Promise<ClaudeDesktopLocation> {
  const home = homedir();
  if (platform() === "darwin") {
    const appPath = "/Applications/Claude.app";
    const configPath = join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    const appPresent = await isDirectory(appPath);
    // The config file may not exist until the user has launched Claude once,
    // but the parent directory often does. We'll still return the canonical
    // path so the installer can create the file.
    return {
      installed: appPresent,
      configPath,
      appPath: appPresent ? appPath : null,
    };
  }
  if (platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const appData = process.env.APPDATA;
    const candidates = [
      localAppData ? join(localAppData, "AnthropicClaude", "Claude.exe") : null,
      programFiles ? join(programFiles, "Claude", "Claude.exe") : null,
      localAppData ? join(localAppData, "Programs", "claude", "Claude.exe") : null,
    ].filter((p): p is string => p !== null);
    let appPath: string | null = null;
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        appPath = candidate;
        break;
      }
    }
    const configPath = appData
      ? join(appData, "Claude", "claude_desktop_config.json")
      : null;
    return {
      installed: appPath !== null,
      configPath,
      appPath,
    };
  }
  // Linux / other: Claude Desktop isn't officially distributed; report not installed.
  return { installed: false, configPath: null, appPath: null };
}

export interface OpenClawLocation {
  installed: boolean;
  cliPath: string | null;
  version: string | null;
  configPath: string;
  configExists: boolean;
}

/**
 * Look for the openclaw CLI on PATH. The CLI is the canonical control plane
 * for the Gateway, so if it's not installed we point the user at the install
 * instructions instead of trying to drive the Gateway directly.
 *
 * This is the lightweight detection used by places that only care about
 * cliPath / configPath (restart handler, doctor handler, etc). For prereq
 * UI use detectOpenClawFull() which also inspects the on-disk config and
 * pings the gateway.
 */
export async function detectOpenClaw(): Promise<OpenClawLocation> {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  const configExists = await fileExists(configPath);
  const which = await findOnPath("openclaw");
  if (!which) {
    return { installed: false, cliPath: null, version: null, configPath, configExists };
  }
  const version = await tryGetVersion(which);
  return { installed: true, cliPath: which, version, configPath, configExists };
}

/**
 * Inspect everything we can about an existing OpenClaw install: CLI version,
 * config file contents (providers, telegram channel), and whether the gateway
 * daemon is running. Used by the Prereqs screen and by later steps to decide
 * what's already done vs. what we still need to set up.
 *
 * All I/O is best-effort: a missing/malformed config or a non-responsive
 * gateway never throws - the result just reports `null` / `false` for that
 * dimension and we let the UI guide the user.
 */
export async function detectOpenClawFull(): Promise<OpenClawDetect> {
  const base = await detectOpenClaw();
  const result: OpenClawDetect = {
    installed: base.installed,
    cliPath: base.cliPath,
    version: base.version,
    configPath: base.configPath,
    configExists: base.configExists,
    existingProviders: [],
    defaultProvider: null,
    defaultModel: null,
    telegramConfigured: false,
    telegramBotTokenSet: false,
    telegramBotTokenPreview: null,
    telegramAllowFrom: [],
    gatewayRunning: null,
    gatewayStatusText: null,
  };

  if (base.configExists) {
    const parsed = await safeReadJson(base.configPath);
    if (parsed && typeof parsed === "object") {
      // Read OpenClaw's actual shape (docs.openclaw.ai/models):
      //   - models.providers.<id> for configured providers
      //   - agents.defaults.model.primary (or .model when scalar) for the
      //     default model ref ("provider/model")
      const models = (parsed as { models?: Record<string, unknown> }).models;
      if (models && typeof models === "object") {
        const providers = (models as { providers?: Record<string, unknown> }).providers;
        if (providers && typeof providers === "object") {
          result.existingProviders = Object.keys(providers);
        }
      }
      const agents = (parsed as { agents?: Record<string, unknown> }).agents;
      if (agents && typeof agents === "object") {
        const defaults = (agents as { defaults?: Record<string, unknown> }).defaults;
        if (defaults && typeof defaults === "object") {
          const model = (defaults as { model?: unknown }).model;
          let primaryRef: string | null = null;
          if (typeof model === "string" && model.length > 0) {
            primaryRef = model;
          } else if (model && typeof model === "object") {
            const primary = (model as { primary?: unknown }).primary;
            if (typeof primary === "string" && primary.length > 0) primaryRef = primary;
          }
          if (primaryRef) {
            const slash = primaryRef.indexOf("/");
            if (slash > 0) {
              result.defaultProvider = primaryRef.slice(0, slash);
              result.defaultModel = primaryRef.slice(slash + 1);
            } else {
              // Unprefixed model ref - rare in modern OpenClaw, but tolerate
              // it instead of dropping the user's existing setting on the
              // floor.
              result.defaultModel = primaryRef;
            }
          }
        }
      }
      const channels = (parsed as { channels?: Record<string, unknown> }).channels;
      if (channels && typeof channels === "object") {
        const tg = (channels as { telegram?: Record<string, unknown> }).telegram;
        if (tg && typeof tg === "object") {
          // OpenClaw only routes Telegram traffic when `enabled === true`,
          // so a half-written config (token present but enabled missing)
          // should NOT be reported as fully bound.
          const enabled = (tg as { enabled?: unknown }).enabled === true;
          result.telegramConfigured = enabled;
          const token = (tg as { botToken?: unknown }).botToken;
          if (typeof token === "string" && token.length > 0) {
            result.telegramBotTokenSet = true;
            result.telegramBotTokenPreview = previewToken(token);
          }
          const allow = (tg as { allowFrom?: unknown }).allowFrom;
          if (Array.isArray(allow)) {
            result.telegramAllowFrom = allow.filter(
              (v): v is string => typeof v === "string" && v.length > 0,
            );
          }
        }
      }
    }
  }

  if (base.installed && base.cliPath) {
    const status = await runGatewayStatus(base.cliPath);
    result.gatewayRunning = status.ok;
    result.gatewayStatusText = status.text;
  }

  return result;
}

async function safeReadJson(p: string): Promise<unknown> {
  try {
    const raw = await readFile(p, "utf8");
    if (raw.trim().length === 0) return null;
    // Use JSON5 because OpenClaw's config is documented as JSON5 (trailing
    // commas, comments, unquoted keys allowed). Strict JSON.parse would
    // throw on a perfectly valid user-edited config and our caller would
    // return `null` like the file didn't exist - hiding real config from
    // the prereq screen.
    return JSON5.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Telegram bot tokens are like "123456789:AAH-…". We show the numeric ID
 * (which is the bot's user id, not a secret) plus a couple of obfuscated
 * chars from the secret so the user can recognize which bot is already
 * configured without us echoing the full key.
 */
function previewToken(token: string): string {
  const colon = token.indexOf(":");
  if (colon <= 0) return token.slice(0, 4) + "…";
  const id = token.slice(0, colon);
  const tail = token.slice(colon + 1);
  const masked = tail.length <= 4 ? "…" : `${tail.slice(0, 2)}…${tail.slice(-2)}`;
  return `${id}:${masked}`;
}

async function runGatewayStatus(cliPath: string): Promise<{ ok: boolean; text: string | null }> {
  const isWin = platform() === "win32";
  const needsShell = isWin && !/\.(cmd|bat|exe|com|ps1)$/i.test(cliPath);
  return await new Promise((resolve) => {
    const proc = spawn(cliPath, ["gateway", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: needsShell,
      windowsHide: true,
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
      resolve({ ok: false, text: "(gateway status timed out)" });
    }, 6_000);
    proc.on("error", () => {
      clearTimeout(timeout);
      resolve({ ok: false, text: null });
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      const text = (stdout || stderr).trim().slice(0, 600);
      resolve({ ok: code === 0, text: text.length === 0 ? null : text });
    });
  });
}

/**
 * Locate a binary by walking PATH and, on Windows, also probing the standard
 * npm global install locations. We do that because:
 *
 *   - `npm install -g openclaw` drops `openclaw`, `openclaw.cmd`, and
 *     `openclaw.ps1` into the npm prefix directory.
 *   - That prefix (typically `%APPDATA%\npm` or `%ProgramFiles%\nodejs`) is
 *     usually but not always on PATH for processes spawned by Electron.
 *   - Even when it is on PATH, the empty-string ext probe was wrong on Windows
 *     and could match a bash-style stub that Windows cannot execute.
 *
 * For each PATH entry we try every PATHEXT extension (lowercased and uppercased)
 * AND the bare name. On Windows the `.cmd` shim is what we ultimately want for
 * spawning, so we prefer it when several candidates are present.
 */
export async function findOnPath(binaryName: string): Promise<string | null> {
  const isWin = platform() === "win32";
  const pathEnv = process.env.PATH ?? "";
  const sep = isWin ? ";" : ":";
  const rawDirs = pathEnv.split(sep).filter((d) => d.length > 0);

  // Augment search dirs on Windows with the well-known npm global locations.
  const dirs = isWin ? [...rawDirs, ...windowsNpmDirs()] : rawDirs;

  // Build the extension list. On Windows, prefer .cmd because the way Node's
  // child_process.spawn behaves means we'll launch it via cmd.exe wrapper.
  let exts: string[];
  if (isWin) {
    const fromEnv = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((e) => e.toLowerCase());
    exts = uniqueOrdered([".cmd", ".exe", ".bat", ".ps1", ...fromEnv, ""]);
  } else {
    exts = [""];
  }

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${binaryName}${ext}`);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function uniqueOrdered<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * The standard locations npm drops globally-installed bin shims on Windows.
 * Order matters - we try the per-user prefix first because that's where most
 * people end up when they install Node with default settings.
 */
function windowsNpmDirs(): string[] {
  const out: string[] = [];
  const appData = process.env.APPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (appData) out.push(join(appData, "npm"));
  if (programFiles) {
    out.push(join(programFiles, "nodejs"));
  }
  if (programFilesX86) {
    out.push(join(programFilesX86, "nodejs"));
  }
  return out;
}

async function tryGetVersion(cliPath: string): Promise<string | null> {
  const isWin = platform() === "win32";
  const needsShell = isWin && !/\.(cmd|bat|exe|com|ps1)$/i.test(cliPath);
  return await new Promise((resolve) => {
    const proc = spawn(cliPath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: needsShell,
      windowsHide: true,
    });
    let out = "";
    proc.stdout.on("data", (b) => {
      out += b.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const trimmed = out.trim();
      resolve(trimmed.length === 0 ? null : trimmed);
    });
    setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 5_000);
  });
}

/**
 * Locate the bundled .mcpb file we ship inside the installer. In dev it lives
 * at ../company-claw-bridge.mcpb relative to the installer source root; in a
 * packaged installer it's copied to process.resourcesPath via the
 * extraResources entry in package.json.
 */
export async function locateBridgeBundle(opts: {
  resourcesPath: string;
  appPath: string;
}): Promise<{ bundlePath: string | null; exists: boolean }> {
  const candidates = [
    join(opts.resourcesPath, "company-claw-bridge.mcpb"),
    join(opts.appPath, "..", "company-claw-bridge.mcpb"),
    join(opts.appPath, "..", "..", "company-claw-bridge.mcpb"),
    join(opts.appPath, "..", "..", "..", "company-claw-bridge.mcpb"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return { bundlePath: candidate, exists: true };
    }
  }
  return { bundlePath: candidates[0] ?? null, exists: false };
}

export interface NodeDetect {
  installed: boolean;
  nodePath: string | null;
  /** Full version string like "v22.4.1" when we can read it. */
  version: string | null;
  /** Parsed major version, useful for the prereqs check (Claude Desktop needs >= 20). */
  major: number | null;
}

/**
 * Find a usable `node` binary that Claude Desktop will be able to spawn. We
 * intentionally do not pick up Electron's bundled Node here - that one isn't
 * exposed to user-launched processes - we need the user's own Node install.
 *
 * We use the same PATH-walking logic as findOnPath(). When found, we exec
 * `node --version` so the UI can tell the user whether they're on a
 * supported major (>= 20) instead of just warning blindly.
 */
export async function detectNode(): Promise<NodeDetect> {
  const nodePath = await findOnPath("node");
  if (!nodePath) {
    return { installed: false, nodePath: null, version: null, major: null };
  }
  const version = await runNodeVersion(nodePath);
  let major: number | null = null;
  if (version) {
    const m = /^v?(\d+)\./.exec(version);
    if (m) major = parseInt(m[1], 10);
  }
  return { installed: true, nodePath, version, major };
}

async function runNodeVersion(nodePath: string): Promise<string | null> {
  const isWin = platform() === "win32";
  const needsShell = isWin && !/\.(cmd|bat|exe|com|ps1)$/i.test(nodePath);
  return await new Promise((resolve) => {
    const proc = spawn(nodePath, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: needsShell,
      windowsHide: true,
    });
    let out = "";
    proc.stdout.on("data", (b) => {
      out += b.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const trimmed = out.trim();
      resolve(trimmed.length === 0 ? null : trimmed);
    });
    setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 5_000);
  });
}

export function currentPlatform(): "darwin" | "win32" | "linux" {
  const p = platform();
  if (p === "darwin" || p === "win32" || p === "linux") return p;
  return "linux";
}
