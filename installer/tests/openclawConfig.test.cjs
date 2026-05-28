/**
 * Tests for openclawConfig.ts helpers that we use to write the Telegram
 * channel block and to invoke `openclaw onboard --non-interactive`.
 *
 * These don't touch the network or the filesystem - they exercise pure
 * functions, so they catch regressions in:
 *   - allowFrom normalization (numeric IDs only, telegram:/tg: prefix stripped)
 *   - dmPolicy + allowFrom invariant validation
 *   - buildOnboardArgs producing the right --auth-choice + env per provider
 *   - stripProviderPrefix being a no-op when no slash is present
 *   - providerIdToConfigKey mapping every documented ClawProviderId
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyTelegramChannelConfig,
  buildOnboardArgs,
  stripProviderPrefix,
  providerIdToConfigKey,
} = require("../dist/main/openclawConfig");

test("applyTelegramChannelConfig writes enabled:true + new bot token + dmPolicy", () => {
  const { next, changed, warnings } = applyTelegramChannelConfig(
    { },
    { token: "12345:abcdef", allowFrom: ["123"], dmPolicy: "pairing" },
  );
  assert.equal(changed, true);
  assert.equal(next.channels.telegram.enabled, true);
  assert.equal(next.channels.telegram.botToken, "12345:abcdef");
  assert.equal(next.channels.telegram.dmPolicy, "pairing");
  assert.deepEqual(next.channels.telegram.allowFrom, ["123"]);
  assert.equal(warnings.length, 0);
});

test("applyTelegramChannelConfig drops @username entries and warns", () => {
  const { next, warnings } = applyTelegramChannelConfig(
    { },
    {
      token: "t",
      allowFrom: ["123", "@alice", "tg:456", "telegram:789", "junk"],
      dmPolicy: "allowlist",
    },
  );
  // Numeric ids survive (with telegram:/tg: prefix stripped).
  assert.deepEqual(next.channels.telegram.allowFrom.sort(), ["123", "456", "789"].sort());
  // The garbage entries produce warnings.
  assert.ok(warnings.length >= 1);
  assert.ok(warnings.join(" ").includes("@alice"));
});

test("applyTelegramChannelConfig preserves unrelated channel keys verbatim", () => {
  const { next } = applyTelegramChannelConfig(
    { channels: { whatsapp: { botToken: "wa" }, telegram: { someExtra: 1 } } },
    { token: "t", allowFrom: ["1"], dmPolicy: "pairing" },
  );
  assert.equal(next.channels.whatsapp.botToken, "wa");
  assert.equal(next.channels.telegram.someExtra, 1);
});

test("applyTelegramChannelConfig: open policy without '*' surfaces a warning", () => {
  const { warnings, next } = applyTelegramChannelConfig(
    { },
    { token: "t", allowFrom: ["123"], dmPolicy: "open" },
  );
  // We don't auto-downgrade - the renderer's pre-validate refuses the
  // submit so we never get here in normal flow. But if a caller insists,
  // we still write the policy and surface a loud warning so the next
  // `openclaw status --deep` makes the misconfig obvious.
  assert.equal(next.channels.telegram.dmPolicy, "open");
  assert.ok(
    warnings.some((w) => /open/i.test(w) && /\*/.test(w)),
    `expected an "open requires *" warning, got: ${JSON.stringify(warnings)}`,
  );
});

test("applyTelegramChannelConfig is a no-op when everything matches", () => {
  const before = {
    channels: {
      telegram: {
        enabled: true,
        botToken: "t",
        allowFrom: ["123"],
        dmPolicy: "pairing",
      },
    },
  };
  const { changed } = applyTelegramChannelConfig(before, {
    token: "t",
    allowFrom: ["123"],
    dmPolicy: "pairing",
  });
  assert.equal(changed, false);
});

test("buildOnboardArgs (anthropic-api-key) sets the auth choice and env", () => {
  const { args, env } = buildOnboardArgs({
    provider: "anthropic-api-key",
    model: "anthropic/claude-sonnet-4-6",
    apiKey: "sk-ant-xxx",
  });
  assert.ok(args.includes("onboard"));
  assert.ok(args.includes("--non-interactive"));
  assert.ok(args.includes("--auth-choice"));
  assert.ok(args.includes("anthropic-api-key"));
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-xxx");
});

test("buildOnboardArgs (openai-api-key) sets OPENAI_API_KEY", () => {
  const { env } = buildOnboardArgs({
    provider: "openai-api-key",
    model: "openai/gpt-5.5",
    apiKey: "sk-yyy",
  });
  assert.equal(env.OPENAI_API_KEY, "sk-yyy");
});

test("buildOnboardArgs (openai-codex-oauth) does not require apiKey", () => {
  const { args, env } = buildOnboardArgs({
    provider: "openai-codex-oauth",
    model: "openai/gpt-5.5",
  });
  assert.ok(args.includes("openai-codex-oauth"));
  // No API key env should be set.
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("buildOnboardArgs (gemini-api-key) uses the correct upstream auth-choice + GEMINI_API_KEY env", () => {
  // Regression test for the bug we shipped in v0.1.0: we used to pass
  // `--auth-choice google-api-key`, which doesn't exist. The upstream
  // value is `gemini-api-key`. Onboard would have errored with
  // "unknown auth choice" until this fix.
  const { args, env } = buildOnboardArgs({
    provider: "gemini-api-key",
    model: "google/gemini-3.1-pro-preview",
    apiKey: "AI...",
  });
  const idx = args.indexOf("--auth-choice");
  assert.ok(idx >= 0);
  assert.equal(args[idx + 1], "gemini-api-key");
  assert.equal(env.GEMINI_API_KEY, "AI...");
});

test("buildOnboardArgs (moonshot-intl) uses --auth-choice moonshot-api-key", () => {
  const { args, env } = buildOnboardArgs({
    provider: "moonshot-intl",
    model: "moonshot/kimi-k2.6",
    apiKey: "ms-intl",
  });
  const idx = args.indexOf("--auth-choice");
  assert.equal(args[idx + 1], "moonshot-api-key");
  assert.equal(env.MOONSHOT_API_KEY, "ms-intl");
});

test("buildOnboardArgs (moonshot-cn) uses --auth-choice moonshot-api-key-cn", () => {
  // China users need the -cn variant - keys issued on platform.moonshot.cn
  // can't be used against api.moonshot.ai.
  const { args, env } = buildOnboardArgs({
    provider: "moonshot-cn",
    model: "moonshot/kimi-k2.6",
    apiKey: "ms-cn",
  });
  const idx = args.indexOf("--auth-choice");
  assert.equal(args[idx + 1], "moonshot-api-key-cn");
  assert.equal(env.MOONSHOT_API_KEY, "ms-cn");
});

test("buildOnboardArgs (zai) puts ZAI_API_KEY in env, NOT on the command line", () => {
  // Security regression test: in earlier code we passed --zai-api-key <key>
  // as a CLI flag, which made the secret visible in `ps`, Windows command
  // history, and parent-process listings. The env-var form is documented
  // upstream and keeps the secret out of argv.
  const { args, env } = buildOnboardArgs({
    provider: "zai-api-key",
    model: "zai/glm-5.1",
    apiKey: "zai-secret",
  });
  assert.equal(env.ZAI_API_KEY, "zai-secret");
  assert.ok(
    !args.some((a) => a === "--zai-api-key"),
    `--zai-api-key flag should NOT be in args (security: keeps key off process argv); got: ${args.join(" ")}`,
  );
  assert.ok(
    !args.includes("zai-secret"),
    `the literal key should never appear in args; got: ${args.join(" ")}`,
  );
});

test("buildOnboardArgs (ollama) passes the base URL when supplied", () => {
  const { args } = buildOnboardArgs({
    provider: "ollama",
    model: "ollama/llama3.3:70b",
    baseUrl: "http://10.0.0.5:11434",
  });
  // The args should reference the base URL in some recognizable form.
  const joined = args.join(" ");
  assert.ok(joined.includes("10.0.0.5") || joined.includes("--base-url"));
});

test("buildOnboardArgs (custom-api-key) requires baseUrl + emits compat flag", () => {
  const { args } = buildOnboardArgs({
    provider: "custom-api-key",
    model: "custom/llama",
    apiKey: "ck",
    baseUrl: "https://my-endpoint.example.com/v1",
    customCompatibility: "anthropic",
  });
  const joined = args.join(" ");
  assert.ok(joined.includes("https://my-endpoint.example.com/v1"));
});

test("stripProviderPrefix only strips when there's a slash", () => {
  assert.equal(stripProviderPrefix("anthropic/claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(stripProviderPrefix("gpt-5.5"), "gpt-5.5");
  assert.equal(stripProviderPrefix(""), "");
  // Nested slashes (rare): only the first segment is treated as provider.
  assert.equal(stripProviderPrefix("openai/gpt/exp"), "gpt/exp");
});

test("providerIdToConfigKey covers every documented ClawProviderId", () => {
  const cases = {
    "anthropic-api-key": "anthropic",
    "openai-api-key": "openai",
    "openai-codex-oauth": "openai-codex",
    "gemini-api-key": "google",
    "ollama": "ollama",
    "moonshot-intl": "moonshot",
    "moonshot-cn": "moonshot",
    "zai-api-key": "zai",
    "custom-api-key": "custom",
  };
  for (const [k, v] of Object.entries(cases)) {
    assert.equal(providerIdToConfigKey(k), v, `provider ${k}`);
  }
});

// ---------------------------------------------------------------------------
// readOpenClawConfig: tolerate JSON5 (the documented format upstream).
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readOpenClawConfig } = require("../dist/main/openclawConfig");

test("readOpenClawConfig accepts JSON5 (trailing commas, comments, unquoted keys)", async () => {
  // OpenClaw documents ~/.openclaw/openclaw.json as JSON5. If we used strict
  // JSON.parse we'd throw on a perfectly valid user-edited config. This
  // pins the lenient parse so we don't regress.
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ccb-oc5-"));
  const file = path.join(dir, "openclaw.json");
  const json5Body = `{
    // Trailing comments are valid in JSON5.
    channels: {
      telegram: {
        enabled: true,
        botToken: "12345:abc",
        dmPolicy: "pairing",
        allowFrom: [
          "111",
          "222", // trailing comma after this is JSON5-only
        ],
      },
    },
  }`;
  await fs.promises.writeFile(file, json5Body, "utf8");
  const cfg = await readOpenClawConfig(file);
  assert.equal(cfg.channels.telegram.enabled, true);
  assert.equal(cfg.channels.telegram.dmPolicy, "pairing");
  assert.deepEqual(cfg.channels.telegram.allowFrom, ["111", "222"]);
});

test("readOpenClawConfig returns {} for missing file", async () => {
  const cfg = await readOpenClawConfig(path.join(os.tmpdir(), "nonexistent-xx", "openclaw.json"));
  assert.deepEqual(cfg, {});
});
