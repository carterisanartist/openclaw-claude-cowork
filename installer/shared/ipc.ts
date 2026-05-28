/**
 * IPC contract shared by main process, preload, and renderer.
 *
 * Everything the renderer can invoke on main goes through window.api, which
 * preload.ts wires up with contextBridge. Keep this file dependency-free so
 * the renderer can import the types without pulling in node-only modules.
 */

export interface DetectResult {
  claudeDesktop: {
    installed: boolean;
    configPath: string | null;
    /** When installed, the path to the Claude Desktop app/binary if we know it. */
    appPath: string | null;
  };
  openclaw: OpenClawDetect;
  node: {
    installed: boolean;
    nodePath: string | null;
    version: string | null;
    /** Parsed major version (>= 20 is what we need for the bridge to run). */
    major: number | null;
  };
  bridgeBundle: {
    /** Absolute path of company-claw-bridge.mcpb shipped with the installer. */
    bundlePath: string | null;
    exists: boolean;
  };
  platform: "darwin" | "win32" | "linux";
}

/**
 * Rich detection of an existing OpenClaw install. We look at four things:
 *   1. Is the CLI on PATH? (`installed` + `cliPath` + `version`)
 *   2. Is there a config file at the canonical path? (`configExists`)
 *   3. What's already configured in that file? (`existingProviders`,
 *      `defaultProvider`, `defaultModel`, `telegram*`)
 *   4. Is the gateway daemon currently running? (`gatewayRunning`)
 *
 * The renderer uses these to decide whether to:
 *   - skip "Initialize Claw" (already has a provider) or just confirm,
 *   - prefill the Telegram allowlist with what's already there,
 *   - warn the user before overwriting a different bot token, etc.
 */
export interface OpenClawDetect {
  installed: boolean;
  cliPath: string | null;
  version: string | null;
  configPath: string;
  configExists: boolean;

  /** Names of providers already present in llm.providers, if any. */
  existingProviders: string[];
  /** llm.defaultProvider from existing config, if set. */
  defaultProvider: string | null;
  /** llm.defaultModel from existing config, if set. */
  defaultModel: string | null;

  /** True if channels.telegram exists at all. */
  telegramConfigured: boolean;
  /** True if channels.telegram.botToken is a non-empty string. */
  telegramBotTokenSet: boolean;
  /** First few characters of the existing bot token (e.g. "123456:abcd...") for UI display only. */
  telegramBotTokenPreview: string | null;
  /** channels.telegram.allowFrom array, if present. */
  telegramAllowFrom: string[];

  /** True if `openclaw gateway status` exited 0 within the probe budget. */
  gatewayRunning: boolean | null;
  /** Trimmed output of `openclaw gateway status` for the UI. */
  gatewayStatusText: string | null;
}

export interface VerifyTokenInput {
  token: string;
}

export interface VerifyTokenResult {
  ok: boolean;
  /** Bot username (without @) when ok. */
  username?: string;
  /** Bot display name when ok. */
  firstName?: string;
  /** Bot user id when ok. */
  id?: number;
  /** Human-readable error message when !ok. */
  error?: string;
}

export interface DiscoverChatInput {
  token: string;
  /** Optional Telegram username to match (lowercased, no @). Helps when several users have messaged the bot. */
  preferredUsername?: string | null;
}

export interface DiscoverChatCandidate {
  chatId: string;
  type: string;
  title?: string;
  username?: string;
  firstName?: string;
  lastMessagePreview: string;
  lastMessageAt: number;
}

export interface DiscoverChatResult {
  ok: boolean;
  candidates: DiscoverChatCandidate[];
  /** When the preferred username matched exactly one chat, this is set. */
  matchedChatId?: string;
  error?: string;
}

export interface ConfigureOpenclawInput {
  token: string;
  /**
   * Whitelist of senders allowed to DM the bot. Per docs.openclaw.ai, this
   * MUST be numeric Telegram user ids (telegram:/tg: prefixes accepted), not
   * @usernames. Pass `["*"]` to combine with `dmPolicy: "open"` for a fully
   * public bot.
   */
  allowFrom: string[];
  /**
   * Default policy when there's no pairing record yet.
   *
   *  - "pairing":   safest; first DM gets a code the operator must approve.
   *  - "allowlist": every entry in allowFrom can DM directly; non-matched
   *                 senders are silently dropped.
   *  - "open":      requires allowFrom: ["*"].
   *  - "disabled":  channel parses but ignores all DMs.
   */
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
}

export interface ConfigureOpenclawResult {
  ok: boolean;
  /** True if we wrote new keys; false if Telegram channel was already configured matching the requested values. */
  changed: boolean;
  configPath: string;
  /** Whether the gateway daemon needs a restart for changes to take effect. */
  restartRequired: boolean;
  /** Raw output of `openclaw gateway status` after the write, when available. */
  gatewayStatus?: string;
  /** Validation/normalization warnings the user should see (e.g. dropped @usernames). */
  warnings?: string[];
  error?: string;
}

export interface InstallBridgeInput {
  token: string;
  chatId: string;
  auditChatId?: string | null;
  devMirror?: boolean;
  defaultTimeoutMs?: number;
  escalationMarker?: string;
}

export interface InstallBridgeResult {
  ok: boolean;
  /** Absolute path of the .mcpb file copied to the user's machine. */
  installedBundlePath?: string;
  /**
   * Path to claude_desktop_config.json that was written. The user still needs
   * to restart Claude Desktop for the entry to take effect.
   */
  claudeConfigPath?: string;
  /** True if we had to create a backup of an existing config first. */
  backupCreated?: boolean;
  backupPath?: string;
  error?: string;
}

export interface SmokeTestInput {
  token: string;
  chatId: string;
}

export interface SmokeTestResult {
  ok: boolean;
  /** Round-trip time from send to reply, in ms. */
  roundTripMs?: number;
  /** The reply text we received, when ok. Trimmed to 500 chars. */
  reply?: string;
  /** True if no inbound message at all was observed during the test window. */
  noReply?: boolean;
  /**
   * Soft warning surfaced when the reply succeeded but doesn't look like
   * /whoami output. Smoke test still passes; user should sanity-check the
   * reply text.
   */
  warning?: string;
  error?: string;
}

export interface OpenClawDoctorResult {
  ok: boolean;
  /** Raw stdout from `openclaw doctor`. */
  stdout?: string;
  /** Raw stderr from `openclaw doctor`. */
  stderr?: string;
  exitCode?: number;
  error?: string;
}

export interface RestartGatewayResult {
  ok: boolean;
  /** Raw stdout from `openclaw gateway restart`. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  /**
   * After the restart, the parsed result of `openclaw gateway status` if we
   * could read it. Useful for the UI to confirm the daemon came back up.
   */
  status?: string;
}

export type InstallerRole = "claw-host" | "claude-user" | "both";

/**
 * LLM providers OpenClaw can be wired up to. Each id maps to a documented
 * `openclaw onboard --auth-choice` value (see docs.openclaw.ai/cli/onboard).
 *
 * We rely on the OpenClaw CLI to actually write provider config so this map
 * stays in sync with what OpenClaw itself supports - we don't try to hand-roll
 * provider config files anymore.
 *
 * NOTE: ids match the upstream `--auth-choice` value 1:1 where possible. The
 * Google id is `gemini-api-key` (not `google-api-key`) because that's what
 * `openclaw onboard` actually accepts. Moonshot is split into `moonshot-intl`
 * and `moonshot-cn` because they're separate auth choices upstream
 * (`moonshot-api-key` vs `moonshot-api-key-cn`).
 */
export type ClawProviderId =
  | "anthropic-api-key"
  | "openai-api-key"
  | "openai-codex-oauth"
  | "gemini-api-key"
  | "ollama"
  | "moonshot-intl"
  | "moonshot-cn"
  | "zai-api-key"
  | "custom-api-key";

export interface InitOpenclawInput {
  provider: ClawProviderId;
  /**
   * Model ref to set as `agents.defaults.model.primary`. Always in the
   * provider-prefixed form OpenClaw expects, e.g. "anthropic/claude-sonnet-4-6".
   * The renderer enforces the prefix before sending so we never pass a bare
   * model id to the CLI.
   */
  model: string;
  /** API key when the provider requires one. */
  apiKey?: string;
  /** Base URL override - required for "custom-api-key", optional for "ollama" (defaults to http://127.0.0.1:11434). */
  baseUrl?: string;
  /** For "custom-api-key": "openai" or "anthropic" compatibility mode. */
  customCompatibility?: "openai" | "anthropic";
}

export interface InitOpenclawResult {
  ok: boolean;
  configPath?: string;
  /** True when the CLI exited 0. */
  changed?: boolean;
  /** What we set as the default provider/model in openclaw.json. */
  defaultProvider?: string;
  defaultModel?: string;
  /** Combined stdout/stderr of the onboard run, for the UI to display. */
  onboardOutput?: string;
  /** Output of `openclaw status --deep` after the write, when available. */
  statusOutput?: string;
  /** True when status reports the provider/gateway healthy. */
  statusOk?: boolean;
  error?: string;
}

/**
 * Whether to also install OpenClaw as a managed daemon (LaunchAgent / systemd
 * user unit / Windows Scheduled Task) so it survives logout and reboot.
 * Recommended for Claw-host machines; optional for "both" dev setups.
 */
export interface InstallDaemonInput {
  enable: boolean;
}

export interface InstallDaemonResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  /** Type of supervisor we tried to install. */
  supervisor?: "launchagent" | "systemd-user" | "scheduled-task" | "startup-folder" | "unknown";
  error?: string;
}

/**
 * Pairing-flow surface for the `dmPolicy: "pairing"` setup. We expose a way
 * to list pending pairing codes from the Telegram channel and to approve
 * them, so the user doesn't have to context-switch to a terminal.
 */
export interface PairingListResult {
  ok: boolean;
  pending: Array<{
    /** Pairing code OpenClaw issued when the sender first DM'd the bot. */
    code: string;
    /** Telegram user id (numeric, as a string) of the sender. */
    senderId: string;
    /** Optional display name OpenClaw harvested from the chat. */
    label?: string;
    /** Epoch ms; codes expire after 1 hour. */
    createdAtMs?: number;
  }>;
  /** Raw CLI output for display fallback. */
  raw?: string;
  error?: string;
}

export interface PairingApproveInput {
  code: string;
}

export interface PairingApproveResult {
  ok: boolean;
  raw?: string;
  error?: string;
}

/**
 * Quick reachability test for a provider/key combo before we write anything to
 * disk. For hosted providers this is a single HEAD/GET against a known endpoint
 * (e.g. anthropic /v1/models). For ollama it's GET <baseUrl>/api/tags. For
 * "custom" we hit <baseUrl>/v1/models if possible.
 */
export interface TestProviderInput {
  provider: ClawProviderId;
  apiKey?: string;
  baseUrl?: string;
}

export interface TestProviderResult {
  ok: boolean;
  /** Latency in ms when ok. */
  latencyMs?: number;
  /** Model ids reported by the provider when available, trimmed to ~50 entries. */
  models?: string[];
  error?: string;
}

/**
 * Detects whether the bridge bundle has already been unpacked on this machine
 * (typically via this installer on a previous run). Used by the "update
 * existing install" UI to offer a one-click in-place re-unpack that preserves
 * the env block in claude_desktop_config.json so the user doesn't have to
 * re-enter their bot token / chat ids.
 */
export interface ExistingBridgeStatus {
  installed: boolean;
  /** Where it lives (e.g. ~/.company-claw-bridge/bundle). */
  installDir: string;
  /** Path to dist/index.js if present. */
  entryPoint: string | null;
  /** Version string parsed out of the unpacked manifest.json, if readable. */
  installedVersion: string | null;
  /** Version string from the bundled .mcpb in this installer. */
  bundledVersion: string | null;
  /**
   * True if the version in this installer is strictly newer than what's on
   * disk. Used to gate "Update available" UI.
   */
  upgradeAvailable: boolean;
  /** Mirror of the existing claude_desktop_config.json env block, when present. */
  existingEnv?: Record<string, string>;
}

export interface UpdateBridgeInput {
  /**
   * When true, preserve the env block currently in claude_desktop_config.json
   * and only re-unpack the bundle. When false, behaves like installBridge.
   */
  preserveEnv: boolean;
  /**
   * Used only when preserveEnv is false - new env values from the wizard.
   */
  token?: string;
  chatId?: string;
  auditChatId?: string | null;
  devMirror?: boolean;
  defaultTimeoutMs?: number;
  escalationMarker?: string;
}

export interface UpdateBridgeResult {
  ok: boolean;
  installedBundlePath?: string;
  claudeConfigPath?: string;
  preservedEnv?: boolean;
  /** Previous version we wiped, when known. */
  previousVersion?: string | null;
  /** New version on disk after the update. */
  installedVersion?: string | null;
  backupCreated?: boolean;
  backupPath?: string;
  error?: string;
}

/**
 * Install (or uninstall) the bundle as a Claude Code plugin. Claude Code's
 * plugin contract is documented at code.claude.com/docs/en/plugins: a plugin
 * is a folder containing `.claude-plugin/plugin.json` plus the runtime files
 * referenced from it. Our .mcpb already ships that manifest, so the unpacked
 * tree is itself a valid plugin folder - we just need to register it at user
 * scope so `claude` picks it up on next start.
 *
 * Registration is done by either (a) shelling out to `claude plugin install
 * <dir>` when the CLI is on PATH, or (b) writing a `plugins.json` entry into
 * the user-scoped Claude Code data dir. We prefer (a) when available because
 * it survives schema changes upstream; (b) is the fallback.
 */
export interface ClaudeCodeInstallInput {
  enable: boolean;
}

export interface ClaudeCodeInstallResult {
  ok: boolean;
  /** Plugin directory that was registered with Claude Code. */
  pluginDir?: string;
  /**
   * Strategy that actually succeeded: cli = `claude plugin install`, manifest
   * = direct write of plugins.json, none = nothing applicable.
   */
  strategy?: "cli" | "manifest" | "none";
  /** Path to the user-scoped Claude Code config we wrote, when strategy=manifest. */
  configPath?: string;
  /** True if we removed an entry rather than added one. */
  uninstalled?: boolean;
  /** Diagnostic text for the UI. */
  output?: string;
  error?: string;
}

/**
 * Opt-in toggle for anonymized error reporting from the bridge.
 *
 * This is a UI-only flag today; we persist it into ~/.company-claw-bridge/
 * telemetry.json and the bridge reads it from there at startup. The bridge
 * is responsible for any actual sending (currently none - the flag wires
 * the plumbing but the wire is unconnected so we ship "off" without any
 * external dependency).
 */
export interface TelemetryConfigInput {
  enabled: boolean;
}

export interface TelemetryConfigResult {
  ok: boolean;
  enabled: boolean;
  configPath: string;
  error?: string;
}

export interface IpcApi {
  detect(): Promise<DetectResult>;
  verifyToken(input: VerifyTokenInput): Promise<VerifyTokenResult>;
  discoverChat(input: DiscoverChatInput): Promise<DiscoverChatResult>;
  runOpenclawDoctor(): Promise<OpenClawDoctorResult>;
  runOpenclawDoctorFix(): Promise<OpenClawDoctorResult>;
  runOpenclawStatusDeep(): Promise<OpenClawDoctorResult>;
  configureOpenclaw(input: ConfigureOpenclawInput): Promise<ConfigureOpenclawResult>;
  restartGateway(): Promise<RestartGatewayResult>;
  installDaemon(input: InstallDaemonInput): Promise<InstallDaemonResult>;
  pairingList(): Promise<PairingListResult>;
  pairingApprove(input: PairingApproveInput): Promise<PairingApproveResult>;
  initOpenclaw(input: InitOpenclawInput): Promise<InitOpenclawResult>;
  testProvider(input: TestProviderInput): Promise<TestProviderResult>;
  installBridge(input: InstallBridgeInput): Promise<InstallBridgeResult>;
  detectExistingBridge(): Promise<ExistingBridgeStatus>;
  updateBridge(input: UpdateBridgeInput): Promise<UpdateBridgeResult>;
  claudeCodeInstall(input: ClaudeCodeInstallInput): Promise<ClaudeCodeInstallResult>;
  setTelemetry(input: TelemetryConfigInput): Promise<TelemetryConfigResult>;
  getTelemetry(): Promise<TelemetryConfigResult>;
  smokeTest(input: SmokeTestInput): Promise<SmokeTestResult>;
  openExternal(url: string): Promise<void>;
  revealInFolder(path: string): Promise<void>;
  quit(): Promise<void>;
}

declare global {
  // Augmented by preload.ts via contextBridge.
  interface Window {
    api: IpcApi;
  }
}

export const IPC_CHANNELS = {
  detect: "ccb:detect",
  verifyToken: "ccb:verifyToken",
  discoverChat: "ccb:discoverChat",
  runOpenclawDoctor: "ccb:runOpenclawDoctor",
  runOpenclawDoctorFix: "ccb:runOpenclawDoctorFix",
  runOpenclawStatusDeep: "ccb:runOpenclawStatusDeep",
  configureOpenclaw: "ccb:configureOpenclaw",
  restartGateway: "ccb:restartGateway",
  installDaemon: "ccb:installDaemon",
  pairingList: "ccb:pairingList",
  pairingApprove: "ccb:pairingApprove",
  initOpenclaw: "ccb:initOpenclaw",
  testProvider: "ccb:testProvider",
  installBridge: "ccb:installBridge",
  detectExistingBridge: "ccb:detectExistingBridge",
  updateBridge: "ccb:updateBridge",
  claudeCodeInstall: "ccb:claudeCodeInstall",
  setTelemetry: "ccb:setTelemetry",
  getTelemetry: "ccb:getTelemetry",
  smokeTest: "ccb:smokeTest",
  openExternal: "ccb:openExternal",
  revealInFolder: "ccb:revealInFolder",
  quit: "ccb:quit",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
