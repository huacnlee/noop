import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountEnv, claudeApiEnv, claudeAuthArgs } from "../src/accounts";
import { HOME_DIR } from "../src/core";
import { FallbackModel, type Model } from "../src/brain";

test("parked API credentials are available without rewriting the settings file", () => {
  const dir = mkdtempSync(join(tmpdir(), "noop-api-"));
  const text = JSON.stringify({ env: { _ANTHROPIC_API_KEY: "test-key", _ANTHROPIC_BASE_URL: "https://gateway.example", OTHER: "keep" } });
  writeFileSync(join(dir, "settings.json"), text);
  expect(claudeApiEnv(dir)).toEqual({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: "https://gateway.example" });
  expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(text);
  const env = accountEnv({ cli: "claude", name: "api-test", dir, auth: "api" });
  expect(env.ANTHROPIC_API_KEY).toBe("test-key");
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
  expect(claudeAuthArgs(env)).toEqual([]);
});

test("subscription masks user API settings and receives the saved default login token", () => {
  mkdirSync(join(HOME_DIR, "accounts"), { recursive: true });
  writeFileSync(join(HOME_DIR, "accounts/state.json"), JSON.stringify({ seq: 0, accounts: { "claude-default": { token: "test-oauth-token" } } }));
  const env = accountEnv({ cli: "claude", name: "default", dir: "", default: true, auth: "oauth" });
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-oauth-token");
  expect(env.ANTHROPIC_API_KEY).toBe("");
  const args = claudeAuthArgs(env);
  const override = JSON.parse(args[1]);
  expect(override.env.ANTHROPIC_API_KEY).toBe("");
  expect(override.env.ANTHROPIC_AUTH_TOKEN).toBe("");
  expect(override.apiKeyHelper).toBe("");
  expect(args.join(" ")).not.toContain("test-oauth-token");
});

function model(send: (text: string) => string): Model {
  return { open: async () => ({ send: async (text) => send(text), close() {} }) };
}

test("auth failover replays context and retries the failed turn on the API account", async () => {
  const seen: string[] = [];
  const subscription = model((t) => { if (t === "next") throw new Error("usage limit"); return "ok"; });
  const api = model((t) => { seen.push(t); return "api reply"; });
  const session = await new FallbackModel([subscription, api], undefined, (e) => /usage limit/.test(String(e))).open("system");
  await session.send("first");
  expect(await session.send("next")).toBe("api reply");
  expect(seen).toEqual(["first", "next"]);
  session.close();
});

test("an unrelated model error does not spend API credits", async () => {
  let spent = false;
  const session = await new FallbackModel([
    model(() => { throw new Error("model timeout"); }), model(() => { spent = true; return "api"; }),
  ], undefined, (e) => /usage limit/.test(String(e))).open("system");
  await expect(session.send("hello")).rejects.toThrow("model timeout");
  expect(spent).toBe(false);
  session.close();
});

test("quota cooldown selects API then returns to subscription automatically", async () => {
  const { pickAccount, failoverAccount } = await import("../src/accounts");
  const cfg = { accounts: [
    { cli: "claude", name: "subscription-test", dir: "/nonexistent", auth: "oauth" },
    { cli: "claude", name: "api-test", dir: "/nonexistent", auth: "api" },
  ] } as any;
  const state = join(HOME_DIR, "accounts/state.json");
  const saved = readFileSync(state, "utf8");
  try {
    writeFileSync(state, JSON.stringify({ seq: 0, accounts: {} }));
    const primary = pickAccount(cfg, ["claude"])!;
    expect(primary.auth).toBe("oauth");
    writeFileSync(state, JSON.stringify({ seq: 0, accounts: { "claude-subscription-test": { cooldown_until: new Date(Date.now() + 60000).toISOString() } } }));
    expect(pickAccount(cfg, ["claude"])?.auth).toBe("api");
    expect(failoverAccount(cfg, primary, ["claude"], () => true)?.auth).toBe("api");
    writeFileSync(state, JSON.stringify({ seq: 0, accounts: { "claude-subscription-test": { cooldown_until: new Date(Date.now() - 1000).toISOString() } } }));
    expect(pickAccount(cfg, ["claude"])?.auth).toBe("oauth");
  } finally { writeFileSync(state, saved); }
});

test("shared Claude keys from Settings win over a machine's settings.json, without mixing in its base URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noop-api-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "local", ANTHROPIC_BASE_URL: "https://gw.local" } }));
  expect(claudeApiEnv(dir, {})).toEqual({ ANTHROPIC_API_KEY: "local", ANTHROPIC_BASE_URL: "https://gw.local" });
  expect(claudeApiEnv(dir, { ANTHROPIC_API_KEY: "shared" })).toEqual({ ANTHROPIC_API_KEY: "shared" });
  expect(claudeApiEnv(dir, { ANTHROPIC_API_KEY: "shared", ANTHROPIC_BASE_URL: "https://gw.team" })).toEqual({ ANTHROPIC_API_KEY: "shared", ANTHROPIC_BASE_URL: "https://gw.team" });
});

test("a shared setup-token is the subscription login on every machine", async () => {
  const { claudeOAuthToken } = await import("../src/accounts");
  const a = { cli: "claude", name: "default", dir: "", default: true, auth: "oauth" as const };
  expect(claudeOAuthToken(a, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-shared" })).toBe("sk-ant-oat-shared");
});
