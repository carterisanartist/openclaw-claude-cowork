# Company Claw Bridge

A bridge that turns the company's central [OpenClaw](https://openclaw.ai) assistant into a coworker
Claude can talk to. Claude **dispatches tasks** to Claw, **supervises** it, and **answers
escalations** Claw raises with `[ASK-CLAUDE]`. Transport is a shared company Telegram bot, so the
same Claw can be reached from any employee's machine without exposing the Gateway to the public
internet.

The bridge ships in two forms that share the same source tree:

- A **Claude Desktop MCPB extension** (`company-claw-bridge.mcpb`) per `manifest.json`.
- A **Claude Code plugin** (`.claude-plugin/plugin.json`) loadable via
  `claude --plugin-dir ./company-claw-bridge` or installed from a marketplace. The Claude Code
  manifest references the same `dist/index.js` MCP server, the same `user_config` keys, and the
  same Telegram-channel injection model.

Tools, env vars, and runtime are identical across both surfaces; the only difference is which
manifest the host application reads.

```
[Employee] -> [Claude Desktop] -> [MCPB plugin] -> [Telegram Bot API] -> [Company Claw on Telegram]
                                                                            |
                                            <- replies + [ASK-CLAUDE]s back -+
```

---

## What's in this repo

| Path                              | Purpose                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `manifest.json`                   | MCPB / Claude Desktop manifest (tools list, `user_config`, server entry).                               |
| `.claude-plugin/plugin.json`      | Claude Code plugin manifest (same MCP server, `userConfig`, `channels`, `${user_config.*}` substitution). |
| `server/index.ts`                 | MCP server entry: registers all tools, wires lifecycle.                                                 |
| `server/config.ts`       | Reads `user_config` values out of `process.env`.                        |
| `server/telegram.ts`     | Telegram Bot API client: `sendMessage`, long-polling `getUpdates`.      |
| `server/dispatcher.ts`   | Tags outbound messages, correlates replies, streams progress.           |
| `server/escalation.ts`   | Detects `[ASK-CLAUDE]`, exposes answer flow.                            |
| `server/supervise.ts`    | Thin wrappers over Claw chat commands (`/status`, `sessions_*`, etc).   |
| `server/audit.ts`        | Optional dev-mode mirror to a second Telegram chat.                     |
| `server/state.ts`        | On-disk state: `update_id` watermark, pending requests, escalations.    |
| `server/logger.ts`       | stderr-only structured logger.                                          |
| `scripts/build.sh`       | Compile TypeScript and pack into `company-claw-bridge.mcpb`.            |

---

## Setup at a glance

There are two machines to configure, and the **same installer app** handles both. On launch
it asks you which role this machine plays:

| Role                            | Run on…                                          | What it does                                                                                                                                          |
| ------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claw host**                   | The Mac mini / Windows box / server with OpenClaw | Binds the company Telegram bot to OpenClaw's `channels.telegram`, sets the DM allowlist, restarts the Gateway, runs `openclaw doctor`.                |
| **Claude side**                 | Each employee's laptop / workstation              | Verifies the shared bot token, auto-discovers the user's chat with the bot, installs the bridge into Claude Desktop's config, runs a smoke test.       |
| **Both on this machine**        | Dev / demo box running everything locally        | Runs the Claw-host setup, then the Claude-side setup, without re-asking for the token.                                                                 |

> ### Do the Claw host first
>
> The Claude-side install asks for two things the admin only produces during the Claw-host
> install: the **shared bot token** (from BotFather, plugged in during Step 2) and the
> **bot's @username** (printed at the end of Step 2). It also enforces the DM policy that
> was set on the Claw host — if `dmPolicy: "pairing"` is in effect, the employee can't
> reach Claw until the admin approves their pairing code.
>
> So the order is non-negotiable:
>
> 1. **Admin** creates the shared bot in Telegram, runs the installer on the OpenClaw
>    host in **Claw host** mode, and at the Done screen copies down: bot token, bot
>    @username, and which `dmPolicy` they picked.
> 2. **Admin** distributes those three things to every employee through whatever
>    channel you already trust for secrets (1Password, Bitwarden, a pinned message in
>    an internal channel — anything but plain email).
> 3. **Employee** runs the same installer on their own laptop in **Claude side** mode,
>    pastes the token, lets the wizard auto-discover their chat ID, and — if you went
>    with `pairing` — pings the admin for approval after their first DM to the bot.
>
> Running the wizards in the other order doesn't *break* anything (Claude side will
> just sit at "Smoke test failed: getMe rejected the token" until the admin produces
> one), but it wastes both people's time.

### Step 1 — Admin: create the shared bot

1. In Telegram, talk to [`@BotFather`](https://t.me/BotFather) and run `/newbot`.
2. Pick a name and username (e.g. `@CompanyClawBot`).
3. Save the bot token BotFather returns — this is the `telegram_bot_token` you'll hand out.
4. Recommended: in BotFather, run `/setprivacy` and **Disable** group privacy (only matters if
   you'll use Claw in group chats).

### Step 2 — Admin: run the installer on the OpenClaw host (Claw host mode)

1. Download `Company Claw Bridge Setup-<version>.dmg` (macOS) or
   `Company Claw Bridge Setup Setup <version>.exe` (Windows) onto the box that runs
   OpenClaw.
2. Launch the installer and pick **"This machine runs OpenClaw"**.
3. Wizard:
   1. **Prerequisites** — confirms `openclaw` is on PATH and Node 22.19+ (24 recommended) is
      available; per OpenClaw's own runtime requirements.
   2. **Initialize Claw** — pick an auth choice from the cards (Anthropic API key, OpenAI API
      key, OpenAI Codex OAuth, Google API key, Z.AI/GLM, Moonshot, Ollama, or any custom
      OpenAI/Anthropic-compatible endpoint), pick or type a provider-prefixed model ref
      (e.g. `anthropic/claude-sonnet-4-6`), optionally hit **Test connection** to probe
      the provider, then **Run openclaw onboard**. Under the hood we spawn
      `openclaw onboard --non-interactive --auth-choice <id> --skip-bootstrap --skip-health`
      with your API key injected via the documented env var, then `openclaw models set
      <provider/model>` to pin the default, then `openclaw status --deep` to confirm health.
      OpenClaw is the source of truth for the config write — we never touch
      `agents.defaults.model.primary` or `models.providers.<id>` ourselves.
   3. **Telegram bot** — paste the bot token; `getMe` confirms it.
   4. **Bind OpenClaw** — pick a **DM policy** (`pairing` / `allowlist` / `open` / `disabled`)
      and paste a comma-separated list of **numeric Telegram user IDs** allowed to DM the bot
      (or `*` for the `open` policy). Per OpenClaw's own contract, `@username` entries are
      silently dropped at runtime, so the installer rejects them up front and links you to the
      ID-discovery options (`openclaw logs --follow`, `getUpdates`). Writes
      `channels.telegram.{enabled: true, botToken, allowFrom, dmPolicy}` into
      `~/.openclaw/openclaw.json` with a timestamped backup. A "Run `openclaw doctor --fix`"
      escape hatch is one click away if pre-existing config needs cleanup.
   5. **Activate gateway** — three side-by-side actions:
      - **Install daemon** runs `openclaw gateway install`, registering the gateway as a
        macOS LaunchAgent, Linux systemd user unit, or Windows Scheduled Task (with a
        per-user Startup-folder fallback) so it survives reboot.
      - **Restart only** runs `openclaw gateway restart` for setups that manage the daemon
        elsewhere.
      - **Diagnose** runs `openclaw doctor` and `openclaw status --deep` so you can verify
        health without dropping into a terminal.

      If you picked `dmPolicy: "pairing"`, a **Pairing approval** panel appears: it polls
      `openclaw pairing list telegram` and lets you approve incoming codes inline with a
      single click (equivalent to `openclaw pairing approve telegram <code>`).
   6. **Done** — copy down three things and send them to every employee through your usual
      secrets channel:
      - the **bot token** (sensitive — treat it like a password),
      - the **bot @username** so employees know who to DM to start a chat,
      - the **DM policy** you picked (`pairing` / `allowlist` / `open` / `disabled`) so
        employees know what to expect on first contact, and so anyone on `pairing` knows
        to ping you for approval after their first DM.

### Step 3 — Employee: run the installer on each laptop (Claude side mode)

**Before you start, get these three things from your admin** (they're produced by Step 2
above): the **bot token**, the **bot @username**, and the **DM policy** the admin picked.
If the policy is `pairing`, you'll also need to flag the admin after your first DM so
they can approve your pairing code on the Claw host.

1. Download the same installer.
2. Launch it and pick **"This machine runs Claude Desktop"**.
3. Wizard:
   1. **Prerequisites** — confirms Claude Desktop, Node 20+ (24 recommended), and the bundled
      `.mcpb` are there.
   2. **Telegram bot** — paste the same shared token.
   3. **Find your chat** — tells you to DM the bot, then auto-discovers your chat ID via
      `getUpdates`. Manual paste also works.
   4. **Install bridge** — unpacks the `.mcpb` into `~/.company-claw-bridge/bundle/` and
      registers it in `claude_desktop_config.json` under `mcpServers.company-claw-bridge` with
      all env vars pre-filled (token, chat ID, optional audit chat, timeout, marker). The
      `command` is pinned to the absolute path of the Node binary we detected, so Claude
      Desktop's own PATH (which omits `%APPDATA%\npm` on Windows) can't break the spawn.
   5. **Smoke test** — sends a tagged probe through Telegram and waits up to 45 s for any
      reply, reports round-trip time.
   6. **Done** — restart Claude Desktop, open a new conversation, and run:
      `"Use the claw_health tool and show me what came back."`

To build the installer yourself, see [`installer/README.md`](installer/README.md).

### Use in Claude Code (alternative to Claude Desktop)

The same bundle is also a Claude Code plugin. Two ways to load it:

```bash
# Local checkout, ad-hoc:
claude --plugin-dir /path/to/company-claw-bridge

# Or pin a .zip artifact (Claude Code v2.1.128+):
claude --plugin-dir /path/to/company-claw-bridge.zip
```

Claude Code reads `.claude-plugin/plugin.json`, prompts for the `userConfig` values (bot token
is marked `sensitive` so it lands in the system keychain), spawns the MCP server with
`${user_config.*}` substituted into env, and exposes all `claw_*` tools the same way Claude
Desktop does. For marketplace distribution, see
[code.claude.com/docs/en/plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces).

### Manual fallback (no installer)

If you'd rather understand exactly what gets written where, you can skip the installer:

**On the OpenClaw host** — run OpenClaw's own onboarding:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon         # interactive: provider, channels, daemon, health
# or non-interactive, e.g. Anthropic + Telegram:
ANTHROPIC_API_KEY=sk-… openclaw onboard --non-interactive \
  --auth-choice anthropic-api-key \
  --accept-risk \
  --install-daemon
openclaw models set anthropic/claude-sonnet-4-6
```

Then edit `~/.openclaw/openclaw.json` to add the Telegram allowlist:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:AAH…",
      dmPolicy: "pairing",       // safest; first DM yields a code to approve
      allowFrom: ["123456789"],  // numeric user IDs only; @usernames are dropped
    },
  },
}
```

Then `openclaw gateway restart && openclaw status --deep`. When the first employee DMs the
bot, run `openclaw pairing list telegram` and `openclaw pairing approve telegram <code>`.

**On the Claude side** —

1. DM the bot in Telegram (`/start`) so it has seen you.
2. Discover your `claw_chat_id` by opening
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copying `message.chat.id` from the
   most recent update where `from.id` matches your account.
3. In Claude Desktop, **Settings -> Extensions -> Advanced settings -> Install Extension…**
   and pick `company-claw-bridge.mcpb`.
4. Paste the shared bot token and your chat ID. Leave the rest at defaults.
5. New Claude conversation: "Run the claw_health tool and tell me what came back." Expect
   `healthy: true`.

---

## What Claude can do

Once installed, Claude has these tools:

### Dispatch

| Tool                  | Purpose                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| `claw_dispatch`       | Send a task to Claw and wait for the full reply. Supports `/think` levels.  |
| `claw_dispatch_async` | Fire-and-forget; returns a `request_id`.                                    |
| `claw_poll`           | Read partial progress for an async dispatch.                                |
| `claw_cancel`         | Cancel an in-flight async dispatch (sends `/reset` to Claw).                |

### Supervise

| Tool                     | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `claw_status`            | Run Claw's `/status`.                                  |
| `claw_health`            | Round-trip probe with timing.                          |
| `claw_list_sessions`     | `sessions_list`.                                       |
| `claw_session_history`   | `sessions_history`.                                    |
| `claw_send_to_session`   | `sessions_send`.                                       |
| `claw_set_verbosity`     | Toggle `/verbose`, `/trace`, `/usage`.                 |
| `claw_compact`           | `/compact` to trim Claw's session context.             |
| `claw_new_session`       | `/new`.                                                |
| `claw_restart`           | `/restart`.                                            |

### Escalations (the feedback loop)

| Tool                       | Purpose                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| `claw_check_escalations`   | List `[ASK-CLAUDE]` questions Claw has raised and not yet answered.    |
| `claw_answer_escalation`   | Post Claude's answer back as `[CLAUDE-REPLY:<id>]`.                    |

When `claw_dispatch` returns with `escalated: true`, the tool result contains the
`escalation_id` and `escalation_question`. Claude is expected to answer it with
`claw_answer_escalation` so Claw can continue.

---

## How the wire format works

Every outbound message is prefixed with `[req:<id>] ` (8 alphanumeric chars) so the bridge can
match Claw's reply back to the originating dispatch even when several dispatches overlap. If
Claw doesn't echo the tag, the bridge falls back to FIFO matching: the next non-self reply
in the chat that arrives after the send.

Escalations Claw wants Claude to answer must be prefixed with the configured marker (default
`[ASK-CLAUDE]`):

```
[ASK-CLAUDE][req:abc12345] Should I prefer vitest or jest for the new package?
```

The bridge strips the marker, mints an `escalation_id`, and surfaces it on the dispatch
result. Claude's answer goes back as:

```
[CLAUDE-REPLY:9af3c1e] Use vitest. See docs/testing.md.
```

You can teach Claw to use the marker in its system prompt / `AGENTS.md`:

> When you are stuck and need help from your supervisor, reply with a single message that
> starts with `[ASK-CLAUDE]` followed by the question. Wait for a reply prefixed with
> `[CLAUDE-REPLY:<id>]` before continuing.

---

## Dev mirror

During development it's handy to watch every Claude<->Claw message in a dedicated Telegram
channel without polluting the main thread.

1. Create a new Telegram channel/group, add the bot to it as an admin.
2. Find its chat id (negative number like `-1001234567890`) the same way as above.
3. In the extension settings:
   - Set "Audit chat ID (dev mirror)" to that id.
   - Tick "Dev mirror enabled".
4. Every outbound and inbound message will be mirrored with a small header
   (`OUT req=...`, `IN msg=...`, `ANSWER esc=...`).

Flip "Dev mirror enabled" off in production. No restart needed for Claude Desktop to pick the
new value up — the extension is respawned per session.

---

## Building from source

Requires Node 20+ and `npm`.

```bash
npm install
npm run pack     # runs scripts/build.sh -> company-claw-bridge.mcpb
npm test         # runs the node:test suite (~15 tests, ~13s)
```

The build script:
1. Cleans previous artifacts.
2. Ensures local `node_modules/` is present (no destructive prune).
3. Compiles TypeScript to `dist/`.
4. Assembles an isolated pack tree under `build/pack-tree/` with only the
   files we want shipped (dist, server sources, manifests, README).
5. Runs `npm install --omit=dev --ignore-scripts` *inside* the pack tree so
   the bundle ships production-only deps without disturbing the dev tree.
6. Runs `mcpb pack` against the isolated tree.
7. Removes the pack tree.

The result is `company-claw-bridge.mcpb` (~3 MB) containing both
`manifest.json` (Claude Desktop) and `.claude-plugin/plugin.json`
(Claude Code), so the same artifact works in both hosts.

To rebuild the cross-platform installer:

```bash
cd installer
npm install
npm test         # ~22 fast unit tests on the IPC + helpers
npm run dist:mac # -> installer/out/*.dmg
npm run dist:win # -> installer/out/*.exe (NSIS)
```

---

## Troubleshooting

| Symptom                                       | Likely cause + fix                                                   |
| --------------------------------------------- | -------------------------------------------------------------------- |
| Extension shows "failed to start"             | Bot token is missing or wrong. Recheck in extension settings.        |
| `claw_health` returns `healthy: false`        | Claw isn't bound to your DM yet, or your `claw_chat_id` is wrong.    |
| Dispatches hang then time out                 | Claw is offline. SSH to the Gateway host and check `openclaw gateway status`. |
| Bridge replies with the wrong Claw output     | A long-running dispatch overlapped a fresh one and the FIFO fallback picked the wrong reply. Have Claw echo the `[req:]` tag in its replies; the bridge will hard-match. |
| `[ASK-CLAUDE]` messages never become escalations | Confirm the marker matches the `escalation_marker` user_config field; Claw must use the exact same string. |
| Logs are noisy                                | Set the `LOG_LEVEL` env var via the manifest's `env` block (`debug`, `info`, `warn`, `error`). |

State lives under `~/.company-claw-bridge/` by default. The directory contains three files:

- `state.json` — pending requests, escalations, outbound retry queue.
- `watermark.json` — Telegram `update_id` watermark only.
- `.lock` — PID + start-time sentinel for the cross-process lock.

Safe to delete the whole directory to reset everything. The bridge will
re-create what it needs on next start. (If you delete only `.lock`, you must
make sure no bridge instance is actually still running first.)

---

## Reliability features

The bridge is designed for unattended deployments where a single shared bot
ferries traffic for many employees. Things that matter when nobody's watching:

- **At-startup poll loop.** The Telegram long-poll starts the moment the
  bridge connects to its MCP host (not lazily on the first dispatch). This
  means proactive `[ASK-CLAUDE]` escalations Claw raises before any tool
  call still land in `claw_check_escalations`, and Telegram's 24h update
  retention window can't silently drop messages because we were "idle".
- **Cross-process lock.** A `.lock` sentinel under `STATE_DIR` makes sure
  two bridge instances (e.g. installed in both Claude Code and Claude
  Desktop) can't race each other for `getUpdates` (only one consumer of a
  long-poll wins; the other silently misses messages). The second instance
  fails fast with the offending PID and start time.
- **Split, debounced, atomic state files.** `state.json` (pending requests,
  escalations, outbound queue) is flushed on a 250 ms debounce. The
  Telegram update watermark lives separately in `watermark.json` on a 500
  ms debounce, so a busy poll loop doesn't keep rewriting your queue.
  All writes are `open(O_WRONLY)` -> `writeFile` -> `fsync` -> `rename`
  for crash-safety.
- **At-least-once delivery.** The Telegram watermark advances *after* all
  listeners process an update, not before. A hard crash mid-listener
  replays the in-flight update on next start; the dispatcher's tagged
  matching makes that idempotent.
- **Tagged + quiet-window correlation.** The dispatcher prefers
  recently-hard-matched resolvers for untagged streamed continuations, so
  Claw splitting a long answer across multiple messages doesn't get
  attributed to a later, unrelated dispatch under FIFO pressure.
- **Persisted /reset queue.** `claw_cancel` enqueues a `/reset` to Claw on
  an outbound queue and retries until it lands - so a temporary Telegram
  outage during cancellation can't leak a "stuck" Claw session.
- **Unattributed escalations.** When Claw raises `[ASK-CLAUDE]` without a
  recognizable tag, the bridge records it with `unattributed: true` so
  `claw_check_escalations` still surfaces it to Claude instead of dropping
  it on the floor.
- **Durable sync finalize.** Synchronous `claw_dispatch` writes its reply
  through to disk *before* resolving the promise, so a follow-up
  `claw_poll` from another tool call can never see an empty reply.
- **Optional startup health check.** Set `STARTUP_HEALTH_CHECK=true` to
  round-trip a `/status` through Claw at boot and get a clear
  "claw.startup_health_ok" or "claw.startup_health_failed" line in your
  MCP host log before any tool call.

## Security notes

- The shared bot token is stored in the OS keychain (`"sensitive": true` in the manifest).
- The bridge only delivers messages from the configured `claw_chat_id` to the dispatcher; other
  chats the bot is in are ignored.
- There is no inbound network path to the company Claw Gateway. The Gateway only needs
  outbound access to `api.telegram.org`.
- Every employee uses the same bot identity. If you need per-employee audit isolation,
  consider rotating to per-employee bots (each employee creates their own via BotFather and
  pastes their own token) — the manifest already supports it without code changes.
