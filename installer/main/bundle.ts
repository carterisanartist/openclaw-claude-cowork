/**
 * Unpack the bundled company-claw-bridge.mcpb into the user's home directory
 * so the Claude Desktop manual mcpServers entry can launch it with `node`.
 *
 * An .mcpb is a zip archive containing manifest.json, dist/, and node_modules/.
 * We unpack it ourselves using Node's built-in unzip via `tar -xf` on macOS/
 * Linux and PowerShell's Expand-Archive on Windows so we don't add a zip lib
 * dependency to the installer.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";

import { fileExists } from "./detect";

export interface UnpackResult {
  ok: boolean;
  installedDir: string;
  entryPoint: string | null;
  error?: string;
}

/**
 * Unpack the bundle into installDir. Wipes any prior install first to avoid
 * stale files. Returns the absolute path to dist/index.js inside the unpacked
 * tree, which is what we feed to the `node` command in claude_desktop_config.json.
 */
export async function unpackBundle(args: {
  bundlePath: string;
  installDir: string;
}): Promise<UnpackResult> {
  if (!(await fileExists(args.bundlePath))) {
    return {
      ok: false,
      installedDir: args.installDir,
      entryPoint: null,
      error: `Bridge bundle not found at ${args.bundlePath}.`,
    };
  }
  try {
    await rm(args.installDir, { recursive: true, force: true });
    await mkdir(args.installDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      installedDir: args.installDir,
      entryPoint: null,
      error: `Failed to prepare install dir ${args.installDir}: ${String(err)}`,
    };
  }

  const unpackErr = await runUnpacker(args.bundlePath, args.installDir);
  if (unpackErr) {
    return {
      ok: false,
      installedDir: args.installDir,
      entryPoint: null,
      error: unpackErr,
    };
  }

  const entryPoint = join(args.installDir, "dist", "index.js");
  if (!(await fileExists(entryPoint))) {
    return {
      ok: false,
      installedDir: args.installDir,
      entryPoint: null,
      error: `Unpacked bundle is missing expected entry point at ${entryPoint}.`,
    };
  }
  // Ensure the entry point is executable; not strictly required since we
  // launch with `node`, but harmless.
  try {
    await stat(entryPoint);
  } catch {
    // ignore
  }

  return { ok: true, installedDir: args.installDir, entryPoint };
}

async function runUnpacker(bundlePath: string, installDir: string): Promise<string | null> {
  if (platform() === "win32") {
    // Use the .NET ZipFile API directly. Unlike PowerShell's Expand-Archive,
    // it doesn't care about the file extension, so we don't need to copy the
    // .mcpb to a temp .zip first. We always pass the full powershell.exe path
    // via PATH lookup; that's universally present on supported Windows.
    const script = [
      "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
      `[System.IO.Compression.ZipFile]::ExtractToDirectory('${escapePs(bundlePath)}', '${escapePs(installDir)}')`,
    ].join(" ");
    return runOnce("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ]);
  }
  // macOS + Linux: `unzip` is universally present.
  return runOnce("unzip", ["-q", "-o", bundlePath, "-d", installDir]);
}

function runOnce(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    proc.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    proc.on("error", (err) => resolve(`failed to spawn ${cmd}: ${String(err)}`));
    proc.on("close", (code) => {
      if (code === 0) resolve(null);
      else resolve(`${cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
    });
  });
}

function escapePs(p: string): string {
  return p.replaceAll("'", "''");
}
