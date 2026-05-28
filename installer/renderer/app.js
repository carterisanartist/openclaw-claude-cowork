// Renderer-side wizard. Talks to main via window.api.
// The first non-welcome step is the role chooser; after that the step list
// is computed from the chosen role so each role only sees the steps it needs.

const ROLE_STEPS = {
  "claw-host": [
    "welcome",
    "role",
    "prereqs",
    "init-claw",
    "token",
    "bind-openclaw",
    "restart-gateway",
    "done-claw",
  ],
  "claude-user": [
    "welcome",
    "role",
    "prereqs",
    "token",
    "chat",
    "install",
    "smoke",
    "done-claude",
  ],
  "both": [
    "welcome",
    "role",
    "prereqs",
    "init-claw",
    "token",
    "bind-openclaw",
    "restart-gateway",
    "chat",
    "install",
    "smoke",
    "done-claude",
  ],
};

const STEP_LABELS = {
  welcome: "Welcome",
  role: "Pick role",
  prereqs: "Prerequisites",
  "init-claw": "Initialize Claw",
  token: "Telegram bot",
  "bind-openclaw": "Bind OpenClaw",
  "restart-gateway": "Restart gateway",
  chat: "Your chat",
  install: "Install bridge",
  smoke: "Smoke test",
  "done-claw": "Finish",
  "done-claude": "Finish",
};

const state = {
  role: null,                // "claw-host" | "claude-user" | "both" | null
  steps: ["welcome", "role"], // initial; replaced after role selection
  index: 0,
  detect: null,
  token: "",
  botInfo: null,
  chatId: "",
  chatName: "",
  bridgeInstalled: false,
  gatewayBound: false,
  gatewayRestarted: false,
  bindDmPolicy: "pairing",   // "pairing" | "allowlist" | "open" | "disabled"
  clawInitialized: false,
  clawProvider: null,        // ClawProviderId, see installer/shared/ipc.ts
  clawModel: "",             // always provider-prefixed, e.g. "anthropic/claude-sonnet-4-6"
  clawApiKey: "",
  clawBaseUrl: "",           // for ollama / custom-api-key
  clawCustomCompat: "openai",// for custom-api-key
};

const el = {
  panels: document.querySelectorAll(".step"),
  stepsList: document.getElementById("steps-list"),
  navBack: document.getElementById("nav-back"),
  navNext: document.getElementById("nav-next"),
  restartWizard: document.getElementById("restart-wizard"),
  brandSub: document.getElementById("brand-sub"),
};

// ---------- Sidebar + navigation ----------

function renderSidebar() {
  el.stepsList.innerHTML = "";
  state.steps.forEach((stepId, idx) => {
    const li = document.createElement("li");
    li.dataset.step = stepId;
    if (idx === state.index) li.classList.add("active");
    if (idx < state.index) li.classList.add("done");
    li.innerHTML = `<span class="dot"></span><span class="name">${STEP_LABELS[stepId] ?? stepId}</span>`;
    el.stepsList.appendChild(li);
  });
  if (state.role) {
    el.brandSub.textContent = roleLabel(state.role);
    el.restartWizard.hidden = false;
  } else {
    el.brandSub.textContent = "Setup";
    el.restartWizard.hidden = true;
  }
}

function roleLabel(role) {
  return {
    "claw-host": "Claw host mode",
    "claude-user": "Claude side mode",
    "both": "Both on this machine",
  }[role];
}

function currentStep() {
  return state.steps[state.index];
}

function render() {
  const step = currentStep();
  el.panels.forEach((panel) => {
    panel.hidden = panel.dataset.step !== step;
  });
  renderSidebar();

  const isFirst = state.index === 0;
  const isLast = state.index === state.steps.length - 1;
  const nextStep = state.steps[state.index + 1];

  // Back is only meaningful once we're past welcome. On the role chooser we
  // allow Back so the user can return to Welcome to re-read the intro.
  el.navBack.hidden = isFirst;

  // Hide Next on screens whose only forward action is a custom button
  // inside the panel itself:
  //   - welcome: has its own "Get started" button
  //   - role: advancing happens by clicking a role card
  //   - done-*: terminal screen, has its own Close button
  const hideNext = isLast || step === "welcome" || step === "role";
  el.navNext.hidden = hideNext;
  el.navNext.disabled = !canAdvance();

  // Label the Next button based on what the *next* step actually is.
  if (nextStep && (nextStep === "done-claw" || nextStep === "done-claude")) {
    el.navNext.textContent = "Finish setup →";
  } else {
    el.navNext.textContent = "Continue →";
  }
}

function canAdvance() {
  switch (currentStep()) {
    case "welcome": return true;
    case "role": return state.role !== null;
    case "prereqs": return state.detect !== null && prereqsBlocking() === false;
    case "init-claw": return state.clawInitialized;
    case "token": return state.botInfo !== null;
    case "bind-openclaw": return state.gatewayBound;
    case "restart-gateway": return state.gatewayRestarted;
    case "chat": return state.chatId.length > 0;
    case "install": return state.bridgeInstalled;
    case "smoke": return true; // skippable
    default: return true;
  }
}

/**
 * Are there missing prerequisites the user must fix before they can move on?
 * For Claw-host or Both roles, OpenClaw CLI being absent is a hard block - we
 * can't drive Claw without it. For Claude-side, the bundle being absent is the
 * hard block. Everything else (Node, Claude Desktop) we warn about and let the
 * user proceed because we can't reliably detect Node from inside Electron and
 * the user may just need to launch Claude Desktop once after install.
 */
function prereqsBlocking() {
  const d = state.detect;
  if (!d) return true;
  if (state.role === "claude-user" || state.role === "both") {
    if (!d.bridgeBundle.exists) return true;
    // Bridge must run under Node 20+. OpenClaw recommends Node 24 (or 22.19+
    // for compatibility), and the gateway requires Node for Telegram /
    // WhatsApp channel plugins. We hard-block on < 20 (the bridge minimum)
    // and surface a warning, not a block, for 20-21.
    if (!d.node.installed) return true;
    if (d.node.major !== null && d.node.major < 20) return true;
  }
  if (state.role === "claw-host" || state.role === "both") {
    if (!d.openclaw.installed) return true;
    // Claw-host scenarios specifically need Node 22.19+ or 24+ for the
    // gateway to run Telegram/WhatsApp channel plugins reliably per
    // docs.openclaw.ai. If Node is missing on a Claw host, block.
    if (!d.node.installed) return true;
    if (d.node.major !== null && d.node.major < 20) return true;
  }
  return false;
}

function go(deltaOrStep) {
  if (typeof deltaOrStep === "string") {
    const i = state.steps.indexOf(deltaOrStep);
    if (i >= 0) state.index = i;
  } else {
    state.index = Math.max(0, Math.min(state.steps.length - 1, state.index + deltaOrStep));
  }
  render();
  onEnterStep(currentStep());
}

el.navBack.addEventListener("click", () => go(-1));
el.navNext.addEventListener("click", () => go(+1));
el.restartWizard.addEventListener("click", () => {
  // Wipe most state but keep verified token + Claw provider config so the
  // user doesn't have to re-enter secrets they already validated.
  state.role = null;
  state.steps = ["welcome", "role"];
  state.index = 0;
  state.bridgeInstalled = false;
  state.gatewayBound = false;
  state.gatewayRestarted = false;
  state.chatId = "";
  state.chatName = "";
  render();
});

document.querySelectorAll(".external").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const url = a.getAttribute("data-url");
    if (url) window.api.openExternal(url);
  });
});

document.getElementById("welcome-go").addEventListener("click", () => go(+1));

// ---------- Role chooser ----------

document.querySelectorAll(".role").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".role").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    state.role = btn.getAttribute("data-role");
    state.steps = ROLE_STEPS[state.role].slice();
    // Auto-advance the moment a role is picked - it's a clear commitment.
    state.index = state.steps.indexOf("prereqs");
    render();
    onEnterStep("prereqs");
  });
});

// ---------- Step entry hooks ----------

async function onEnterStep(step) {
  // Don't leak stale results from a previous visit. Only hide visible ones;
  // the prepare hooks below may populate fresh ones.
  document
    .querySelectorAll(`.step[data-step="${step}"] .result`)
    .forEach((el) => {
      if (!el.classList.contains("sticky")) el.hidden = true;
    });
  // Auto-poll lifecycle: only run pairing polling while the user is actually
  // looking at the Activate Gateway screen.
  if (step !== "restart-gateway") stopPairingAutoPoll();
  if (step === "prereqs") return runPrereqs();
  if (step === "chat") return prepareChatStep();
  if (step === "install") return prepareInstallStep();
  if (step === "bind-openclaw") return prepareBindStep();
  if (step === "init-claw") return prepareInitClawStep();
  if (step === "restart-gateway") return prepareRestartStep();
  if (step === "done-claude") return prepareDoneClaudeStep();
}

function prepareRestartStep() {
  syncPairingVisibility();
  // Kick off auto-poll automatically when this step opens and the policy is
  // pairing. If the user later unchecks the autopoll box we stop, but the
  // default is "yes please, save me the clicks".
  if (state.bindDmPolicy === "pairing") startPairingAutoPoll();
}

// ---------- Prereqs (role-aware) ----------

function buildPrereqRows() {
  const role = state.role;
  const rows = [];
  if (role === "claude-user" || role === "both") {
    rows.push({
      id: "claude",
      name: "Claude Desktop",
      detail: "Looking for the Claude app and its config…",
    });
    rows.push({
      id: "bundle",
      name: "Bridge bundle",
      detail: "The `.mcpb` file shipped with this installer.",
    });
  }
  // Node is required on both sides: the bridge needs it (Claude side) and
  // the OpenClaw gateway / channel plugins need it (Claw host).
  rows.push({
    id: "node",
    name: "Node.js 20+ (24 recommended)",
    detail:
      role === "claw-host"
        ? "OpenClaw's gateway and Telegram channel plugin run on Node. The docs recommend Node 24, with 22.19+ as the compatibility floor."
        : "Claude Desktop spawns the bridge with `node`. OpenClaw recommends Node 24 or 22.19+ across both sides for consistency.",
  });
  if (role === "claw-host" || role === "both") {
    rows.push({
      id: "openclaw",
      name: "OpenClaw CLI",
      detail: "Required on the machine hosting the company Claw Gateway.",
    });
  }
  return rows;
}

function renderPrereqRows() {
  const host = document.getElementById("prereqs-checks");
  host.innerHTML = "";
  const rows = buildPrereqRows();
  for (const row of rows) {
    const wrap = document.createElement("div");
    wrap.className = "check";
    wrap.dataset.id = row.id;
    wrap.innerHTML = `
      <div class="check-status">…</div>
      <div class="check-body">
        <div class="check-name">${escapeHtml(row.name)}</div>
        <div class="check-detail">${escapeHtml(row.detail)}</div>
      </div>
      <div class="check-actions"></div>`;
    host.appendChild(wrap);
  }
}

async function runPrereqs() {
  const title = document.getElementById("prereqs-title");
  const lead = document.getElementById("prereqs-lead");
  if (state.role === "claw-host") {
    title.textContent = "Prerequisites — Claw host";
    lead.textContent = "We need the OpenClaw CLI on this machine to drive the Gateway.";
  } else if (state.role === "claude-user") {
    title.textContent = "Prerequisites — Claude side";
    lead.textContent = "We need Claude Desktop and Node so the bridge can run inside it.";
  } else {
    title.textContent = "Prerequisites — both";
    lead.textContent = "We need Claude Desktop, Node, and the OpenClaw CLI all on this machine.";
  }

  renderPrereqRows();
  const detect = await window.api.detect();
  state.detect = detect;

  if (document.querySelector(`.check[data-id="claude"]`)) {
    setCheck("claude", detect.claudeDesktop.installed ? "ok" : "err",
      detect.claudeDesktop.installed
        ? `Found at ${detect.claudeDesktop.appPath ?? "(default location)"}.`
        : "Not detected. Install Claude Desktop, then re-check.",
      detect.claudeDesktop.installed ? null : { label: "Install Claude Desktop", url: "https://claude.ai/download" },
    );
  }

  if (document.querySelector(`.check[data-id="node"]`)) {
    const n = detect.node;
    if (!n.installed) {
      setCheck("node", "err",
        "Not on PATH. OpenClaw recommends Node 24 (or Node 22.19+ for compatibility). Install it, then re-check.",
        { label: "Install Node", url: "https://nodejs.org/" },
      );
    } else if (n.major === null) {
      setCheck("node", "warn",
        `Found node at ${n.nodePath} but couldn't read its version. We need 20+ at minimum; 24 is recommended.`,
        { label: "Install Node", url: "https://nodejs.org/" },
      );
    } else if (n.major < 20) {
      setCheck("node", "err",
        `Found ${n.version} at ${n.nodePath}. We need Node 20+ to run the bridge and 22.19+ for the OpenClaw gateway.`,
        { label: "Install Node 24", url: "https://nodejs.org/" },
      );
    } else if (n.major < 22) {
      setCheck("node", "warn",
        `Found ${n.version} at ${n.nodePath}. This works for the bridge but OpenClaw recommends 22.19+ (24 ideal) for the gateway. You can proceed.`,
        { label: "Install Node 24", url: "https://nodejs.org/" },
      );
    } else {
      setCheck("node", "ok",
        `Found ${n.version} at ${n.nodePath}.`,
        null,
      );
    }
  }

  if (document.querySelector(`.check[data-id="bundle"]`)) {
    setCheck("bundle",
      detect.bridgeBundle.exists ? "ok" : "err",
      detect.bridgeBundle.exists
        ? `Bundle ready at ${detect.bridgeBundle.bundlePath}.`
        : "Bridge .mcpb not found inside the installer. Rebuild the installer.",
      null,
    );
  }

  if (document.querySelector(`.check[data-id="openclaw"]`)) {
    const oc = detect.openclaw;
    if (!oc.installed) {
      setCheck("openclaw", "err",
        "Not on PATH. Install with: npm install -g openclaw@latest",
        { label: "Install OpenClaw", url: "https://docs.openclaw.ai/start/getting-started" },
      );
    } else {
      const parts = [];
      parts.push(`Found ${escapeHtml(oc.version ?? "openclaw")} at ${escapeHtml(oc.cliPath ?? "")}.`);
      if (oc.configExists) {
        parts.push(`<strong>Existing install detected</strong> at <span class="mono">${escapeHtml(oc.configPath)}</span>:`);
        const bullets = [];
        if (oc.defaultProvider) {
          bullets.push(
            `default model: <span class="mono">${escapeHtml(oc.defaultProvider)}/${escapeHtml(oc.defaultModel ?? "?")}</span>` +
              (oc.existingProviders.length > 1
                ? ` (configured providers: ${escapeHtml(oc.existingProviders.join(", "))})`
                : ""),
          );
        } else if (oc.existingProviders.length > 0) {
          bullets.push(`providers configured but no default set: <span class="mono">${escapeHtml(oc.existingProviders.join(", "))}</span>`);
        } else {
          bullets.push("no LLM providers configured yet");
        }
        if (oc.telegramConfigured) {
          if (oc.telegramBotTokenSet) {
            bullets.push(
              `Telegram channel already bound to bot <span class="mono">${escapeHtml(oc.telegramBotTokenPreview ?? "(set)")}</span>` +
                (oc.telegramAllowFrom.length > 0
                  ? `, allowlist: ${escapeHtml(oc.telegramAllowFrom.join(", "))}`
                  : ", but no allowlist"),
            );
          } else {
            bullets.push("Telegram channel present but no bot token set");
          }
        } else {
          bullets.push("Telegram channel not configured");
        }
        if (oc.gatewayRunning === true) {
          bullets.push("gateway daemon is <strong>running</strong>");
        } else if (oc.gatewayRunning === false) {
          bullets.push("gateway daemon is <strong>not running</strong> (we'll restart it after Bind)");
        }
        parts.push(`<ul class="check-list">${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>`);
        parts.push(`<em>The installer only adds or updates what's missing — existing settings are preserved with a timestamped backup before any write.</em>`);
      } else {
        parts.push("No existing <code>openclaw.json</code> yet — this looks like a fresh install. We'll create one in the next steps.");
      }
      setCheckHtml("openclaw", "ok", parts.join(" "), null);
    }
  }

  render();
}

function setCheck(id, status, detail, action) {
  setCheckHtml(id, status, escapeHtml(detail), action);
}

/**
 * Like setCheck, but assumes `html` is already a trusted HTML fragment.
 * Callers using this MUST escapeHtml() any untrusted data themselves.
 * This is used when we need to render structured data (bullet lists, code
 * spans, etc.) that the user can't influence directly beyond what we've
 * already sanitized.
 */
function setCheckHtml(id, status, html, action) {
  const root = document.querySelector(`.check[data-id="${id}"]`);
  if (!root) return;
  root.classList.remove("ok", "warn", "err");
  root.classList.add(status);
  const statusEl = root.querySelector(".check-status");
  statusEl.textContent = status === "ok" ? "✓" : status === "warn" ? "!" : "✗";
  root.querySelector(".check-detail").innerHTML = html;
  const actions = root.querySelector(".check-actions");
  actions.innerHTML = "";
  if (action) {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = action.label;
    btn.addEventListener("click", () => window.api.openExternal(action.url));
    actions.appendChild(btn);
  }
}

document.getElementById("prereqs-recheck").addEventListener("click", () => runPrereqs());

// ---------- Token ----------

const tokenInput = document.getElementById("token-input");
const tokenToggle = document.getElementById("token-toggle");
const tokenVerify = document.getElementById("token-verify");
const tokenResult = document.getElementById("token-result");

tokenToggle.addEventListener("click", () => {
  const showing = tokenInput.type === "text";
  tokenInput.type = showing ? "password" : "text";
  tokenToggle.textContent = showing ? "Show" : "Hide";
});
tokenInput.addEventListener("input", () => {
  state.botInfo = null;
  tokenResult.hidden = true;
  render();
});

tokenVerify.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (token.length === 0) return;
  tokenVerify.disabled = true;
  tokenResult.hidden = false;
  tokenResult.className = "result";
  tokenResult.innerHTML = `<span class="spinner"></span> Calling Telegram getMe…`;
  const res = await window.api.verifyToken({ token });
  tokenVerify.disabled = false;
  if (res.ok) {
    state.token = token;
    state.botInfo = res;
    tokenResult.className = "result ok";
    tokenResult.innerHTML =
      `<h4>Token verified</h4>
       <div>Bot: <strong>@${escapeHtml(res.username ?? "(no username)")}</strong> (${escapeHtml(res.firstName ?? "")}, id ${res.id}).</div>
       <div class="mono">Click Continue to proceed.</div>`;
  } else {
    state.botInfo = null;
    tokenResult.className = "result err";
    const adminHint = state.role === "claude-user"
      ? `<div class="mono" style="margin-top:8px">If you're on the Claude side, the token has to come from whoever set up the Claw host. Ping your admin and ask them to confirm the bot is created and gateway is running, then paste the token they give you.</div>`
      : "";
    tokenResult.innerHTML = `<h4>Couldn't verify token</h4><div>${escapeHtml(res.error ?? "Unknown error")}</div>${adminHint}`;
  }
  render();
});

// ---------- Initialize OpenClaw (claw-host / both) ----------

/**
 * Curated catalog keyed by ClawProviderId (matches installer/shared/ipc.ts).
 *
 * Model IDs are always provider-prefixed in the form OpenClaw expects
 * ("provider/model"), per docs.openclaw.ai/models. The picker stores them
 * verbatim; the main process passes the same string to `openclaw models set`.
 *
 * Picks are based on OpenClaw's own documentation examples and the
 * recommended-policy guidance ("strongest latest-generation model available").
 * The user can always type a custom ref if they need something newer than
 * this catalog.
 */
const MODEL_CATALOG = {
  "anthropic-api-key": {
    models: [
      { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6 (recommended)" },
      { id: "anthropic/claude-opus-4-7", label: "Claude Opus 4.7 (deepest)" },
      { id: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6" },
    ],
    keyHint: "Get a key at console.anthropic.com → Settings → API Keys.",
    keyUrl: "https://console.anthropic.com/settings/keys",
    requiresKey: true,
    requiresBaseUrl: false,
  },
  "openai-api-key": {
    models: [
      { id: "openai/gpt-5.5", label: "GPT-5.5 (recommended)" },
      { id: "openai/gpt-5.4", label: "GPT-5.4" },
      { id: "openai/gpt-5.4-mini", label: "GPT-5.4 mini (cheaper)" },
    ],
    keyHint: "Get a key at platform.openai.com/api-keys.",
    keyUrl: "https://platform.openai.com/api-keys",
    requiresKey: true,
    requiresBaseUrl: false,
  },
  "openai-codex-oauth": {
    // Per docs.openclaw.ai/providers/openai, the Codex auth flow registers
    // the *openai/* family for use - not openai-codex/*. doctor --fix
    // actively rewrites legacy openai-codex/* refs back to openai/*. We
    // only offer the canonical refs here so we don't ship bait that the
    // gateway will silently rewrite under the user.
    models: [
      { id: "openai/gpt-5.5", label: "GPT-5.5 via Codex (recommended)" },
      { id: "openai/gpt-5.4", label: "GPT-5.4 via Codex" },
    ],
    keyHint:
      "Uses your ChatGPT subscription (no API key needed). We'll launch the OAuth flow when you click Run.",
    keyUrl: "https://platform.openai.com",
    requiresKey: false,
    requiresBaseUrl: false,
  },
  "gemini-api-key": {
    models: [
      { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (recommended)" },
      { id: "google/gemini-3.1-pro", label: "Gemini 3.1 Pro (alias)" },
      { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro (legacy)" },
    ],
    keyHint: "Get a key at aistudio.google.com/app/apikey.",
    keyUrl: "https://aistudio.google.com/app/apikey",
    requiresKey: true,
    requiresBaseUrl: false,
  },
  "zai-api-key": {
    models: [
      { id: "zai/glm-5.1", label: "GLM 5.1 (recommended, general API)" },
      { id: "zai/glm-4.6", label: "GLM 4.6" },
    ],
    keyHint: "Get a key at api.z.ai. For GLM Coding Plan endpoints, pick the Coding option in onboard.",
    keyUrl: "https://api.z.ai",
    requiresKey: true,
    requiresBaseUrl: false,
  },
  "moonshot-intl": {
    models: [
      { id: "moonshot/kimi-k2.6", label: "Kimi K2.6 (recommended)" },
      { id: "moonshot/kimi-k2.5", label: "Kimi K2.5" },
      { id: "moonshot/kimi-k2-thinking", label: "Kimi K2 Thinking" },
      { id: "moonshot/kimi-k2-turbo", label: "Kimi K2 Turbo (fast)" },
    ],
    keyHint: "International endpoint (api.moonshot.ai). Get a key at platform.moonshot.ai.",
    keyUrl: "https://platform.moonshot.ai",
    requiresKey: true,
    requiresBaseUrl: false,
  },
  "moonshot-cn": {
    models: [
      { id: "moonshot/kimi-k2.6", label: "Kimi K2.6 (recommended)" },
      { id: "moonshot/kimi-k2.5", label: "Kimi K2.5" },
      { id: "moonshot/kimi-k2-thinking", label: "Kimi K2 Thinking" },
      { id: "moonshot/kimi-k2-turbo", label: "Kimi K2 Turbo (fast)" },
    ],
    keyHint:
      "China endpoint (api.moonshot.cn). Pick this if your key was issued on platform.moonshot.cn — keys aren't fully cross-routable between intl and CN.",
    keyUrl: "https://platform.moonshot.cn",
    requiresKey: true,
    requiresBaseUrl: false,
  },
  ollama: {
    // Ollama tags depend on what the user has pulled locally. We only suggest
    // tags that exist on ollama.com today; the picker is editable so users
    // can type whatever model they actually pulled.
    models: [
      { id: "ollama/llama3.3:70b", label: "Llama 3.3 70B" },
      { id: "ollama/qwen2.5-coder:32b", label: "Qwen 2.5 Coder 32B" },
      { id: "ollama/gemma3:27b", label: "Gemma 3 27B" },
      { id: "ollama/deepseek-r1:32b", label: "DeepSeek-R1 32B (reasoning)" },
    ],
    keyHint: "Ollama serves locally at http://127.0.0.1:11434 by default — no key required.",
    keyUrl: "https://ollama.com/download",
    requiresKey: false,
    requiresBaseUrl: true,
  },
  "custom-api-key": {
    models: [],
    keyHint:
      "Point this at any OpenAI-compatible or Anthropic-compatible endpoint. Pick the compat mode that matches your server.",
    keyUrl: null,
    requiresKey: false, // optional - depends on the endpoint
    requiresBaseUrl: true,
  },
};

const initclaw = {
  cards: document.querySelectorAll(".provider"),
  form: document.getElementById("provider-form"),
  configPath: document.getElementById("initclaw-config-path"),
  baseUrlWrap: document.getElementById("initclaw-baseurl-wrap"),
  baseUrlLabel: document.getElementById("initclaw-baseurl-label"),
  baseUrl: document.getElementById("initclaw-baseurl"),
  keyWrap: document.getElementById("initclaw-key-wrap"),
  keyLabel: document.getElementById("initclaw-key-label"),
  keyInput: document.getElementById("initclaw-key"),
  keyToggle: document.getElementById("initclaw-key-toggle"),
  compatWrap: document.getElementById("initclaw-compat-wrap"),
  compatSelect: document.getElementById("initclaw-compat"),
  modelSelect: document.getElementById("initclaw-model-select"),
  modelCustom: document.getElementById("initclaw-model-custom"),
  modelHelp: document.getElementById("initclaw-model-help"),
  testBtn: document.getElementById("initclaw-test"),
  applyBtn: document.getElementById("initclaw-apply"),
  testResult: document.getElementById("initclaw-test-result"),
  applyResult: document.getElementById("initclaw-apply-result"),
};

function prepareInitClawStep() {
  initclaw.configPath.textContent = state.detect?.openclaw.configPath ?? "~/.openclaw/openclaw.json";

  // Existing-install banner. If Claw already has a default provider/model
  // and the user hasn't manually picked one in this session yet, offer to
  // keep the existing config instead of forcing them through the picker.
  renderExistingClawBanner();

  if (state.clawProvider) {
    selectProvider(state.clawProvider, /*restoring*/ true);
  } else if (state.detect?.openclaw.defaultProvider) {
    // Map the on-disk provider id (e.g. "anthropic") to our auth-choice key
    // (e.g. "anthropic-api-key") so the picker can pre-select something
    // sensible. Some providers can't be auto-mapped (codex OAuth, custom);
    // in that case we leave the picker blank and let the user choose.
    const cardId = configProviderToCardId(state.detect.openclaw.defaultProvider);
    if (cardId && MODEL_CATALOG[cardId]) {
      // Pre-fill the model field with the configured ref in its prefixed
      // form so "Run onboard" round-trips the same model.
      const dp = state.detect.openclaw.defaultProvider;
      const dm = state.detect.openclaw.defaultModel ?? "";
      state.clawModel = dm.length > 0 ? `${dp}/${dm}` : "";
      selectProvider(cardId, /*restoring*/ true);
    }
  }
}

/**
 * Map the provider id we observe in openclaw.json (the form OpenClaw uses
 * in `models.providers.<id>`) to the ClawProviderId our picker uses.
 *
 * Most providers map 1:1; a few have a hosted vs. API-key split that we
 * can't distinguish from config alone, in which case we pick the more
 * common case ("-api-key" variants).
 */
function configProviderToCardId(configKey) {
  switch (configKey) {
    case "anthropic": return "anthropic-api-key";
    case "openai":    return "openai-api-key";
    case "openai-codex": return "openai-codex-oauth";
    case "google":    return "gemini-api-key";
    case "ollama":    return "ollama";
    // We can't tell intl vs CN from the on-disk config alone (both write
    // to models.providers.moonshot). Default to intl - the user can flip
    // to CN in the picker if their key was issued on platform.moonshot.cn.
    case "moonshot":  return "moonshot-intl";
    case "zai":
    case "z.ai":      return "zai-api-key";
    case "custom":    return "custom-api-key";
    default:          return null;
  }
}

function renderExistingClawBanner() {
  const host = document.getElementById("initclaw-existing");
  if (!host) return;
  const oc = state.detect?.openclaw;
  if (!oc || !oc.defaultProvider) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  const fullRef = `${oc.defaultProvider}/${oc.defaultModel ?? "?"}`;
  host.innerHTML =
    `<div><strong>OpenClaw already has a primary model configured:</strong> ` +
    `<span class="mono">${escapeHtml(fullRef)}</span> ` +
    `(under <span class="mono">agents.defaults.model.primary</span>).</div>` +
    `<div class="row"><button class="btn btn-secondary" id="initclaw-keep">Keep existing setup</button>` +
    `<button class="btn btn-ghost" id="initclaw-change">Change it</button></div>`;
  document.getElementById("initclaw-keep").addEventListener("click", () => {
    state.clawInitialized = true;
    state.clawProvider = configProviderToCardId(oc.defaultProvider);
    state.clawModel = fullRef;
    setInitClawApplyResult(
      "ok",
      `<h4>Keeping existing configuration</h4>
       <div>Using <strong>${escapeHtml(fullRef)}</strong> as set in <span class="mono">${escapeHtml(oc.configPath)}</span>.</div>
       <div>Nothing was written. <code>openclaw onboard</code> will only run if you click "Change it" and re-apply.</div>`,
    );
    render();
  });
  document.getElementById("initclaw-change").addEventListener("click", () => {
    document.getElementById("provider-cards").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function selectProvider(providerId, restoring = false) {
  state.clawProvider = providerId;
  state.clawInitialized = false;
  initclaw.applyResult.hidden = true;
  initclaw.testResult.hidden = true;

  initclaw.cards.forEach((c) => {
    c.classList.toggle("selected", c.getAttribute("data-provider") === providerId);
  });
  initclaw.form.hidden = false;

  const cfg = MODEL_CATALOG[providerId];
  if (!cfg) return;
  initclaw.modelSelect.innerHTML = "";
  for (const m of cfg.models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    initclaw.modelSelect.appendChild(opt);
  }
  if (cfg.models.length === 0) {
    initclaw.modelSelect.disabled = true;
    initclaw.modelCustom.placeholder = "provider/model (required, e.g. lmstudio/qwen3-9b)";
  } else {
    initclaw.modelSelect.disabled = false;
    initclaw.modelCustom.placeholder = "or type a provider/model ref";
  }

  if (restoring) {
    if (state.clawModel) {
      const match = [...initclaw.modelSelect.options].some((o) => o.value === state.clawModel);
      if (match) initclaw.modelSelect.value = state.clawModel;
      else initclaw.modelCustom.value = state.clawModel;
    }
    initclaw.baseUrl.value = state.clawBaseUrl ?? "";
    initclaw.keyInput.value = state.clawApiKey ?? "";
    if (initclaw.compatSelect) initclaw.compatSelect.value = state.clawCustomCompat ?? "openai";
  } else {
    initclaw.modelCustom.value = "";
    initclaw.baseUrl.value = "";
    initclaw.keyInput.value = "";
    if (initclaw.compatSelect) initclaw.compatSelect.value = "openai";
  }

  // Provider-specific field configuration.
  const needsKey = cfg.requiresKey !== false;
  initclaw.keyWrap.hidden = !needsKey;
  initclaw.keyLabel.textContent =
    providerId === "gemini-api-key" ? "Google AI Studio API key (GEMINI_API_KEY)"
    : providerId === "openai-codex-oauth" ? "(no key - launches OAuth)"
    : providerId === "moonshot-intl" ? "Moonshot API key (international)"
    : providerId === "moonshot-cn" ? "Moonshot API key (China endpoint)"
    : "API key";

  initclaw.baseUrlWrap.hidden = !cfg.requiresBaseUrl;
  initclaw.baseUrlLabel.textContent =
    providerId === "ollama" ? "Ollama base URL" : "Endpoint base URL";
  if (providerId === "ollama" && !initclaw.baseUrl.value) {
    initclaw.baseUrl.placeholder = "http://127.0.0.1:11434 (default)";
  } else if (providerId === "custom-api-key") {
    initclaw.baseUrl.placeholder = "https://your-endpoint.example.com/v1";
  }

  // The compatibility selector only matters for custom endpoints; hide it
  // for all hosted providers (where OpenClaw knows the protocol).
  if (initclaw.compatWrap) {
    initclaw.compatWrap.hidden = providerId !== "custom-api-key";
  }

  initclaw.modelHelp.textContent = cfg.keyHint;
}

initclaw.cards.forEach((card) => {
  card.addEventListener("click", () => selectProvider(card.getAttribute("data-provider")));
});

initclaw.keyToggle.addEventListener("click", () => {
  const showing = initclaw.keyInput.type === "text";
  initclaw.keyInput.type = showing ? "password" : "text";
  initclaw.keyToggle.textContent = showing ? "Show" : "Hide";
});

function chosenModel() {
  const raw = (initclaw.modelCustom.value.trim() || initclaw.modelSelect.value || "").trim();
  return raw;
}

function chosenInitInput() {
  return {
    provider: state.clawProvider,
    model: chosenModel(),
    apiKey: initclaw.keyInput.value.trim() || undefined,
    baseUrl: initclaw.baseUrl.value.trim() || undefined,
    customCompatibility: initclaw.compatSelect ? initclaw.compatSelect.value : undefined,
  };
}

initclaw.testBtn.addEventListener("click", async () => {
  if (!state.clawProvider) return;
  const input = chosenInitInput();
  initclaw.testBtn.disabled = true;
  initclaw.testResult.hidden = false;
  initclaw.testResult.className = "result";
  initclaw.testResult.innerHTML = `<span class="spinner"></span> Probing provider…`;
  const res = await window.api.testProvider({
    provider: input.provider,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
  });
  initclaw.testBtn.disabled = false;
  if (!res.ok) {
    initclaw.testResult.className = "result err";
    initclaw.testResult.innerHTML = `<h4>Connection failed</h4><div>${escapeHtml(res.error ?? "Unknown error")}</div>`;
    return;
  }
  initclaw.testResult.className = "result ok";
  const sample = (res.models ?? []).slice(0, 12);
  initclaw.testResult.innerHTML =
    `<h4>Connected in ${res.latencyMs} ms</h4>
     ${sample.length
       ? `<div>Models reported by the provider:</div><div class="mono">${escapeHtml(sample.join(", "))}${(res.models ?? []).length > sample.length ? " …" : ""}</div>`
       : `<div>Provider responded, but didn't list any models (that's fine for some setups — e.g. Codex OAuth).</div>`}`;
});

initclaw.applyBtn.addEventListener("click", async () => {
  if (!state.clawProvider) return;
  const input = chosenInitInput();
  const cfg = MODEL_CATALOG[state.clawProvider] ?? {};
  if (!input.model || input.model.length === 0) {
    setInitClawApplyResult("err", "Pick a model from the dropdown or type one in.");
    return;
  }
  if (!input.model.includes("/")) {
    setInitClawApplyResult(
      "err",
      `Model ref must be provider-prefixed (e.g. <code>anthropic/claude-sonnet-4-6</code>). Got <code>${escapeHtml(input.model)}</code>.`,
    );
    return;
  }
  if (cfg.requiresKey && (!input.apiKey || input.apiKey.length === 0)) {
    setInitClawApplyResult("err", "An API key is required for this provider.");
    return;
  }
  if (cfg.requiresBaseUrl && (!input.baseUrl || input.baseUrl.length === 0) && state.clawProvider === "custom-api-key") {
    setInitClawApplyResult("err", "The custom provider needs a base URL.");
    return;
  }
  initclaw.applyBtn.disabled = true;
  setInitClawApplyResult(
    "",
    `<span class="spinner"></span> Running <code>openclaw onboard --non-interactive --auth-choice ${escapeHtml(input.provider)}</code>… this can take 30-60 seconds on first run while it pulls model catalogs.`,
  );
  const res = await window.api.initOpenclaw(input);
  initclaw.applyBtn.disabled = false;
  if (!res.ok) {
    setInitClawApplyResult(
      "err",
      `<h4>${escapeHtml(res.error ?? "Failed to configure OpenClaw")}</h4>` +
        (res.onboardOutput
          ? `<details class="explain" open><summary>onboard output</summary><pre class="terminal">${escapeHtml(res.onboardOutput)}</pre></details>`
          : ""),
    );
    return;
  }
  state.clawInitialized = true;
  state.clawModel = input.model;
  state.clawApiKey = input.apiKey ?? "";
  state.clawBaseUrl = input.baseUrl ?? "";
  state.clawCustomCompat = input.customCompatibility ?? "openai";
  const onboardBlock = res.onboardOutput
    ? `<details class="explain"><summary>openclaw onboard output</summary><pre class="terminal">${escapeHtml(res.onboardOutput)}</pre></details>`
    : "";
  const statusBlock = res.statusOutput
    ? `<details class="explain"><summary>openclaw status --deep (${res.statusOk ? "healthy" : "warnings"})</summary><pre class="terminal">${escapeHtml(res.statusOutput)}</pre></details>`
    : "";
  setInitClawApplyResult(
    "ok",
    `<h4>OpenClaw configured</h4>
     <div>Set <strong>${escapeHtml(res.defaultProvider ?? "")}</strong> / <strong>${escapeHtml(res.defaultModel ?? "")}</strong> as the primary model in <span class="mono">${escapeHtml(res.configPath ?? "")}</span>.</div>
     ${onboardBlock}
     ${statusBlock}`,
  );
  render();
});

function setInitClawApplyResult(kind, html) {
  initclaw.applyResult.hidden = false;
  initclaw.applyResult.className = `result ${kind}`;
  initclaw.applyResult.innerHTML = html;
}

// ---------- Bind OpenClaw (claw-host / both) ----------

const bindConfigPath = document.getElementById("bind-config-path");
const bindAllow = document.getElementById("bind-allow");
const bindDmPolicy = document.getElementById("bind-dm-policy");
const bindApply = document.getElementById("bind-apply");
const bindResult = document.getElementById("bind-result");
const bindDoctorFix = document.getElementById("bind-doctor-fix");
const bindDoctorOut = document.getElementById("bind-doctor-output");

function prepareBindStep() {
  bindConfigPath.textContent = state.detect?.openclaw.configPath ?? "~/.openclaw/openclaw.json";

  const oc = state.detect?.openclaw;
  // Prefill the allowlist from whatever is already configured so the user
  // doesn't have to retype it. They can still edit before clicking Apply.
  // We filter to entries that look numeric / wildcard so we don't accidentally
  // re-suggest an @username that OpenClaw will reject.
  if (oc?.telegramAllowFrom?.length && bindAllow.value.trim().length === 0) {
    const usable = oc.telegramAllowFrom.filter((v) => /^(?:telegram:|tg:)?(?:\d+|\*)$/i.test(v));
    if (usable.length > 0) bindAllow.value = usable.join(", ");
  }
  // Keep the dropdown in sync with current state.
  if (bindDmPolicy) bindDmPolicy.value = state.bindDmPolicy;
  renderBindExistingBanner();
}

if (bindDmPolicy) {
  bindDmPolicy.addEventListener("change", () => {
    state.bindDmPolicy = bindDmPolicy.value;
  });
}

function renderBindExistingBanner() {
  const host = document.getElementById("bind-existing");
  if (!host) return;
  const oc = state.detect?.openclaw;
  if (!oc?.telegramConfigured || !oc.telegramBotTokenSet) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  let sameBot = false;
  if (state.token && oc.telegramBotTokenPreview) {
    sameBot = previewToken(state.token) === oc.telegramBotTokenPreview;
  }
  host.hidden = false;
  const numericIds = oc.telegramAllowFrom.filter((v) => /^(?:telegram:|tg:)?(?:\d+|\*)$/i.test(v));
  const usernameLikes = oc.telegramAllowFrom.filter((v) => !/^(?:telegram:|tg:)?(?:\d+|\*)$/i.test(v));
  const allowParts = [];
  if (numericIds.length > 0) {
    allowParts.push(`numeric IDs: <span class="mono">${escapeHtml(numericIds.join(", "))}</span>`);
  }
  if (usernameLikes.length > 0) {
    allowParts.push(
      `<strong>${usernameLikes.length} non-numeric entr${usernameLikes.length === 1 ? "y" : "ies"} OpenClaw will ignore</strong>: ` +
        `<span class="mono">${escapeHtml(usernameLikes.join(", "))}</span> — ` +
        `run <code>openclaw doctor --fix</code> below to resolve them to user IDs.`,
    );
  }
  const allowText =
    allowParts.length > 0
      ? `Current allowlist: ${allowParts.join("; ")}.`
      : "Currently no senders are allowlisted.";
  if (sameBot) {
    host.className = "banner sticky";
    host.innerHTML =
      `<div><strong>This OpenClaw is already bound to the same bot you just verified</strong> ` +
      `(<span class="mono">${escapeHtml(oc.telegramBotTokenPreview ?? "")}</span>).</div>` +
      `<div>${allowText} Apply will only add IDs — it won't change the token.</div>`;
  } else {
    host.className = "banner banner-warn sticky";
    host.innerHTML =
      `<div><strong>A different bot is already bound to this OpenClaw</strong> ` +
      `(<span class="mono">${escapeHtml(oc.telegramBotTokenPreview ?? "(set)")}</span>).</div>` +
      `<div>Clicking Apply will replace it with the bot you just verified` +
      (state.botInfo?.username ? ` (<span class="mono">@${escapeHtml(state.botInfo.username)}</span>)` : "") +
      `. ${allowText}</div>`;
  }
}

/**
 * Mirror the token-previewing logic in main/detect.ts so we can compare a
 * locally-typed token to the preview we got back from the detect IPC without
 * having to ship the full configured token to the renderer.
 */
function previewToken(token) {
  if (!token) return "";
  const colon = token.indexOf(":");
  if (colon <= 0) return token.slice(0, 4) + "…";
  const id = token.slice(0, colon);
  const tail = token.slice(colon + 1);
  const masked = tail.length <= 4 ? "…" : `${tail.slice(0, 2)}…${tail.slice(-2)}`;
  return `${id}:${masked}`;
}

bindApply.addEventListener("click", async () => {
  if (!state.token) {
    setBindResult("err", "Verify the bot token first.");
    return;
  }
  const allow = bindAllow.value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const dmPolicy = bindDmPolicy ? bindDmPolicy.value : state.bindDmPolicy;

  // Frontend pre-validation so we never sent OpenClaw a config it'd reject.
  // This mirrors the normalization in main/openclawConfig.ts but surfaces
  // errors immediately instead of waiting for the round-trip.
  if (dmPolicy === "allowlist" && allow.length === 0) {
    setBindResult(
      "err",
      "Policy is <code>allowlist</code> but no IDs are listed. OpenClaw's config validator will refuse this. Add at least one numeric Telegram user ID or pick the <code>pairing</code> policy.",
    );
    return;
  }
  if (dmPolicy === "open" && !allow.includes("*")) {
    setBindResult(
      "err",
      "Policy is <code>open</code> but allowlist doesn't include <code>*</code>. Add a literal <code>*</code> to confirm you want a public bot.",
    );
    return;
  }
  // Spot-check that nobody pasted @usernames - that's the #1 confusion.
  const badEntries = allow.filter(
    (v) => v !== "*" && !/^(?:telegram:|tg:)?\d+$/i.test(v),
  );
  if (badEntries.length > 0) {
    setBindResult(
      "warn",
      `<h4>These entries don't look like Telegram user IDs:</h4>` +
        `<div class="mono">${escapeHtml(badEntries.join(", "))}</div>` +
        `<div>Telegram allowlists must contain numeric IDs (the integer ones <code>getUpdates</code> returns under <code>from.id</code>). ` +
        `Usernames like <code>@alice</code> are silently dropped by OpenClaw at runtime.</div>` +
        `<div style="margin-top:6px">We'll only write the valid entries. Click Apply again to proceed with the cleaned list, or fix the entries first.</div>`,
    );
    // Don't hard-block: let the user click again if they want to proceed,
    // since main will normalize and report warnings of its own.
    return;
  }

  bindApply.disabled = true;
  const res = await window.api.configureOpenclaw({ token: state.token, allowFrom: allow, dmPolicy });
  bindApply.disabled = false;
  if (!res.ok) {
    setBindResult("err", res.error ?? "Failed to write config.");
    return;
  }
  state.gatewayBound = true;
  state.bindDmPolicy = dmPolicy;
  const warnBlock = (res.warnings ?? []).length > 0
    ? `<details class="explain" open><summary>Warnings (${res.warnings.length})</summary><ul>${res.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></details>`
    : "";
  const body = res.changed
    ? `Updated <span class="mono">${escapeHtml(res.configPath)}</span> with <code>enabled: true</code>, your bot token, ${allow.length} allowlist entr${allow.length === 1 ? "y" : "ies"}, and <code>dmPolicy: "${escapeHtml(dmPolicy)}"</code>. ${
        res.restartRequired ? "We'll restart the Gateway on the next step." : ""
      }`
    : `No changes needed — your existing config at <span class="mono">${escapeHtml(res.configPath)}</span> already matches.`;
  setBindResult("ok", body + warnBlock + (res.gatewayStatus ? `<details class="explain"><summary>gateway status</summary><pre class="terminal">${escapeHtml(res.gatewayStatus)}</pre></details>` : ""));
  if (!res.restartRequired) state.gatewayRestarted = true;
  render();
});

if (bindDoctorFix) {
  bindDoctorFix.addEventListener("click", async () => {
    bindDoctorFix.disabled = true;
    bindDoctorOut.hidden = false;
    bindDoctorOut.textContent = "Running openclaw doctor --fix…";
    const res = await window.api.runOpenclawDoctorFix();
    bindDoctorFix.disabled = false;
    bindDoctorOut.textContent =
      `[exit ${res.exitCode ?? "?"}]\n` +
      (res.stdout ? `stdout:\n${res.stdout}\n` : "") +
      (res.stderr ? `stderr:\n${res.stderr}\n` : "") +
      (res.error ? `error: ${res.error}\n` : "");
    // After doctor --fix runs we should re-detect since it may have rewritten
    // entries in our allowlist.
    state.detect = await window.api.detect();
    if (currentStep() === "bind-openclaw") prepareBindStep();
  });
}

function setBindResult(kind, html) {
  bindResult.hidden = false;
  bindResult.className = `result ${kind}`;
  bindResult.innerHTML = html;
}

// ---------- Activate Gateway (claw-host / both) ----------

const restartGo = document.getElementById("restart-go");
const restartResult = document.getElementById("restart-result");
const restartDoctor = document.getElementById("restart-doctor");
const restartStatus = document.getElementById("restart-status");
const restartDoctorOut = document.getElementById("restart-doctor-output");
const daemonInstall = document.getElementById("daemon-install");
const daemonUninstall = document.getElementById("daemon-uninstall");
const pairingBlock = document.getElementById("pairing-block");
const pairingRefresh = document.getElementById("pairing-refresh");
const pairingList = document.getElementById("pairing-list");

/**
 * Show the pairing UI iff the bind step picked dmPolicy: "pairing".
 * For allowlist/open policies there's nothing to approve.
 */
function syncPairingVisibility() {
  if (!pairingBlock) return;
  pairingBlock.hidden = state.bindDmPolicy !== "pairing";
}

function setRestartResult(kind, html) {
  restartResult.hidden = false;
  restartResult.className = `result ${kind}`;
  restartResult.innerHTML = html;
}

restartGo.addEventListener("click", async () => {
  restartGo.disabled = true;
  setRestartResult("", `<span class="spinner"></span> Restarting <code>openclaw gateway</code>…`);
  const res = await window.api.restartGateway();
  restartGo.disabled = false;
  if (!res.ok) {
    setRestartResult(
      "err",
      `<h4>Restart failed</h4>
       <div>${escapeHtml(res.error ?? "exit " + (res.exitCode ?? "?"))}</div>
       <pre class="terminal">${escapeHtml((res.stdout ?? "") + (res.stderr ?? ""))}</pre>
       <div class="mono">Try the manual fallback below, or use "Install daemon" for a supervised run.</div>`,
    );
    return;
  }
  state.gatewayRestarted = true;
  setRestartResult(
    "ok",
    `<h4>Gateway restarted</h4>
     <div>The new Telegram binding is now live.</div>
     ${res.status ? `<pre class="terminal">${escapeHtml(res.status)}</pre>` : ""}`,
  );
  syncPairingVisibility();
  render();
});

if (daemonInstall) {
  daemonInstall.addEventListener("click", async () => {
    daemonInstall.disabled = true;
    setRestartResult(
      "",
      `<span class="spinner"></span> Running <code>openclaw gateway install</code>… we'll register the daemon and start it.`,
    );
    const res = await window.api.installDaemon({ enable: true });
    daemonInstall.disabled = false;
    if (!res.ok) {
      setRestartResult(
        "err",
        `<h4>Daemon install failed</h4>
         <div>${escapeHtml(res.error ?? "Unknown error")}</div>
         <pre class="terminal">${escapeHtml((res.stdout ?? "") + (res.stderr ?? ""))}</pre>`,
      );
      return;
    }
    state.gatewayRestarted = true;
    const supervisorLabel = {
      "launchagent": "macOS LaunchAgent",
      "systemd-user": "systemd user unit",
      "scheduled-task": "Windows Scheduled Task",
      "startup-folder": "Windows Startup folder (fallback)",
      "unknown": "supervisor",
    }[res.supervisor ?? "unknown"] ?? "supervisor";
    setRestartResult(
      "ok",
      `<h4>Daemon installed</h4>
       <div>Registered as a ${escapeHtml(supervisorLabel)}. The gateway will now start automatically at login.</div>
       ${res.stdout ? `<details class="explain"><summary>install output</summary><pre class="terminal">${escapeHtml(res.stdout + (res.stderr ? "\n" + res.stderr : ""))}</pre></details>` : ""}`,
    );
    syncPairingVisibility();
    render();
  });
}

if (daemonUninstall) {
  daemonUninstall.addEventListener("click", async () => {
    daemonUninstall.disabled = true;
    setRestartResult("", `<span class="spinner"></span> Running <code>openclaw gateway uninstall</code>…`);
    const res = await window.api.installDaemon({ enable: false });
    daemonUninstall.disabled = false;
    setRestartResult(
      res.ok ? "ok" : "err",
      res.ok
        ? `<h4>Daemon uninstalled</h4><div>The gateway will no longer auto-start at login.</div>${res.stdout ? `<pre class="terminal">${escapeHtml(res.stdout)}</pre>` : ""}`
        : `<h4>Uninstall failed</h4><div>${escapeHtml(res.error ?? "")}</div><pre class="terminal">${escapeHtml((res.stdout ?? "") + (res.stderr ?? ""))}</pre>`,
    );
  });
}

restartDoctor.addEventListener("click", async () => {
  restartDoctorOut.hidden = false;
  restartDoctorOut.textContent = "Running openclaw doctor…";
  const res = await window.api.runOpenclawDoctor();
  if (!res.ok && !res.stdout && !res.stderr) {
    restartDoctorOut.textContent = res.error ?? "openclaw doctor failed.";
    return;
  }
  restartDoctorOut.textContent =
    `[exit ${res.exitCode}]\n` +
    (res.stdout ? `stdout:\n${res.stdout}\n` : "") +
    (res.stderr ? `stderr:\n${res.stderr}\n` : "");
});

if (restartStatus) {
  restartStatus.addEventListener("click", async () => {
    restartDoctorOut.hidden = false;
    restartDoctorOut.textContent = "Running openclaw status --deep…";
    const res = await window.api.runOpenclawStatusDeep();
    restartDoctorOut.textContent =
      `[exit ${res.exitCode ?? "?"}]\n` +
      (res.stdout ? `stdout:\n${res.stdout}\n` : "") +
      (res.stderr ? `stderr:\n${res.stderr}\n` : "") +
      (res.error ? `error: ${res.error}\n` : "");
  });
}

if (pairingRefresh) {
  pairingRefresh.addEventListener("click", async () => {
    pairingRefresh.disabled = true;
    pairingList.hidden = false;
    pairingList.className = "result";
    pairingList.innerHTML = `<span class="spinner"></span> Checking for pending pairing codes…`;
    const res = await window.api.pairingList();
    pairingRefresh.disabled = false;
    if (!res.ok) {
      pairingList.className = "result err";
      pairingList.innerHTML = `<h4>Couldn't read pending pairings</h4><div>${escapeHtml(res.error ?? "")}</div>${res.raw ? `<pre class="terminal">${escapeHtml(res.raw)}</pre>` : ""}`;
      return;
    }
    if (res.pending.length === 0) {
      pairingList.className = "result";
      pairingList.innerHTML = `<h4>No pending pairings</h4><div>If someone DMs the bot now, refresh again to see their code.</div>${res.raw ? `<details class="explain"><summary>raw output</summary><pre class="terminal">${escapeHtml(res.raw)}</pre></details>` : ""}`;
      return;
    }
    pairingList.className = "result";
    const items = res.pending
      .map(
        (p) => `
        <div class="candidate" data-code="${escapeHtml(p.code)}">
          <div>
            <div class="who">${escapeHtml(p.label ?? `Telegram user ${p.senderId}`)} <span class="mono">(id ${escapeHtml(p.senderId)})</span></div>
            <div class="meta">code: <span class="mono">${escapeHtml(p.code)}</span>${p.createdAtMs ? ` · issued ${escapeHtml(relativeTime(p.createdAtMs))}` : ""}</div>
          </div>
          <button data-action="approve">Approve</button>
        </div>`,
      )
      .join("");
    pairingList.innerHTML = `<h4>${res.pending.length} pending pairing${res.pending.length === 1 ? "" : "s"}</h4>${items}`;
    pairingList.querySelectorAll(".candidate").forEach((node) => {
      const code = node.getAttribute("data-code");
      const btn = node.querySelector("button");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Approving…";
        const ar = await window.api.pairingApprove({ code });
        if (!ar.ok) {
          btn.textContent = "Retry";
          btn.disabled = false;
          node.classList.add("err");
          node.querySelector(".meta").innerHTML += `<div class="mono">${escapeHtml(ar.error ?? "approve failed")}</div>`;
          return;
        }
        btn.textContent = "Approved";
        node.classList.add("selected");
      });
    });
  });
}

function relativeTime(epochMs) {
  const diff = Math.max(0, Date.now() - epochMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

// ---------- Chat (claude-user / both) ----------

const chatDetect = document.getElementById("chat-detect");
const chatRefresh = document.getElementById("chat-refresh");
const chatResult = document.getElementById("chat-result");
const chatManual = document.getElementById("chat-manual");
const chatManualWrap = document.getElementById("chat-manual-wrap");

function prepareChatStep() {
  const username = state.botInfo?.username ? `@${state.botInfo.username}` : "(the company bot)";
  document.getElementById("chat-bot-username").textContent = username;
  document.getElementById("chat-bot-username-2").textContent = username;
}

async function fetchCandidates() {
  if (!state.token) return;
  chatDetect.disabled = true;
  chatResult.hidden = false;
  chatResult.className = "result";
  chatResult.innerHTML = `<span class="spinner"></span> Asking Telegram for recent messages…`;
  const res = await window.api.discoverChat({ token: state.token, preferredUsername: null });
  chatDetect.disabled = false;
  if (!res.ok) {
    chatResult.className = "result err";
    chatResult.innerHTML = `<h4>Discovery failed</h4><div>${escapeHtml(res.error ?? "Unknown error")}</div>`;
    chatManualWrap.hidden = false;
    return;
  }
  if (res.candidates.length === 0) {
    chatResult.className = "result warn";
    chatResult.innerHTML = `<h4>No recent messages to the bot</h4>
      <div>Send the bot a message in Telegram (anything, like /start) then click Refresh.</div>`;
    chatManualWrap.hidden = false;
    return;
  }
  chatResult.className = "result";
  const items = res.candidates
    .map(
      (c) => `<div class="candidate" data-chat="${escapeHtml(c.chatId)}">
        <div>
          <div class="who">${escapeHtml(c.title ?? c.firstName ?? c.username ?? c.chatId)} <span class="mono">(${escapeHtml(c.type)})</span></div>
          <div class="meta">chat id: <span class="mono">${escapeHtml(c.chatId)}</span></div>
          <div class="preview">"${escapeHtml(c.lastMessagePreview)}"</div>
        </div>
        <button data-action="select">Use this chat</button>
      </div>`,
    )
    .join("");
  chatResult.innerHTML = `<h4>Found ${res.candidates.length} chat${res.candidates.length === 1 ? "" : "s"}</h4>${items}`;
  chatResult.querySelectorAll(".candidate").forEach((node) => {
    const id = node.getAttribute("data-chat");
    node.querySelector("button").addEventListener("click", () => selectChat(id, node));
  });
  chatManualWrap.hidden = false;
}

function selectChat(id, node) {
  state.chatId = String(id ?? "").trim();
  state.chatName = node ? node.querySelector(".who")?.textContent ?? state.chatId : state.chatId;
  chatResult.querySelectorAll(".candidate").forEach((n) => n.classList.remove("selected"));
  if (node) node.classList.add("selected");
  render();
}

chatDetect.addEventListener("click", fetchCandidates);
chatRefresh.addEventListener("click", fetchCandidates);
chatManual.addEventListener("input", () => {
  const v = chatManual.value.trim();
  if (/^-?\d+$/.test(v)) {
    state.chatId = v;
    state.chatName = `chat ${v}`;
    render();
  } else {
    state.chatId = "";
    render();
  }
});

// ---------- Install (claude-user / both) ----------

const installConfigPath = document.getElementById("install-config-path");
const installGo = document.getElementById("install-go");
const installResult = document.getElementById("install-result");

async function prepareInstallStep() {
  installConfigPath.textContent = state.detect?.claudeDesktop.configPath ?? "(unknown)";
  // Surface a banner if a previous bridge install is already on disk; this
  // gives the user the "Update bundle (keep my settings)" shortcut.
  await refreshExistingBridgeBanner();
}

installGo.addEventListener("click", async () => {
  if (!state.token || !state.chatId) {
    setInstallResult("err", "Token and chat ID are required.");
    return;
  }
  installGo.disabled = true;
  setInstallResult("", `<span class="spinner"></span> Unpacking bundle and writing config…`);
  const res = await window.api.installBridge({
    token: state.token,
    chatId: state.chatId,
    auditChatId: document.getElementById("install-audit").value.trim() || null,
    devMirror: document.getElementById("install-devmirror").checked,
    defaultTimeoutMs: Number(document.getElementById("install-timeout").value),
    escalationMarker: document.getElementById("install-marker").value.trim() || "[ASK-CLAUDE]",
  });
  installGo.disabled = false;
  if (!res.ok) {
    setInstallResult("err", res.error ?? "Install failed.");
    return;
  }
  state.bridgeInstalled = true;
  const backup = res.backupCreated
    ? `<div class="mono">A backup of your previous config was saved at ${escapeHtml(res.backupPath ?? "(unknown)")}.</div>`
    : "";
  setInstallResult(
    "ok",
    `<h4>Bridge installed</h4>
     <div>Bundle unpacked to <span class="mono">${escapeHtml(res.installedBundlePath ?? "")}</span>.</div>
     <div>Config written to <span class="mono">${escapeHtml(res.claudeConfigPath ?? "")}</span>.</div>
     ${backup}
     <div style="margin-top:10px">Restart Claude Desktop for it to pick up the new MCP server.</div>`,
  );
  render();
});

function setInstallResult(kind, html) {
  installResult.hidden = false;
  installResult.className = `result ${kind}`;
  installResult.innerHTML = html;
}

// ---------- Smoke test (claude-user / both) ----------

const smokeRun = document.getElementById("smoke-run");
const smokeSkip = document.getElementById("smoke-skip");
const smokeResult = document.getElementById("smoke-result");

smokeSkip.addEventListener("click", () => go(+1));

smokeRun.addEventListener("click", async () => {
  if (!state.token || !state.chatId) {
    setSmokeResult("err", "Need both a bot token and a chat ID before running the smoke test.");
    return;
  }
  smokeRun.disabled = true;
  setSmokeResult("", `<span class="spinner"></span> Sending probe and waiting up to 45s for a reply…`);
  const res = await window.api.smokeTest({ token: state.token, chatId: state.chatId });
  smokeRun.disabled = false;
  if (res.ok) {
    const warningHtml = res.warning
      ? `<div class="warn-inline" style="margin-top:10px;padding:8px 10px;border:1px solid rgba(245,184,109,0.35);background:rgba(245,184,109,0.08);border-radius:6px;font-size:12.5px;line-height:1.45;color:var(--warn);">⚠️ ${escapeHtml(res.warning)}</div>`
      : "";
    setSmokeResult(
      "ok",
      `<h4>Round-trip succeeded in ${res.roundTripMs} ms</h4>
       <div class="mono">${escapeHtml(res.reply ?? "")}</div>${warningHtml}`,
    );
    return;
  }
  if (res.noReply) {
    setSmokeResult(
      "warn",
      `<h4>No reply within 45 seconds</h4>
       <div>The probe was delivered but Claw didn't answer. Common causes:</div>
       <ul>
         <li>Claw Gateway isn't running on the host (have an admin run <code>openclaw status --deep</code>).</li>
         <li>The bot isn't bound to this chat yet (re-run this installer on the Claw host).</li>
         <li>Your numeric Telegram user ID isn't in <code>channels.telegram.allowFrom</code> (and the policy isn't <code>pairing</code> with an approved code).</li>
         <li>If the policy is <code>pairing</code>, no one has approved your code yet — admin runs <code>openclaw pairing list telegram</code> + <code>openclaw pairing approve telegram &lt;code&gt;</code>, or uses the Activate Gateway screen.</li>
       </ul>`,
    );
    return;
  }
  setSmokeResult("err", `<h4>Smoke test failed</h4><div>${escapeHtml(res.error ?? "Unknown error")}</div>`);
});

function setSmokeResult(kind, html) {
  smokeResult.hidden = false;
  smokeResult.className = `result ${kind}`;
  smokeResult.innerHTML = html;
}

// ---------- Done screens ----------

document.getElementById("done-claude-reveal").addEventListener("click", () => {
  if (state.detect?.claudeDesktop.configPath) {
    window.api.revealInFolder(state.detect.claudeDesktop.configPath);
  }
});
document.getElementById("done-claude-quit").addEventListener("click", () => window.api.quit());

document.getElementById("done-claw-reveal").addEventListener("click", () => {
  if (state.detect?.openclaw.configPath) {
    window.api.revealInFolder(state.detect.openclaw.configPath);
  }
});
document.getElementById("done-claw-quit").addEventListener("click", () => window.api.quit());

// ---------- Pairing auto-poll ----------
//
// When dmPolicy === "pairing", we set up a 5s interval that re-runs
// pairingList() while the Activate Gateway screen is open. The interval is
// cleared on step exit, on tab hide (Page Visibility), and when the user
// unchecks the autopoll box. We never auto-approve - the user still clicks.

let pairingPollHandle = null;
const pairingAutopollToggle = document.getElementById("pairing-autopoll");
const pairingAutopollStatus = document.getElementById("pairing-autopoll-status");

function startPairingAutoPoll() {
  if (pairingPollHandle !== null) return;
  if (!pairingAutopollToggle || !pairingAutopollToggle.checked) return;
  if (!pairingRefresh) return;
  // Fire once immediately so the panel has data before the first interval tick.
  pairingRefresh.click();
  pairingPollHandle = setInterval(() => {
    if (currentStep() !== "restart-gateway") {
      stopPairingAutoPoll();
      return;
    }
    if (!pairingAutopollToggle.checked) {
      stopPairingAutoPoll();
      return;
    }
    if (document.hidden) return;
    if (pairingRefresh.disabled) return;
    pairingRefresh.click();
  }, 5000);
  if (pairingAutopollStatus) {
    pairingAutopollStatus.textContent = "auto-polling every 5s";
    pairingAutopollStatus.classList.add("live");
  }
}

function stopPairingAutoPoll() {
  if (pairingPollHandle !== null) {
    clearInterval(pairingPollHandle);
    pairingPollHandle = null;
  }
  if (pairingAutopollStatus) {
    pairingAutopollStatus.textContent = "";
    pairingAutopollStatus.classList.remove("live");
  }
}

if (pairingAutopollToggle) {
  pairingAutopollToggle.addEventListener("change", () => {
    if (pairingAutopollToggle.checked && currentStep() === "restart-gateway") {
      startPairingAutoPoll();
    } else {
      stopPairingAutoPoll();
    }
  });
}

document.addEventListener("visibilitychange", () => {
  // We don't tear down the handle on hide; the interval handler checks
  // document.hidden and skips fetches while the window is in the background.
  if (!document.hidden && currentStep() === "restart-gateway" && state.bindDmPolicy === "pairing") {
    startPairingAutoPoll();
  }
});

// ---------- Model validation (init-claw) ----------
//
// After a successful Test connection, we know the canonical list of models
// the provider exposes for this key. Cross-check the user's picked model
// against that list and surface a warning *before* they hit Run, so a typo
// like "claude-sonnet-4" (no -6) gets caught immediately instead of after a
// 30-second onboard run.

const modelValidateBox = document.getElementById("initclaw-model-validate");
let lastProviderProbe = null; // { providerId, models: string[], at }

function validateChosenModelAgainstProbe() {
  if (!modelValidateBox) return;
  if (!lastProviderProbe || lastProviderProbe.providerId !== state.clawProvider) {
    modelValidateBox.hidden = true;
    return;
  }
  const chosen = chosenModel();
  if (!chosen.includes("/")) {
    modelValidateBox.hidden = true;
    return;
  }
  // The provider half of "provider/model" must match - we don't try to
  // validate cross-provider refs.
  const [provider, ...rest] = chosen.split("/");
  const modelOnly = rest.join("/");
  if (modelOnly.length === 0) {
    modelValidateBox.hidden = true;
    return;
  }
  // OpenClaw accepts both bare model ids ("claude-sonnet-4-6") and full refs
  // ("anthropic/claude-sonnet-4-6") in models reported by providers. We try
  // both shapes.
  const candidates = new Set(
    lastProviderProbe.models.flatMap((m) => {
      const lower = m.toLowerCase();
      const stripped = lower.includes("/") ? lower.split("/").slice(1).join("/") : lower;
      return [lower, stripped];
    }),
  );
  const wanted = modelOnly.toLowerCase();
  const fullWanted = chosen.toLowerCase();
  if (candidates.has(wanted) || candidates.has(fullWanted)) {
    modelValidateBox.hidden = false;
    modelValidateBox.className = "result ok";
    modelValidateBox.innerHTML = `<span class="mono">${escapeHtml(chosen)}</span> is in the provider's catalog. Safe to onboard.`;
    return;
  }
  // Try to suggest the closest match. We don't need fuzzy: just look for
  // models that share the same stem (e.g. "claude-sonnet-4-6" matches
  // "claude-sonnet-*").
  const stem = wanted.split(/[-:.]/)[0];
  const suggestions = lastProviderProbe.models
    .filter((m) => m.toLowerCase().includes(stem))
    .slice(0, 5);
  modelValidateBox.hidden = false;
  modelValidateBox.className = "result warn";
  const provLabel = escapeHtml(provider);
  let body =
    `<strong>Heads up:</strong> <span class="mono">${escapeHtml(chosen)}</span> isn't in ` +
    `${provLabel}'s list of models for this key.`;
  if (suggestions.length > 0) {
    body +=
      `<div style="margin-top:6px">Did you mean one of:</div>` +
      `<div class="mono">${escapeHtml(suggestions.join(", "))}</div>`;
  } else {
    body += ` We'll still let you onboard - the provider may know the id under a different alias, or you may be early on a model only the CLI knows about.`;
  }
  modelValidateBox.innerHTML = body;
}

// Re-validate whenever the user changes the model picker / custom field.
if (initclaw.modelSelect) initclaw.modelSelect.addEventListener("change", validateChosenModelAgainstProbe);
if (initclaw.modelCustom) initclaw.modelCustom.addEventListener("input", validateChosenModelAgainstProbe);

// Wrap testBtn click so we remember the probe result for validation.
{
  const originalTestHandler = initclaw.testBtn.onclick;
  // We attached via addEventListener above; rather than fishing it out, we
  // tack a second listener that runs *after* the original (event listeners
  // fire in registration order, so probing into lastProviderProbe needs to
  // happen after the testResult innerHTML has been set). We do our own
  // probe and reuse the cached result the original installer call returned.
  void originalTestHandler;
  initclaw.testBtn.addEventListener("click", async () => {
    // The original handler will run before this one because it was
    // registered first. But it's async and may not be done. Easier: poll
    // until the testResult panel finishes spinning, then read the provider
    // models from its rendered HTML... actually no, cleanest is to
    // re-issue the probe ourselves with the in-progress dedupe. The IPC
    // is cheap (a single GET).
    if (!state.clawProvider) return;
    const input = chosenInitInput();
    try {
      const res = await window.api.testProvider({
        provider: input.provider,
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
      });
      if (res.ok && Array.isArray(res.models)) {
        lastProviderProbe = {
          providerId: input.provider,
          models: res.models,
          at: Date.now(),
        };
        validateChosenModelAgainstProbe();
      }
    } catch {
      // ignore - the primary handler already surfaced the user-facing error
    }
  });
}

// ---------- Install step: existing-bridge banner + update flow ----------

const installExistingBanner = document.getElementById("install-existing");
const installUpdateBtn = document.getElementById("install-update");
let lastExistingBridge = null;

async function refreshExistingBridgeBanner() {
  if (!installExistingBanner) return;
  try {
    const existing = await window.api.detectExistingBridge();
    lastExistingBridge = existing;
    if (!existing.installed) {
      installExistingBanner.hidden = true;
      installExistingBanner.innerHTML = "";
      if (installUpdateBtn) installUpdateBtn.hidden = true;
      return;
    }
    const newerLabel = existing.upgradeAvailable
      ? `<strong>Update available:</strong> ${escapeHtml(existing.installedVersion ?? "?")} → ${escapeHtml(existing.bundledVersion ?? "?")}.`
      : `Installed version: <span class="mono">${escapeHtml(existing.installedVersion ?? "?")}</span> (bundled: <span class="mono">${escapeHtml(existing.bundledVersion ?? "?")}</span>).`;
    installExistingBanner.hidden = false;
    installExistingBanner.className = existing.upgradeAvailable ? "banner banner-warn sticky" : "banner sticky";
    installExistingBanner.innerHTML =
      `<div>${newerLabel}</div>` +
      `<div>The bridge is already unpacked at <span class="mono">${escapeHtml(existing.installDir)}</span>.</div>` +
      (existing.existingEnv
        ? `<div>Your token and chat ID are still in <span class="mono">claude_desktop_config.json</span>. Click <strong>Update bundle</strong> to re-unpack without re-entering them, or use <strong>Install bridge</strong> to overwrite with the values you've entered in this wizard.</div>`
        : `<div>No env block was found in the Claude Desktop config - use <strong>Install bridge</strong> to write a fresh one.</div>`);
    if (installUpdateBtn) {
      installUpdateBtn.hidden = !existing.existingEnv;
    }
  } catch (err) {
    installExistingBanner.hidden = true;
    console.warn("detectExistingBridge failed", err);
  }
}

if (installUpdateBtn) {
  installUpdateBtn.addEventListener("click", async () => {
    installUpdateBtn.disabled = true;
    setInstallResult(
      "",
      `<span class="spinner"></span> Re-unpacking the bundled .mcpb on top of the existing install (env preserved)…`,
    );
    const res = await window.api.updateBridge({ preserveEnv: true });
    installUpdateBtn.disabled = false;
    if (!res.ok) {
      setInstallResult("err", res.error ?? "Update failed.");
      return;
    }
    state.bridgeInstalled = true;
    setInstallResult(
      "ok",
      `<h4>Bridge bundle updated</h4>
       <div>${escapeHtml(res.previousVersion ?? "?")} → ${escapeHtml(res.installedVersion ?? "?")}</div>
       <div>Unpacked at <span class="mono">${escapeHtml(res.installedBundlePath ?? "")}</span>.</div>
       <div>Existing env in <span class="mono">${escapeHtml(res.claudeConfigPath ?? "")}</span> was preserved.</div>
       <div style="margin-top:10px">Restart Claude Desktop to pick up the new code.</div>`,
    );
    await refreshExistingBridgeBanner();
    render();
  });
}

// ---------- Done (Claude side): Claude Code install + macOS quarantine + telemetry ----------

async function prepareDoneClaudeStep() {
  // Show the macOS quarantine card only on macOS - the guidance doesn't
  // apply elsewhere and would just be noise.
  const macCard = document.getElementById("macos-quarantine-card");
  if (macCard) macCard.hidden = state.detect?.platform !== "darwin";

  // Sync the telemetry toggle to whatever's actually on disk.
  const toggle = document.getElementById("telemetry-toggle");
  const statusLine = document.getElementById("telemetry-status");
  if (toggle) {
    try {
      const cur = await window.api.getTelemetry();
      toggle.checked = cur.enabled;
      if (statusLine) statusLine.textContent = `Stored at ${cur.configPath}.`;
    } catch {
      toggle.checked = false;
    }
  }
}

const ccInstall = document.getElementById("claude-code-install");
const ccUninstall = document.getElementById("claude-code-uninstall");
const ccResult = document.getElementById("claude-code-result");

function setClaudeCodeResult(kind, html) {
  if (!ccResult) return;
  ccResult.hidden = false;
  ccResult.className = `result ${kind}`;
  ccResult.innerHTML = html;
}

if (ccInstall) {
  ccInstall.addEventListener("click", async () => {
    ccInstall.disabled = true;
    setClaudeCodeResult("", `<span class="spinner"></span> Registering with Claude Code at user scope…`);
    const res = await window.api.claudeCodeInstall({ enable: true });
    ccInstall.disabled = false;
    if (!res.ok) {
      setClaudeCodeResult("err", `<h4>Failed</h4><div>${escapeHtml(res.error ?? "Unknown error")}</div>`);
      return;
    }
    setClaudeCodeResult(
      "ok",
      `<h4>Installed for Claude Code</h4>
       <div>Plugin dir: <span class="mono">${escapeHtml(res.pluginDir ?? "")}</span></div>
       <div>Strategy: <strong>${escapeHtml(res.strategy ?? "")}</strong>${
         res.configPath ? ` (wrote ${escapeHtml(res.configPath)})` : ""
       }</div>
       ${res.output ? `<details class="explain"><summary>output</summary><pre class="terminal">${escapeHtml(res.output)}</pre></details>` : ""}
       <div style="margin-top:8px">Restart any running <code>claude</code> sessions for the plugin to register, then run <code>/plugin</code> to confirm.</div>`,
    );
  });
}

if (ccUninstall) {
  ccUninstall.addEventListener("click", async () => {
    ccUninstall.disabled = true;
    setClaudeCodeResult("", `<span class="spinner"></span> Removing Claude Code registration…`);
    const res = await window.api.claudeCodeInstall({ enable: false });
    ccUninstall.disabled = false;
    if (!res.ok) {
      setClaudeCodeResult("err", `<h4>Uninstall failed</h4><div>${escapeHtml(res.error ?? "")}</div>`);
      return;
    }
    setClaudeCodeResult(
      "ok",
      `<h4>Removed from Claude Code</h4>
       <div>Strategy: <strong>${escapeHtml(res.strategy ?? "")}</strong></div>
       ${res.output ? `<details class="explain"><summary>output</summary><pre class="terminal">${escapeHtml(res.output)}</pre></details>` : ""}
       <div style="margin-top:8px">The bundle on disk is untouched - your Claude Desktop install (if any) keeps working.</div>`,
    );
  });
}

const telemetryToggle = document.getElementById("telemetry-toggle");
const telemetryStatus = document.getElementById("telemetry-status");
if (telemetryToggle) {
  telemetryToggle.addEventListener("change", async () => {
    const wanted = telemetryToggle.checked;
    try {
      const res = await window.api.setTelemetry({ enabled: wanted });
      if (telemetryStatus) {
        telemetryStatus.textContent = res.ok
          ? `${wanted ? "Enabled" : "Disabled"} - stored at ${res.configPath}.`
          : `Couldn't persist: ${res.error ?? ""}`;
      }
    } catch (err) {
      if (telemetryStatus) telemetryStatus.textContent = `Couldn't persist: ${String(err)}`;
    }
  });
}

// ---------- Helpers ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Boot
render();
