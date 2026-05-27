/**
 * Tiny on-disk toggle for opt-in anonymized error reporting.
 *
 * The bridge reads this file at startup (server/config.ts has no hook today,
 * but the contract is fixed so future telemetry plumbing can land without
 * touching the installer). We deliberately keep it OFF by default and require
 * an explicit user click in the installer to flip it on - we don't ship any
 * remote endpoint in this commit, so for now the toggle just records consent.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface TelemetryFile {
  enabled: boolean;
  /** When the user last changed the setting (epoch ms). */
  decidedAt?: number;
}

export function telemetryConfigPath(): string {
  return join(homedir(), ".company-claw-bridge", "telemetry.json");
}

export async function readTelemetry(): Promise<TelemetryFile> {
  try {
    const raw = await readFile(telemetryConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TelemetryFile>;
    return { enabled: parsed.enabled === true, decidedAt: parsed.decidedAt };
  } catch {
    return { enabled: false };
  }
}

export async function writeTelemetry(enabled: boolean): Promise<void> {
  const path = telemetryConfigPath();
  await mkdir(dirname(path), { recursive: true });
  const payload: TelemetryFile = { enabled, decidedAt: Date.now() };
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmp, path);
}
