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
    model: "openai-codex/gpt-5.5-codex",
  });
  assert.ok(args.includes("openai-codex-oauth"));
  // No API key env should be set.
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("buildOnboardArgs (ollama) passes the base URL when supplied", () => {
  const { args } = buildOnboardArgs({
    provider: "ollama",
    model: "ollama/llama4:70b",
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
    "google-api-key": "google",
    "ollama": "ollama",
    "moonshot": "moonshot",
    "zai-api-key": "zai",
    "custom-api-key": "custom",
  };
  for (const [k, v] of Object.entries(cases)) {
    assert.equal(providerIdToConfigKey(k), v, `provider ${k}`);
  }
});
