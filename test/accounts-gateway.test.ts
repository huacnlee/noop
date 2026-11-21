// A claude CLI pointed at an API gateway (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json or
// the environment) has no OAuth login to refresh: `claude setup-token` 401s against the gateway. An auth-shaped
// failure must be a cooldown, not a needs_login flag that mails a dead link every 30 minutes (L-0288…L-0310).
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexGatewayAuth, gatewayAuth } from "../src/accounts";

function settingsDir(env: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "noop-gateway-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ env }));
  return dir;
}

test("detects the gateway env block in settings.json", () => {
  const dir = settingsDir({ ANTHROPIC_BASE_URL: "http://127.0.0.1:3425", ANTHROPIC_AUTH_TOKEN: "magpie" });
  expect(gatewayAuth(dir, {})).toBe("auth-token");
});

test("detects an inherited gateway base URL", () => {
  expect(gatewayAuth("/nonexistent", { ANTHROPIC_BASE_URL: "https://gateway.example.com" })).toBe("base-url");
});

test("the process env overrides the file", () => {
  const dir = settingsDir({ ANTHROPIC_BASE_URL: "http://127.0.0.1:3425" });
  expect(gatewayAuth(dir, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toBe(null);
});

test("plain OAuth machines are not gateway accounts", () => {
  expect(gatewayAuth("/nonexistent", {})).toBe(null);
});

// A codex CLI pointed at a gateway (model_provider → [model_providers.*] with a bearer token or a non-OpenAI
// base URL) has no ChatGPT OAuth login to refresh either: `codex login --device-auth` exits at once against it,
// so an auth failure parked the account and re-sent a dead link every 30 minutes (L-0019…L-0073, 73 links).
function codexDir(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "noop-codex-gateway-"));
  writeFileSync(join(dir, "config.toml"), toml);
  return dir;
}

test("codex gateway: a custom provider with a bearer token counts as gateway auth", () => {
  const dir = codexDir(`
model_provider = "custom"
[model_providers.custom]
name = "opencode_go"
base_url = "https://opencode.ai/zen/go/v1"
experimental_bearer_token = "sk-x"
`);
  expect(codexGatewayAuth(dir)).toBe("api-key");
});

test("codex gateway: env_key alone is enough", () => {
  const dir = codexDir(`model_provider = "gw"\n[model_providers.gw]\nenv_key = "MY_KEY"\n`);
  expect(codexGatewayAuth(dir)).toBe("api-key");
});

test("codex gateway: a non-OpenAI base URL counts even without a token field", () => {
  const dir = codexDir(`model_provider = "gw"\n[model_providers.gw]\nbase_url = "https://gateway.example.com/v1"\n`);
  expect(codexGatewayAuth(dir)).toBe("base-url");
});

test("codex gateway: the default openai provider is a real login", () => {
  const dir = codexDir(`model_provider = "openai"\n[model_providers.openai]\nbase_url = "https://api.openai.com/v1"\n`);
  expect(codexGatewayAuth(dir)).toBe(null);
});

test("codex gateway: an unreadable or missing config is not a gateway", () => {
  expect(codexGatewayAuth("/nonexistent")).toBe(null);
  expect(codexGatewayAuth(codexDir("not = [valid toml"))).toBe(null);
});
