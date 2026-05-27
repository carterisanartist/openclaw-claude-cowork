/**
 * Detect an existing bridge install on disk.
 *
 * The unpacked bundle lives under ~/.company-claw-bridge/bundle and always
 * contains a manifest.json at the root. We read its `version` field to compare
 * against the version of the .mcpb we ship inside this installer.
 *
 * We also reach into claude_desktop_config.json so the wizard can offer a
 * one-click "Update bundle, keep my secrets" flow.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExistingBridgeStatus } from "../shared/ipc";

import { bundleInstallDir, readClaudeConfig, BRIDGE_SERVER_NAME } from "./claudeConfig";
import { fileExists, locateBridgeBundle } from "./detect";

export async function detectExistingBridge(args: {
  resourcesPath: string;
  appPath: string;
  claudeConfigPath: string | null;
}): Promise<ExistingBridgeStatus> {
  const installDir = bundleInstallDir();
  const entryPoint = join(installDir, "dist", "index.js");
  const installedManifest = join(installDir, "manifest.json");
  const bundledInfo = await locateBridgeBundle({
    resourcesPath: args.resourcesPath,
    appPath: args.appPath,
  });

  const installed = await fileExists(entryPoint);
  let installedVersion: string | null = null;
  if (installed && (await fileExists(installedManifest))) {
    installedVersion = await readManifestVersion(installedManifest);
  }
  const bundledVersion = bundledInfo.exists && bundledInfo.bundlePath
    ? await readBundledManifestVersionFromMcpb(bundledInfo.bundlePath)
    : null;

  let existingEnv: Record<string, string> | undefined;
  if (args.claudeConfigPath) {
    try {
      const cfg = await readClaudeConfig(args.claudeConfigPath);
      const entry = cfg.mcpServers?.[BRIDGE_SERVER_NAME];
      if (entry?.env) existingEnv = { ...entry.env };
    } catch {
      // ignore: a missing/invalid config just means no env to preserve
    }
  }

  return {
    installed,
    installDir,
    entryPoint: installed ? entryPoint : null,
    installedVersion,
    bundledVersion,
    upgradeAvailable: Boolean(
      installedVersion && bundledVersion && semverGreater(bundledVersion, installedVersion),
    ),
    existingEnv,
  };
}

async function readManifestVersion(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Read manifest.json out of a .mcpb (zip) without extracting the whole
 * archive. Uses Node's zlib + a tiny zip central-directory reader because
 * pulling in adm-zip / yauzl just for this would be silly.
 *
 * Returns null on any error; the UI will fall back to "unknown version".
 */
async function readBundledManifestVersionFromMcpb(mcpbPath: string): Promise<string | null> {
  try {
    const { readFileSync } = await import("node:fs");
    const { inflateRawSync } = await import("node:zlib");
    const buf = readFileSync(mcpbPath);
    // Walk the End-of-Central-Directory record to find the central dir.
    const eocdSig = 0x06054b50;
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
      if (buf.readUInt32LE(i) === eocdSig) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) return null;
    const cdSize = buf.readUInt32LE(eocdOffset + 12);
    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    let p = cdOffset;
    const cdEnd = cdOffset + cdSize;
    while (p < cdEnd) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const compMethod = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const uncompSize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOffset = buf.readUInt32LE(p + 42);
      const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
      p += 46 + nameLen + extraLen + commentLen;
      if (name === "manifest.json") {
        // Read the local header at localOffset.
        const lhNameLen = buf.readUInt16LE(localOffset + 26);
        const lhExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
        const dataEnd = dataStart + compSize;
        const data = buf.slice(dataStart, dataEnd);
        let raw: string;
        if (compMethod === 0) raw = data.toString("utf8");
        else if (compMethod === 8) raw = inflateRawSync(data).toString("utf8");
        else return null;
        // sanity check
        if (raw.length === 0 || raw.length > uncompSize + 256) return null;
        try {
          const parsed = JSON.parse(raw) as { version?: unknown };
          return typeof parsed.version === "string" ? parsed.version : null;
        } catch {
          return null;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strict-greater semver-ish compare. We tolerate non-numeric suffixes by
 * dropping them, e.g. "0.2.0-beta.1" -> [0,2,0]. Good enough for an installer
 * "upgrade available" badge - we don't need full SemVer 2.0.
 */
export function semverGreater(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

function parseVersion(v: string): [number, number, number] {
  const cleaned = v.replace(/^v/, "").split(/[-+]/, 1)[0];
  const parts = cleaned.split(".").map((p) => Number.parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}
