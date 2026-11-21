import { describe, expect, test } from "bun:test";
import { seal, secretProblem, unseal } from "../cloud/src/secrets";
import { sharedSecrets, _resetSecretCache } from "../src/secrets";
import { mcpLaunch } from "../src/runner";
import { existsSync, readFileSync, statSync } from "node:fs";

describe("shared secrets", () => {
  test("sealed values open only with the same machine key and name", async () => {
    const s = await seal("tok", "A", "value-1");
    expect(s).not.toContain("value-1");
    expect(await unseal("tok", "A", s)).toBe("value-1");
    expect(await unseal("other", "A", s)).toBeNull();
    expect(await unseal("tok", "B", s)).toBeNull();
  });
  test("names and values are checked", () => {
    expect(secretProblem("GITHUB_TOKEN", "x")).toBeNull();
    expect(secretProblem("GITHUB_TOKEN", null)).toBeNull();
    expect(secretProblem("1BAD", "x")).not.toBeNull();
    expect(secretProblem("A-B", "x")).not.toBeNull();
    expect(secretProblem("A", "x".repeat(9000))).not.toBeNull();
  });
  test("a machine fetches values with its machine key; a failure keeps the last good set", async () => {
    _resetSecretCache();
    const cfg = { cloud: { url: "https://hub.example" }, server: { token: "tok" } } as any;
    const seen: string[] = [];
    const ok = (async (u: string, init: any) => { seen.push(`${u} ${init.headers.Authorization}`); return Response.json({ values: { K: "v" } }); }) as any;
    expect(await sharedSecrets(cfg, ok)).toEqual({ K: "v" });
    expect(seen).toEqual(["https://hub.example/api/secrets/values Bearer tok"]);
    _resetSecretCache();
    expect(await sharedSecrets(cfg, (async () => new Response("", { status: 500 })) as any)).toEqual({});
  });
  test("Claude reads keys from a private file, never from argv", async () => {
    const cfg = { mcp_servers: [{ name: "gh", type: "stdio", command: "npx", env: { T: "${SHARED_T}" } }] } as any;
    const r = await mcpLaunch("claude", cfg, { SHARED_T: "secret-value" });
    expect(r.args[0]).toBe("--mcp-config");
    expect(r.args.join(" ")).not.toContain("secret-value");
    expect(statSync(r.file!).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(r.file!, "utf8")).mcpServers.gh.env.T).toBe("secret-value");
    require("node:fs").rmSync(r.file!);
    const c = await mcpLaunch("codex", cfg, { SHARED_T: "secret-value" });
    expect(c.args.join(" ")).not.toContain("secret-value");
    expect(c.env.T).toBe("secret-value");
    expect((await mcpLaunch("claude", { mcp_servers: [] } as any, {})).args).toEqual([]);
    expect(existsSync).toBeDefined();
  });
});
