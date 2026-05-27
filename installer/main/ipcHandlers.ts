/**
 * All IPC handlers, registered on app ready. These compose the lower-level
 * modules (telegram, detect, claudeConfig, openclawConfig, bundle, smokeTest)
 * into the operations exposed to the renderer via window.api.
 */

import { ipcMain, shell } from "electron";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import {
  type ClaudeCodeInstallInput,
  type ClaudeCodeInstallResult,
  type ConfigureOpenclawInput,
  type ConfigureOpenclawResult,
  type DetectResult,
  type DiscoverChatInput,
  type DiscoverChatResult,
  type ExistingBridgeStatus,
  IPC_CHANNELS,
  type InitOpenclawInput,
  type InitOpenclawResult,
  type InstallBridgeInput,
  type InstallBridgeResult,
  type InstallDaemonInput,
  type InstallDaemonResult,
  type OpenClawDoctorResult,
  type PairingApproveInput,
  type PairingApproveResult,
  type PairingListResult,
  type RestartGatewayResult,
  type SmokeTestInput,
  type SmokeTestResult,
  type TelemetryConfigInput,
  type TelemetryConfigResult,
  type TestProviderInput,
  type TestProviderResult,
  type UpdateBridgeInput,
  type UpdateBridgeResult,
  type VerifyTokenInput,
  type VerifyTokenResult,
} from "../shared/ipc";

import {
  BRIDGE_SERVER_NAME,
  buildBridgeEnv,
  bundleInstallDir,
  readClaudeConfig,
  writeClaudeConfig,
} from "./claudeConfig";
import { unpackBundle } from "./bundle";
import {
  currentPlatform,
  detectClaudeDesktop,
  detectNode,
  detectOpenClaw,
  detectOpenClawFull,
  locateBridgeBundle,
} from "./detect";
import {
  applyTelegramChannelConfig,
  buildOnboardArgs,
  providerIdToConfigKey,
  readOpenClawConfig,
  runOpenClawCli,
  writeOpenClawConfig,
} from "./openclawConfig";
import { registerClaudeCodePlugin } from "./claudeCodeInstall";
import { detectExistingBridge as readExistingBridge } from "./existingBridge";
import { probeProvider } from "./providerProbe";
import { smokeTest } from "./smokeTest";
import { getMe, recentUpdates } from "./telegram";
import { readTelemetry, telemetryConfigPath, writeTelemetry } from "./telemetry";

export interface InstallerEnv {
  /**
   * Where electron-builder puts extraResources: app.isPackaged
   *   ? process.resourcesPath
   *   : <repo root> (../) in dev
   */
  resourcesPath: string;
  /**
   * Absolute path of the running app. process.execPath in packaged builds,
   * useful for sibling-bundle lookups in dev.
   */
  appPath: string;
  /** app.getPath('appData') equivalent if main needs it later. */
  appDataPath: string;
  /** app.quit() */
  quit: () => void;
}

export function registerIpcHandlers(env: InstallerEnv): void {
  ipcMain.handle(IPC_CHANNELS.detect, async (): Promise<DetectResult> => {
    const [claude, openclaw, node, bundle] = await Promise.all([
      detectClaudeDesktop(),
      detectOpenClawFull(),
      detectNode(),
      locateBridgeBundle({ resourcesPath: env.resourcesPath, appPath: env.appPath }),
    ]);
    return {
      claudeDesktop: claude,
      openclaw,
      node,
      bridgeBundle: bundle,
      platform: currentPlatform(),
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.verifyToken,
    async (_evt, input: VerifyTokenInput): Promise<VerifyTokenResult> => {
      try {
        const info = await getMe(input.token);
        return {
          ok: true,
          username: info.username,
          firstName: info.first_name,
          id: info.id,
        };
      } catch (err) {
        return { ok: false, error: humanError(err) };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.discoverChat,
    async (_evt, input: DiscoverChatInput): Promise<DiscoverChatResult> => {
      try {
        const updates = await recentUpdates(input.token);
        const byChat = new Map<string, DiscoverChatResult["candidates"][number]>();
        for (const upd of updates) {
          const msg = upd.message ?? upd.edited_message;
          if (!msg) continue;
          const id = String(msg.chat.id);
          const existing = byChat.get(id);
          const ts = msg.date * 1000;
          if (existing && existing.lastMessageAt >= ts) continue;
          byChat.set(id, {
            chatId: id,
            type: msg.chat.type,
            title: msg.chat.title,
            username: msg.chat.username,
            firstName: msg.chat.first_name,
            lastMessagePreview: (msg.text ?? msg.caption ?? "").slice(0, 120),
            lastMessageAt: ts,
          });
        }
        const candidates = Array.from(byChat.values()).sort(
          (a, b) => b.lastMessageAt - a.lastMessageAt,
        );
        let matchedChatId: string | undefined;
        if (input.preferredUsername) {
          const want = input.preferredUsername.toLowerCase().replace(/^@/, "");
          const matches = candidates.filter(
            (c) => (c.username ?? "").toLowerCase() === want,
          );
          if (matches.length === 1) matchedChatId = matches[0].chatId;
        }
        return { ok: true, candidates, matchedChatId };
      } catch (err) {
        return { ok: false, candidates: [], error: humanError(err) };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.runOpenclawDoctor,
    async (): Promise<OpenClawDoctorResult> => {
      const openclaw = await detectOpenClaw();
      if (!openclaw.installed || !openclaw.cliPath) {
        return {
          ok: false,
          error: "OpenClaw CLI not found on PATH. Install via: npm install -g openclaw@latest",
        };
      }
      const result = await runOpenClawCli(openclaw.cliPath, ["doctor"], { timeoutMs: 60_000 });
      return {
        ok: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? -1,
      };
    },
  );

  // `openclaw doctor --fix` attempts safe in-place repairs (e.g. resolving
  // @username allowlist entries to numeric IDs via a Telegram bot lookup,
  // recovering pairing-store entries into allowFrom, normalizing legacy
  // config keys). We expose it from the UI so users can self-heal common
  // upgrade issues without needing a terminal.
  ipcMain.handle(
    IPC_CHANNELS.runOpenclawDoctorFix,
    async (): Promise<OpenClawDoctorResult> => {
      const openclaw = await detectOpenClaw();
      if (!openclaw.installed || !openclaw.cliPath) {
        return {
          ok: false,
          error: "OpenClaw CLI not found on PATH. Install via: npm install -g openclaw@latest",
        };
      }
      const result = await runOpenClawCli(openclaw.cliPath, ["doctor", "--fix"], {
        timeoutMs: 90_000,
      });
      return {
        ok: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? -1,
      };
    },
  );

  // `openclaw status --deep` is the richer probe that hits the live gateway
  // health endpoint and per-channel probes. We surface it after init/bind so
  // the user sees an authoritative go/no-go signal.
  ipcMain.handle(
    IPC_CHANNELS.runOpenclawStatusDeep,
    async (): Promise<OpenClawDoctorResult> => {
      const openclaw = await detectOpenClaw();
      if (!openclaw.installed || !openclaw.cliPath) {
        return {
          ok: false,
          error: "OpenClaw CLI not found on PATH.",
        };
      }
      const result = await runOpenClawCli(openclaw.cliPath, ["status", "--deep"], {
        timeoutMs: 30_000,
      });
      return {
        ok: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? -1,
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.configureOpenclaw,
    async (_evt, input: ConfigureOpenclawInput): Promise<ConfigureOpenclawResult> => {
      const openclaw = await detectOpenClaw();
      try {
        const current = await readOpenClawConfig(openclaw.configPath);
        const { next, changed, warnings } = applyTelegramChannelConfig(current, {
          token: input.token,
          allowFrom: input.allowFrom,
          dmPolicy: input.dmPolicy,
        });
        if (changed) {
          await writeOpenClawConfig(openclaw.configPath, next);
        }

        let gatewayStatus: string | undefined;
        if (openclaw.installed && openclaw.cliPath) {
          const status = await runOpenClawCli(
            openclaw.cliPath,
            ["status", "--deep"],
            { timeoutMs: 20_000 },
          );
          gatewayStatus = (status.stdout || status.stderr).trim().slice(0, 4000);
        }

        return {
          ok: true,
          changed,
          configPath: openclaw.configPath,
          restartRequired: changed,
          gatewayStatus,
          warnings,
        };
      } catch (err) {
        return {
          ok: false,
          changed: false,
          configPath: openclaw.configPath,
          restartRequired: false,
          error: humanError(err),
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.testProvider,
    async (_evt, input: TestProviderInput): Promise<TestProviderResult> => {
      return await probeProvider(input);
    },
  );

  // Provider/model setup is delegated to `openclaw onboard --non-interactive`.
  // This is the only stable contract OpenClaw exposes for headless provider
  // setup; writing `~/.openclaw/openclaw.json` ourselves would lock us into
  // their pre-2026 `llm.*` shape, which has been replaced by
  // `agents.defaults.model.primary` + `models.providers.<id>` and per-agent
  // `models.json` registries we'd have to keep in sync by hand.
  ipcMain.handle(
    IPC_CHANNELS.initOpenclaw,
    async (_evt, input: InitOpenclawInput): Promise<InitOpenclawResult> => {
      const openclaw = await detectOpenClaw();
      try {
        if (!input.model || input.model.trim().length === 0) {
          return { ok: false, error: "Model id is required." };
        }
        if (!input.model.includes("/")) {
          return {
            ok: false,
            error: `Model id must be provider-prefixed (e.g. anthropic/claude-sonnet-4-6). Got "${input.model}".`,
          };
        }
        if (!openclaw.installed || !openclaw.cliPath) {
          return {
            ok: false,
            error:
              "OpenClaw CLI not found on PATH. Install with: npm install -g openclaw@latest, then re-run this step.",
          };
        }

        const { args, env } = buildOnboardArgs(input);
        // Onboard can take a while when it walks model discovery + skill
        // installs; give it a generous timeout. We deliberately do NOT
        // increase it past 5 minutes - if it's stuck longer than that
        // something is wrong (e.g. waiting on OAuth that we can't drive).
        const onboard = await runOpenClawCli(openclaw.cliPath, args, {
          timeoutMs: 5 * 60_000,
          env,
        });
        const onboardOutput = (onboard.stdout || onboard.stderr).trim().slice(0, 8000);

        if (onboard.exitCode !== 0) {
          return {
            ok: false,
            configPath: openclaw.configPath,
            defaultProvider: providerIdToConfigKey(input.provider),
            defaultModel: input.model,
            onboardOutput,
            error: `openclaw onboard exited with code ${onboard.exitCode ?? "null"}.`,
          };
        }

        // After auth is in place, pin the primary model to whatever the user
        // picked. `models set` handles allowlist edits via merge semantics so
        // we don't clobber existing entries.
        const setModel = await runOpenClawCli(openclaw.cliPath, ["models", "set", input.model], {
          timeoutMs: 30_000,
        });

        // Probe live gateway state so the UI can show a green checkmark.
        const status = await runOpenClawCli(openclaw.cliPath, ["status", "--deep"], {
          timeoutMs: 20_000,
        });
        const statusOutput = (status.stdout || status.stderr).trim().slice(0, 4000);

        return {
          ok: true,
          configPath: openclaw.configPath,
          changed: true,
          defaultProvider: providerIdToConfigKey(input.provider),
          defaultModel: input.model,
          onboardOutput:
            setModel.exitCode === 0
              ? onboardOutput
              : `${onboardOutput}\n\n[models set] exit ${setModel.exitCode ?? "null"}\n${(setModel.stdout || setModel.stderr).trim().slice(0, 2000)}`,
          statusOutput,
          statusOk: status.exitCode === 0,
        };
      } catch (err) {
        return {
          ok: false,
          configPath: openclaw.configPath,
          error: humanError(err),
        };
      }
    },
  );

  // `openclaw gateway install` (or `openclaw onboard --install-daemon`) sets
  // up a LaunchAgent / systemd user unit / Windows Scheduled Task so the
  // gateway survives logout and reboot. Without this, the user has to
  // remember to run `openclaw gateway` every time their machine restarts.
  ipcMain.handle(
    IPC_CHANNELS.installDaemon,
    async (_evt, input: InstallDaemonInput): Promise<InstallDaemonResult> => {
      const openclaw = await detectOpenClaw();
      if (!openclaw.installed || !openclaw.cliPath) {
        return {
          ok: false,
          error: "OpenClaw CLI not found on PATH. Install with: npm install -g openclaw@latest",
        };
      }
      if (input.enable === false) {
        const uninstall = await runOpenClawCli(openclaw.cliPath, ["gateway", "uninstall"], {
          timeoutMs: 30_000,
        });
        return {
          ok: uninstall.exitCode === 0,
          stdout: uninstall.stdout,
          stderr: uninstall.stderr,
          supervisor: supervisorForPlatform(),
        };
      }
      const install = await runOpenClawCli(openclaw.cliPath, ["gateway", "install"], {
        timeoutMs: 60_000,
      });
      return {
        ok: install.exitCode === 0,
        stdout: install.stdout,
        stderr: install.stderr,
        supervisor: supervisorForPlatform(),
        error:
          install.exitCode === 0
            ? undefined
            : `gateway install exited with ${install.exitCode ?? "null"}.`,
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.pairingList, async (): Promise<PairingListResult> => {
    const openclaw = await detectOpenClaw();
    if (!openclaw.installed || !openclaw.cliPath) {
      return { ok: false, pending: [], error: "OpenClaw CLI not found." };
    }
    const result = await runOpenClawCli(
      openclaw.cliPath,
      ["pairing", "list", "telegram", "--json"],
      { timeoutMs: 15_000 },
    );
    const raw = (result.stdout || result.stderr).trim();
    if (result.exitCode !== 0) {
      // Fallback: try the non-JSON form for older OpenClaw versions.
      const plain = await runOpenClawCli(openclaw.cliPath, ["pairing", "list", "telegram"], {
        timeoutMs: 15_000,
      });
      return {
        ok: plain.exitCode === 0,
        pending: parsePairingPlain(plain.stdout || plain.stderr),
        raw: (plain.stdout || plain.stderr).trim(),
        error:
          plain.exitCode === 0
            ? undefined
            : `pairing list exited with ${plain.exitCode ?? "null"}.`,
      };
    }
    try {
      const parsed = JSON.parse(raw) as Array<{
        code?: string;
        sender_id?: string | number;
        senderId?: string | number;
        label?: string;
        created_at_ms?: number;
        createdAtMs?: number;
      }>;
      const pending = Array.isArray(parsed)
        ? parsed
            .map((entry) => ({
              code: String(entry.code ?? "").trim(),
              senderId: String(entry.senderId ?? entry.sender_id ?? "").trim(),
              label: entry.label,
              createdAtMs: entry.createdAtMs ?? entry.created_at_ms,
            }))
            .filter((p) => p.code.length > 0)
        : [];
      return { ok: true, pending, raw };
    } catch {
      return { ok: true, pending: parsePairingPlain(raw), raw };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.pairingApprove,
    async (_evt, input: PairingApproveInput): Promise<PairingApproveResult> => {
      const openclaw = await detectOpenClaw();
      if (!openclaw.installed || !openclaw.cliPath) {
        return { ok: false, error: "OpenClaw CLI not found." };
      }
      const code = (input.code ?? "").trim();
      if (code.length === 0) {
        return { ok: false, error: "Pairing code is required." };
      }
      const result = await runOpenClawCli(
        openclaw.cliPath,
        ["pairing", "approve", "telegram", code],
        { timeoutMs: 15_000 },
      );
      return {
        ok: result.exitCode === 0,
        raw: (result.stdout || result.stderr).trim(),
        error:
          result.exitCode === 0
            ? undefined
            : `pairing approve exited with ${result.exitCode ?? "null"}.`,
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.restartGateway, async (): Promise<RestartGatewayResult> => {
    const openclaw = await detectOpenClaw();
    if (!openclaw.installed || !openclaw.cliPath) {
      return {
        ok: false,
        error: "OpenClaw CLI not found on PATH. Install with: npm install -g openclaw@latest",
      };
    }
    // `openclaw gateway restart` exits 0 even when the daemon takes a moment
    // to come back up; we follow with a status read so the UI has something
    // to display.
    const restart = await runOpenClawCli(
      openclaw.cliPath,
      ["gateway", "restart"],
      { timeoutMs: 60_000 },
    );
    const status = await runOpenClawCli(
      openclaw.cliPath,
      ["status", "--deep"],
      { timeoutMs: 20_000 },
    );
    return {
      ok: restart.exitCode === 0,
      stdout: restart.stdout,
      stderr: restart.stderr,
      exitCode: restart.exitCode ?? -1,
      status: (status.stdout || status.stderr).trim().slice(0, 4000),
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.installBridge,
    async (_evt, input: InstallBridgeInput): Promise<InstallBridgeResult> => {
      try {
        const bundleInfo = await locateBridgeBundle({
          resourcesPath: env.resourcesPath,
          appPath: env.appPath,
        });
        if (!bundleInfo.exists || !bundleInfo.bundlePath) {
          return {
            ok: false,
            error:
              "Bundled company-claw-bridge.mcpb not found. The installer is incomplete - rebuild it.",
          };
        }
        const installDir = bundleInstallDir();
        const unpack = await unpackBundle({
          bundlePath: bundleInfo.bundlePath,
          installDir,
        });
        if (!unpack.ok || !unpack.entryPoint) {
          return { ok: false, error: unpack.error ?? "Bundle unpack failed." };
        }

        const claude = await detectClaudeDesktop();
        if (!claude.configPath) {
          return {
            ok: false,
            error:
              "Could not determine where Claude Desktop stores its config on this platform.",
          };
        }
        // Prefer the actual node.exe / node we just detected over the bare
        // command name. Claude Desktop spawns mcpServers entries with its own
        // PATH, which on Windows can omit %APPDATA%\npm and similar - so
        // pinning the absolute path avoids "node was not found" surprises.
        const node = await detectNode();
        const nodeCommand = node.nodePath ?? nodePathForPlatform();
        const config = await readClaudeConfig(claude.configPath);
        config.mcpServers = config.mcpServers ?? {};
        config.mcpServers[BRIDGE_SERVER_NAME] = {
          command: nodeCommand,
          args: [unpack.entryPoint],
          env: buildBridgeEnv({
            token: input.token,
            chatId: input.chatId,
            auditChatId: input.auditChatId,
            devMirror: input.devMirror,
            defaultTimeoutMs: input.defaultTimeoutMs,
            escalationMarker: input.escalationMarker,
            stateDir: join(homedir(), ".company-claw-bridge"),
          }),
        };
        const { backupPath } = await writeClaudeConfig(claude.configPath, config);

        return {
          ok: true,
          installedBundlePath: installDir,
          claudeConfigPath: claude.configPath,
          backupCreated: backupPath !== null,
          backupPath: backupPath ?? undefined,
        };
      } catch (err) {
        return { ok: false, error: humanError(err) };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.detectExistingBridge,
    async (): Promise<ExistingBridgeStatus> => {
      const claude = await detectClaudeDesktop();
      return await readExistingBridge({
        resourcesPath: env.resourcesPath,
        appPath: env.appPath,
        claudeConfigPath: claude.configPath,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.updateBridge,
    async (_evt, input: UpdateBridgeInput): Promise<UpdateBridgeResult> => {
      try {
        const claude = await detectClaudeDesktop();
        if (!claude.configPath) {
          return {
            ok: false,
            error:
              "Could not determine where Claude Desktop stores its config on this platform.",
          };
        }
        const before = await readExistingBridge({
          resourcesPath: env.resourcesPath,
          appPath: env.appPath,
          claudeConfigPath: claude.configPath,
        });
        const bundleInfo = await locateBridgeBundle({
          resourcesPath: env.resourcesPath,
          appPath: env.appPath,
        });
        if (!bundleInfo.exists || !bundleInfo.bundlePath) {
          return {
            ok: false,
            error: "Bundled .mcpb missing from installer payload.",
          };
        }
        const installDir = bundleInstallDir();
        const unpack = await unpackBundle({
          bundlePath: bundleInfo.bundlePath,
          installDir,
        });
        if (!unpack.ok || !unpack.entryPoint) {
          return { ok: false, error: unpack.error ?? "Bundle unpack failed." };
        }

        const config = await readClaudeConfig(claude.configPath);
        config.mcpServers = config.mcpServers ?? {};
        const existingEntry = config.mcpServers[BRIDGE_SERVER_NAME];
        const node = await detectNode();
        const nodeCommand = node.nodePath ?? nodePathForPlatform();
        let preservedEnv = false;
        let envBlock: Record<string, string>;
        if (input.preserveEnv && existingEntry?.env) {
          envBlock = { ...existingEntry.env };
          preservedEnv = true;
        } else if (input.token && input.chatId) {
          envBlock = buildBridgeEnv({
            token: input.token,
            chatId: input.chatId,
            auditChatId: input.auditChatId,
            devMirror: input.devMirror,
            defaultTimeoutMs: input.defaultTimeoutMs,
            escalationMarker: input.escalationMarker,
            stateDir: join(homedir(), ".company-claw-bridge"),
          });
        } else {
          return {
            ok: false,
            error:
              "No existing env to preserve and no new credentials supplied. Provide either preserveEnv=true on top of an existing install, or token + chatId.",
          };
        }
        config.mcpServers[BRIDGE_SERVER_NAME] = {
          command: nodeCommand,
          args: [unpack.entryPoint],
          env: envBlock,
        };
        const { backupPath } = await writeClaudeConfig(claude.configPath, config);
        const after = await readExistingBridge({
          resourcesPath: env.resourcesPath,
          appPath: env.appPath,
          claudeConfigPath: claude.configPath,
        });
        return {
          ok: true,
          installedBundlePath: installDir,
          claudeConfigPath: claude.configPath,
          preservedEnv,
          previousVersion: before.installedVersion ?? null,
          installedVersion: after.installedVersion ?? null,
          backupCreated: backupPath !== null,
          backupPath: backupPath ?? undefined,
        };
      } catch (err) {
        return { ok: false, error: humanError(err) };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.claudeCodeInstall,
    async (_evt, input: ClaudeCodeInstallInput): Promise<ClaudeCodeInstallResult> => {
      try {
        const installDir = bundleInstallDir();
        const result = await registerClaudeCodePlugin({
          pluginDir: installDir,
          enable: input.enable,
        });
        return {
          ok: result.ok,
          pluginDir: installDir,
          strategy: result.strategy,
          configPath: result.configPath,
          uninstalled: result.uninstalled,
          output: result.output,
          error: result.error,
        };
      } catch (err) {
        return { ok: false, strategy: "none", error: humanError(err) };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.setTelemetry,
    async (_evt, input: TelemetryConfigInput): Promise<TelemetryConfigResult> => {
      try {
        await writeTelemetry(input.enabled);
        return { ok: true, enabled: input.enabled, configPath: telemetryConfigPath() };
      } catch (err) {
        return {
          ok: false,
          enabled: input.enabled,
          configPath: telemetryConfigPath(),
          error: humanError(err),
        };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.getTelemetry, async (): Promise<TelemetryConfigResult> => {
    const t = await readTelemetry();
    return { ok: true, enabled: t.enabled, configPath: telemetryConfigPath() };
  });

  ipcMain.handle(
    IPC_CHANNELS.smokeTest,
    async (_evt, input: SmokeTestInput): Promise<SmokeTestResult> => {
      return await smokeTest({ token: input.token, chatId: input.chatId });
    },
  );

  ipcMain.handle(IPC_CHANNELS.openExternal, async (_evt, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC_CHANNELS.revealInFolder, async (_evt, path: string) => {
    shell.showItemInFolder(path);
  });

  ipcMain.handle(IPC_CHANNELS.quit, async () => {
    env.quit();
  });
}

/**
 * Best guess at a `node` command Claude Desktop will be able to spawn.
 *
 * Claude Desktop ships an embedded Node runtime for MCPB installs but does
 * NOT expose it to manual mcpServers entries. To keep this installer's
 * implementation simple we depend on the user having Node 20+ on PATH; the
 * prereq screen flags this if it's missing.
 */
function nodePathForPlatform(): string {
  return platform() === "win32" ? "node.exe" : "node";
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Map current OS to the supervisor type `openclaw gateway install` will use.
 * This is informational only - the CLI is the source of truth.
 */
function supervisorForPlatform(): InstallDaemonResult["supervisor"] {
  switch (platform()) {
    case "darwin":
      return "launchagent";
    case "linux":
      return "systemd-user";
    case "win32":
      // The CLI prefers Scheduled Task and falls back to Startup folder; we
      // can't know which without parsing CLI output.
      return "scheduled-task";
    default:
      return "unknown";
  }
}

/**
 * Best-effort parser for `openclaw pairing list telegram` text output,
 * used when --json isn't available. The CLI's plaintext format looks like:
 *
 *   CODE       SENDER               AGE
 *   a1b2c3d4   123456789 (Alice)    2m
 *
 * We pull code + numeric sender id; everything else is optional metadata.
 */
export function parsePairingPlain(text: string): PairingListResult["pending"] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^code\b/i.test(l) && !/^-+$/.test(l));
  const out: PairingListResult["pending"] = [];
  for (const line of lines) {
    // Codes can include underscores and hyphens, and recent OpenClaw versions
    // shortened them to 3 characters for ergonomics. The sender id is always
    // a numeric Telegram user id (>= 1, but in practice 4+ digits today;
    // accept any positive int to be safe against future test fixtures).
    const m = /^([a-z0-9_-]{3,})\s+(\d+)\b/i.exec(line);
    if (!m) continue;
    // Try to pluck a trailing parenthesized label, e.g. "123456 (Alice)".
    const labelMatch = /\((.+?)\)/.exec(line);
    out.push({
      code: m[1],
      senderId: m[2],
      ...(labelMatch ? { label: labelMatch[1] } : {}),
    });
  }
  return out;
}
