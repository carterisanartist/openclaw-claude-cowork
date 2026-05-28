# Lunace Tether Setup (installer)

An Electron app from [Lunace Labs](https://lunacelabs.ai) that walks users through tethering
[Lunace Tether](../README.md) into Claude Desktop and binding it to your company's central
OpenClaw assistant.

It produces:
- **macOS**: `Lunace Tether Setup-<version>.dmg` (x64 + arm64)
- **Windows**: `Lunace Tether Setup Setup <version>.exe` (NSIS, x64)
- **Linux**: `Lunace Tether Setup-<version>.AppImage` (x64)

## What the wizard does

One installer, two flows. After Welcome the user picks a role for the machine they're on:

| Role                                | Purpose                                                                                | Steps run                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claw host**                       | The Mac mini / Windows box / server that runs the OpenClaw Gateway                     | Prereqs → **Initialize Claw** → Token → Bind OpenClaw → Restart Gateway → Done                                                              |
| **Claude side**                     | A laptop / workstation where someone uses Claude Desktop                                | Prereqs → Token → Find your chat → Install bridge → Smoke test → Done                                                                       |
| **Both on this machine**            | Single-box dev / demo setup                                                            | Prereqs → **Initialize Claw** → Token → Bind OpenClaw → Restart Gateway → Find your chat → Install bridge → Smoke test → Done               |

Steps in detail:

- **Welcome** — explains the architecture with a diagram.
- **Role chooser** — three big cards; the picked role drives the rest of the sidebar.
- **Prerequisites (role-aware)** — checks only what the chosen role needs.
  - Claw host: OpenClaw CLI.
  - Claude side: Claude Desktop, Node 20+ (we actually run `node --version`, not just guess), bundled `.mcpb`.
  - Both: all of the above.
  - On Windows, the OpenClaw and Node lookups also probe `%APPDATA%\npm` and `%ProgramFiles%\nodejs` directly, so we still find them even if the npm-global bin dir isn't on PATH for the spawned Electron process.
- **Initialize Claw** (Claw host / Both) — pick an auth choice from the cards (Anthropic API key, OpenAI API key, OpenAI Codex OAuth, Google API key, Z.AI/GLM API key, Moonshot, Ollama, or any OpenAI/Anthropic-compatible custom endpoint), pick or type a **provider-prefixed** model ref (`anthropic/claude-sonnet-4-6`, `openai/gpt-5.5`, `ollama/qwen3.5:27b`, etc.), optionally **Test connection** (we hit the provider's models endpoint to verify the key works), then **Run openclaw onboard**. We shell out to `openclaw onboard --non-interactive --auth-choice <id> --skip-bootstrap --skip-health --accept-risk` with your key injected as the documented env var (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`), then `openclaw models set <provider/model>` to pin the primary, then `openclaw status --deep` to verify. We never touch `agents.defaults.model.primary` or `models.providers.<id>` ourselves — OpenClaw is the source of truth for provider config writes, which means the installer stays compatible whenever OpenClaw changes its config shape.
- **Telegram bot** — validates the shared company bot token via `getMe`, shows the bot's `@username` back as confirmation. Shared by all roles.
- **Bind OpenClaw** (Claw host / Both) — writes `channels.telegram` into `~/.openclaw/openclaw.json` with `enabled: true`, the bot token, the user's chosen **DM policy** (`pairing` / `allowlist` / `open` / `disabled`), and a list of **numeric Telegram user IDs**. We pre-validate the IDs because OpenClaw's runtime silently drops `@usernames` and negative group chat IDs — the installer surfaces those errors before the gateway sees the bad config. A one-click **`openclaw doctor --fix`** is available to resolve `@usernames` left over from legacy config (which OpenClaw can map to user IDs via the bot API). Backs up the existing config.
- **Activate gateway** (Claw host / Both) — three actions in a single panel:
  - **Install daemon**: `openclaw gateway install` (LaunchAgent / systemd user unit / Windows Scheduled Task with Startup-folder fallback) so the gateway survives reboot.
  - **Restart only**: `openclaw gateway restart` for setups managing the daemon elsewhere.
  - **Diagnose**: `openclaw doctor` and `openclaw status --deep`.

  When `dmPolicy: "pairing"` is in use, a Pairing approval panel **auto-polls** `openclaw pairing list telegram --json` every 5 seconds while the panel is visible (with a plaintext-parser fallback for older OpenClaw versions) and lets the user approve incoming codes inline, mirroring `openclaw pairing approve telegram <code>`. The auto-poll pauses when the window is in the background and stops when the user leaves the step or unchecks the toggle.
- **Find your chat** (Claude side / Both) — calls `getUpdates` and lists every chat the bot has seen so the user picks theirs; manual chat-ID fallback always available.
- **Install bridge** (Claude side / Both) — unpacks `company-claw-bridge.mcpb` into `~/.company-claw-bridge/bundle/` and registers it under `mcpServers.company-claw-bridge` in `claude_desktop_config.json` with env vars pre-filled. Backs up existing config. If a previous install is detected, an "Update bundle (keep my settings)" shortcut re-unpacks the latest bundle on top while preserving the env block, so users don't have to re-enter their bot token after upgrades.
- **Smoke test** (Claude side / Both) — sends `[req:setup-XXXX] /ping` through the Telegram chat and long-polls for a reply for up to 45 s. We use OpenClaw's built-in `/ping` command (replies `pong` without burning model tokens) so the test works on a brand-new install where the user hasn't even configured a provider yet. Reports round-trip time or a precise diagnostic (gateway not running / not in `allowFrom` / pending pairing approval).
- **Finish** — role-specific outro screen with next steps and a "Show config in file browser" button. The Claude-side Done screen also offers:
  - **Install for Claude Code** — registers the unpacked bundle as a Claude Code plugin at user scope. Tries `claude plugin install <dir>` first; falls back to a direct write of `~/Library/Application Support/Claude/code/plugins.json` (macOS) / `%APPDATA%\Claude\code\plugins.json` (Windows) when the CLI isn't on PATH.
  - **macOS quarantine card** (macOS only) — one-liner to unstick Gatekeeper if the installer was blocked.
  - **Telemetry toggle** — opt-in only; persists to `~/.company-claw-bridge/telemetry.json`. Off by default.

The sidebar shows only the steps for the chosen role, and a "Start over" link at the bottom lets the user switch roles without quitting the app (token is remembered).

## What it does NOT do

- It does not install Claude Desktop, Node, or the OpenClaw CLI itself. It only links out to
  the canonical install pages and re-checks after the user's installed them.
- It does not modify any OpenClaw config beyond `channels.telegram`. Other Gateway settings
  are left alone.
- It does not write the bot token to disk on the employee's machine outside of
  `claude_desktop_config.json` (which Claude Desktop itself already trusts with secrets).

## Architecture

| Path                          | Purpose                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `main/main.ts`                | Electron main process bootstrap + window.                       |
| `main/ipcHandlers.ts`         | Registers all IPC handlers, composes the lower-level modules.   |
| `main/detect.ts`              | Cross-platform detection for Claude Desktop, openclaw, bundle.  |
| `main/telegram.ts`            | Minimal Telegram Bot API client (getMe, getUpdates, sendMessage).|
| `main/claudeConfig.ts`        | Reads/writes `claude_desktop_config.json`, atomic with backup.  |
| `main/openclawConfig.ts`      | Reads/writes `~/.openclaw/openclaw.json`, runs `openclaw doctor`.|
| `main/bundle.ts`              | Unpacks `company-claw-bridge.mcpb` into the install dir.        |
| `main/smokeTest.ts`           | End-to-end probe through Telegram + long-poll for reply.        |
| `preload/preload.ts`          | Exposes `window.api` via contextBridge.                         |
| `shared/ipc.ts`               | Types + channel name constants shared by main, preload, renderer.|
| `renderer/index.html`         | Wizard markup, one `<section class="step">` per step.           |
| `renderer/styles.css`         | Dark theme, sidebar nav, cards, diagram, terminal blocks.       |
| `renderer/app.js`             | Wizard state machine, talks to `window.api`.                    |
| `build-resources/icon.png`    | App icon (1024x1024).                                           |

## Build

Requires Node 20+ and `npm`. First make sure the bridge `.mcpb` exists at the repo root
(`../company-claw-bridge.mcpb`):

```bash
cd ..
npm install && npm run pack   # produces company-claw-bridge.mcpb
cd installer
```

Then:

```bash
npm install
npm run build         # tsc -> dist/main + dist/preload
npm test              # ~22 fast unit tests against the IPC + helpers
npm start             # launch the wizard locally without packaging
```

To produce distributable installers:

```bash
npm run dist:mac      # .dmg for both x64 and arm64
npm run dist:win      # .exe (NSIS) for x64. Cross-builds from macOS or Linux via the
                      # bundled wine that electron-builder fetches automatically. The
                      # resulting `Lunace Tether Setup Setup <ver>.exe` embeds
                      # `company-claw-bridge.mcpb` under `resources/`.
npm run dist          # current platform's targets
```

Output lands in `out/`. On macOS the produced DMG is unsigned/ad-hoc-signed; for distribution
you'll want to set `CSC_LINK` + `CSC_KEY_PASSWORD` env vars per
[electron-builder code-signing docs](https://www.electron.build/code-signing) and provide an
Apple Developer ID. Similarly for Windows you'll want a code-signing cert.

## Where files end up on the user's machine

| Item                              | macOS                                                                        | Windows                                                |
| --------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| App                               | `/Applications/Lunace Tether Setup.app`                                      | `%LOCALAPPDATA%\Programs\lunace-tether-setup`         |
| Unpacked bridge bundle            | `~/.company-claw-bridge/bundle/`                                             | same                                                   |
| Bridge state (update watermark, pending requests) | `~/.company-claw-bridge/state.json`                          | same                                                   |
| Claude Desktop config we edit     | `~/Library/Application Support/Claude/claude_desktop_config.json`            | `%APPDATA%\Claude\claude_desktop_config.json`          |
| OpenClaw config (on Gateway host only) | `~/.openclaw/openclaw.json`                                             | same (WSL2 home)                                       |

## Uninstall

Open `claude_desktop_config.json` and delete the `mcpServers.company-claw-bridge` entry, then
remove `~/.company-claw-bridge/` if you want to wipe state. Drag the installer app to the
trash. On Windows, use Add/Remove Programs.

## Windows specifics

The same wizard runs unchanged on Windows. A few things the installer takes care of internally that are worth knowing about:

| Concern                                  | What the installer does                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finding `openclaw` and `node`            | Walks `PATH` with the full `PATHEXT` (`.cmd`, `.exe`, `.bat`, `.ps1`) **and** also probes `%APPDATA%\npm`, `%ProgramFiles%\nodejs`, and `%ProgramFiles(x86)%\nodejs` so npm's global shim is found even if its bin dir isn't on PATH. |
| Launching the CLI                        | When `cliPath` ends in `.cmd`/`.bat`/`.exe`/`.com`/`.ps1` we spawn it directly (Node routes `.cmd`/`.bat` through `cmd.exe` automatically). For unusual setups without an extension we fall back to `shell: true`. All spawns set `windowsHide: true` so no terminal flashes appear. |
| Unpacking the `.mcpb`                    | Uses the .NET `[System.IO.Compression.ZipFile]::ExtractToDirectory` API via PowerShell (with `-ExecutionPolicy Bypass`). It doesn't care about the `.mcpb` extension, so there's no temp-`.zip` copy step. |
| Writing the Claude Desktop config        | Resolves an absolute path to `node.exe` and writes that into `mcpServers.company-claw-bridge.command` so Claude Desktop doesn't have to find Node on its own PATH (which on Windows can be tighter than the user's shell PATH). |
| Restarting the Gateway                   | `openclaw.cmd gateway restart` is dispatched the same way as on macOS; the only difference is the shim extension.                                                    |
| Config paths                             | Claude Desktop -> `%APPDATA%\Claude\claude_desktop_config.json`. OpenClaw -> `%USERPROFILE%\.openclaw\openclaw.json`. Backups go alongside with `.bak-<ts>` suffix. |

The packaged `.exe` is an NSIS installer with the "choose install location" page enabled and is per-user by default (`perMachine: false`).

## Notes

- The wizard only verifies the token / writes config; it does not push Claude Desktop to
  restart automatically. The user has to quit and relaunch Claude for the new MCP server entry
  to load.
- The OpenClaw bind step is meant to run on the Gateway host. Employees installing the bridge
  on their laptops should hit the "Skip — I'm an employee" button on that step.
- The smoke test is intentionally permissive: any non-self message from Claw's side counts as
  success. Semantic correctness ("Claw actually understood my task") is left to the user to
  validate in Claude Desktop afterward.
