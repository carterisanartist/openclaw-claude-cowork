/**
 * Register the unpacked bundle as a Claude Code plugin at user scope.
 *
 * Claude Code uses a folder-based plugin model: any directory that contains
 * `.claude-plugin/plugin.json` is a plugin. Registration happens through one
 * of three mechanisms (in order of preference):
 *
 *   1. `claude plugin install <dir>` - the documented happy path. Requires
 *      the Claude Code CLI to be on PATH.
 *   2. `claude --plugin-dir <dir> ...` - works for one-off invocations but
 *      requires the user to add the flag every time, so we don't use it.
 *   3. Direct write to the user-scoped plugins config. As of 2026 this lives
 *      at:
 *        - macOS:   ~/Library/Application Support/Claude/code/plugins.json
 *        - Linux:   $XDG_CONFIG_HOME/Claude/code/plugins.json (~/.config/...)
 *        - Windows: %APPDATA%\Claude\code\plugins.json
 *
 *      The contract is JSON of shape: `{ "plugins": [{ "path": "..." }] }`.
 *      This is the fallback when the CLI isn't installed.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

import { fileExists, findOnPath } from "./detect";

export interface ClaudeCodeRegisterArgs {
  pluginDir: string;
  enable: boolean;
}

export interface ClaudeCodeRegisterResult {
  ok: boolean;
  strategy: "cli" | "manifest" | "none";
  configPath?: string;
  uninstalled?: boolean;
  output?: string;
  error?: string;
}

export async function registerClaudeCodePlugin(
  args: ClaudeCodeRegisterArgs,
): Promise<ClaudeCodeRegisterResult> {
  if (args.enable && !(await fileExists(args.pluginDir))) {
    return {
      ok: false,
      strategy: "none",
      error: `Plugin directory does not exist: ${args.pluginDir}. Install the bridge bundle first.`,
    };
  }

  // Try strategy 1: claude CLI.
  const cli = await findOnPath("claude");
  if (cli) {
    const subcommand = args.enable
      ? ["plugin", "install", args.pluginDir]
      : ["plugin", "uninstall", "company-claw-bridge"];
    const result = await runOnce(cli, subcommand, 60_000);
    if (result.exitCode === 0) {
      return {
        ok: true,
        strategy: "cli",
        uninstalled: !args.enable,
        output: (result.stdout || result.stderr).trim().slice(0, 4000),
      };
    }
    // Fall through to manifest strategy; the CLI may have changed its
    // subcommand surface (e.g. "plugin add" vs "plugin install").
  }

  // Strategy 3: direct manifest write.
  const configPath = userScopedPluginsPath();
  await mkdir(dirname(configPath), { recursive: true });
  const existing = await readPluginsConfig(configPath);
  const otherPlugins = (existing.plugins ?? []).filter(
    (p) => normalizePath(p.path) !== normalizePath(args.pluginDir),
  );
  const next = args.enable
    ? { plugins: [...otherPlugins, { path: args.pluginDir }] }
    : { plugins: otherPlugins };
  await writeJsonAtomic(configPath, next);
  return {
    ok: true,
    strategy: "manifest",
    configPath,
    uninstalled: !args.enable,
    output:
      `Registered via manifest write. Existing entries preserved. ` +
      `Restart Claude Code (or run \`claude\` in a fresh terminal) for it to pick up the change.`,
  };
}

function userScopedPluginsPath(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "code", "plugins.json");
    case "win32": {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Claude", "code", "plugins.json");
    }
    default: {
      const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
      return join(xdg, "Claude", "code", "plugins.json");
    }
  }
}

interface PluginsConfig {
  plugins?: Array<{ path: string }>;
}

async function readPluginsConfig(p: string): Promise<PluginsConfig> {
  try {
    const raw = await readFile(p, "utf8");
    const parsed = JSON.parse(raw) as PluginsConfig;
    if (typeof parsed !== "object" || parsed === null) return {};
    if (!Array.isArray(parsed.plugins)) return { plugins: [] };
    return parsed;
  } catch {
    return { plugins: [] };
  }
}

async function writeJsonAtomic(p: string, value: unknown): Promise<void> {
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, p);
}

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

function runOnce(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: platform() === "win32",
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr: stderr + "\n[timeout]", exitCode: null });
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: String(err), exitCode: null });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}
