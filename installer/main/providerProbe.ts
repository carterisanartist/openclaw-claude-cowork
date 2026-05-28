/**
 * Lightweight reachability probes for each supported LLM provider.
 *
 * The goal of these probes is to give the user fast, honest feedback in the
 * GUI ("your Anthropic key works and here are the models you can pick"),
 * without trying to actually run a chat completion (which would cost money,
 * change behavior across providers, and slow the wizard down).
 *
 * We standardize on:
 *   - GET against the provider's "list models" endpoint where one exists.
 *   - GET /api/tags for Ollama.
 *   - GET <baseUrl>/v1/models for "custom" (OpenAI-compatible).
 *
 * All probes have a hard timeout so a broken/misconfigured network can't
 * freeze the installer.
 */

import type { ClawProviderId, TestProviderInput, TestProviderResult } from "../shared/ipc";

const DEFAULT_TIMEOUT_MS = 8_000;

export async function probeProvider(input: TestProviderInput): Promise<TestProviderResult> {
  const started = Date.now();
  try {
    const result = await probeOne(input, DEFAULT_TIMEOUT_MS);
    return { ...result, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function probeOne(
  input: TestProviderInput,
  timeoutMs: number,
): Promise<Omit<TestProviderResult, "latencyMs">> {
  const { provider } = input;
  switch (provider) {
    case "anthropic-api-key":
      return probeAnthropic(input, timeoutMs);
    case "openai-api-key":
      return probeOpenAI(input, timeoutMs, "https://api.openai.com");
    case "openai-codex-oauth":
      // Codex OAuth doesn't have an API-key probe; we tell the UI to skip.
      return {
        ok: true,
        models: [],
      };
    case "gemini-api-key":
      return probeGoogle(input, timeoutMs);
    case "ollama":
      return probeOllama(input, timeoutMs);
    case "moonshot-intl":
      // International endpoint: api.moonshot.ai. Override-able via baseUrl.
      return probeOpenAI(
        input,
        timeoutMs,
        input.baseUrl && input.baseUrl.length > 0 ? input.baseUrl : "https://api.moonshot.ai",
      );
    case "moonshot-cn":
      // China endpoint: api.moonshot.cn. Keys issued on platform.moonshot.cn
      // are not fully cross-routable to the international host - users
      // hitting "Test connection" with a CN key against the intl URL will
      // get a 401 / 403, hence the separate provider.
      return probeOpenAI(
        input,
        timeoutMs,
        input.baseUrl && input.baseUrl.length > 0 ? input.baseUrl : "https://api.moonshot.cn",
      );
    case "zai-api-key":
      // Z.AI / GLM exposes OpenAI-compatible /v1/models at https://api.z.ai.
      return probeOpenAI(
        input,
        timeoutMs,
        input.baseUrl && input.baseUrl.length > 0 ? input.baseUrl : "https://api.z.ai",
      );
    case "custom-api-key":
      return probeOpenAI(input, timeoutMs, requireBaseUrl(input));
    default: {
      const exhaustive: never = provider;
      return { ok: false, error: `Unknown provider: ${String(exhaustive)}` };
    }
  }
}

async function probeAnthropic(
  input: TestProviderInput,
  timeoutMs: number,
): Promise<Omit<TestProviderResult, "latencyMs">> {
  if (!input.apiKey) return { ok: false, error: "API key is required for Anthropic." };
  const res = await fetchWithTimeout(
    "https://api.anthropic.com/v1/models",
    {
      method: "GET",
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
      },
    },
    timeoutMs,
  );
  if (!res.ok) {
    return { ok: false, error: `Anthropic: HTTP ${res.status} ${await safeText(res)}` };
  }
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  const list = Array.isArray((body as { data?: unknown }).data)
    ? ((body as { data: Array<{ id?: string }> }).data
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string"))
    : [];
  return { ok: true, models: list.slice(0, 50) };
}

async function probeOpenAI(
  input: TestProviderInput,
  timeoutMs: number,
  baseUrl: string,
): Promise<Omit<TestProviderResult, "latencyMs">> {
  if (!input.apiKey) return { ok: false, error: "API key is required." };
  const url = joinUrl(baseUrl, "/v1/models");
  const res = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
      },
    },
    timeoutMs,
  );
  if (!res.ok) {
    return { ok: false, error: `${baseUrl}: HTTP ${res.status} ${await safeText(res)}` };
  }
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  const list = Array.isArray((body as { data?: unknown }).data)
    ? ((body as { data: Array<{ id?: string }> }).data
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string"))
    : [];
  return { ok: true, models: list.slice(0, 50) };
}

async function probeGoogle(
  input: TestProviderInput,
  timeoutMs: number,
): Promise<Omit<TestProviderResult, "latencyMs">> {
  if (!input.apiKey) return { ok: false, error: "API key is required for Google." };
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(input.apiKey)}`;
  const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
  if (!res.ok) {
    return { ok: false, error: `Google: HTTP ${res.status} ${await safeText(res)}` };
  }
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  type ModelEntry = { name?: string };
  const list = Array.isArray((body as { models?: unknown }).models)
    ? ((body as { models: ModelEntry[] }).models
        .map((m) => (typeof m.name === "string" ? m.name.replace(/^models\//, "") : null))
        .filter((id): id is string => typeof id === "string"))
    : [];
  return { ok: true, models: list.slice(0, 50) };
}

async function probeOllama(
  input: TestProviderInput,
  timeoutMs: number,
): Promise<Omit<TestProviderResult, "latencyMs">> {
  const base = (input.baseUrl && input.baseUrl.length > 0)
    ? input.baseUrl
    : "http://localhost:11434";
  const res = await fetchWithTimeout(joinUrl(base, "/api/tags"), { method: "GET" }, timeoutMs);
  if (!res.ok) {
    return { ok: false, error: `Ollama: HTTP ${res.status} ${await safeText(res)}` };
  }
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  type TagEntry = { name?: string };
  const list = Array.isArray((body as { models?: unknown }).models)
    ? ((body as { models: TagEntry[] }).models
        .map((m) => m.name)
        .filter((id): id is string => typeof id === "string"))
    : [];
  return { ok: true, models: list.slice(0, 50) };
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function requireBaseUrl(input: TestProviderInput): string {
  if (!input.baseUrl || input.baseUrl.length === 0) {
    throw new Error("baseUrl is required for the custom provider.");
  }
  return input.baseUrl;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 400);
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-export to keep ClawProviderId reachable for callers importing from this module.
export type { ClawProviderId };
