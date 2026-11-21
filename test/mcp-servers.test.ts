import { describe, expect, test } from "bun:test";
import { claudeMcpConfig, codexMcpLaunch, looksSecret, mcpProblem, mcpServers, parsePairs, splitCommand, usableMcp } from "../app/mcp-servers";

const gh = { name: "github", type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}", LOG: "warn" } } as const;
const remote = { name: "docs", type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}", "X-Team": "noop" } } as const;

describe("shared MCP servers", () => {
  test("malformed entries are left out", () => {
    expect(mcpServers([gh, { name: "bad name", type: "stdio", command: "x" }, { name: "x", type: "http", url: "ftp://a" }, null]).map((s) => s.name)).toEqual(["github"]);
  });
  test("literal secrets are refused, variable references are fine", () => {
    expect(looksSecret("${GITHUB_TOKEN}")).toBe(false);
    expect(looksSecret("Bearer ${X}")).toBe(false);
    expect(looksSecret("warn")).toBe(false);
    expect(looksSecret("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
    expect(looksSecret("Bearer abcdefghijklmnop")).toBe(true);
    expect(mcpProblem({ ...gh, env: { T: "sk-abcdefghijklmnopqrstu" } } as any)).toEqual({ code: "secret", field: "T" });
    expect(mcpProblem(gh as any, [gh as any])).toEqual({ code: "duplicate" });
    expect(mcpProblem(gh as any)).toBeNull();
  });
  test("a machine without a variable leaves the server out", () => {
    const list = mcpServers([gh, remote, { ...gh, name: "off", enabled: false }]);
    const r = usableMcp(list, { GITHUB_TOKEN: "t" });
    expect(r.use.map((s) => s.name)).toEqual(["github"]);
    expect(r.missing).toEqual([{ name: "docs", vars: ["DOCS_TOKEN"] }]);
  });
  test("Claude gets the references unexpanded", () => {
    const cfg = JSON.parse(claudeMcpConfig(mcpServers([gh, remote])));
    expect(cfg.mcpServers.github).toEqual({ type: "stdio", command: "npx", args: gh.args, env: gh.env });
    expect(cfg.mcpServers.docs.headers.Authorization).toBe("Bearer ${DOCS_TOKEN}");
  });
  test("Claude's private file gets the values filled in", () => {
    const cfg = JSON.parse(claudeMcpConfig(mcpServers([gh, remote]), { GITHUB_TOKEN: "t", DOCS_TOKEN: "d" }));
    expect(cfg.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("t");
    expect(cfg.mcpServers.docs.headers.Authorization).toBe("Bearer d");
  });
  test("Codex gets -c overrides, keys only through its environment", () => {
    const { args, env } = codexMcpLaunch(mcpServers([gh, remote]), { GITHUB_TOKEN: "t", DOCS_TOKEN: "d" });
    expect(args).toEqual([
      "-c", 'mcp_servers.github={command="npx",args=["-y","@modelcontextprotocol/server-github"],env_vars=["GITHUB_PERSONAL_ACCESS_TOKEN"],env={"LOG"="warn"}}',
      "-c", 'mcp_servers.docs={url="https://mcp.example.com/mcp",bearer_token_env_var="DOCS_TOKEN",http_headers={"X-Team"="noop"}}',
    ]);
    expect(env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "t", DOCS_TOKEN: "d" });
    expect(args.join(" ")).not.toMatch(/="t"|="d"/);
    const h = codexMcpLaunch(mcpServers([{ name: "x", type: "http", url: "https://x.dev/mcp", headers: { "X-Key": "k-${K}", Authorization: "Bearer pre-${K}" } }]), { K: "s" });
    expect(h.args[1]).toContain('bearer_token_env_var="NOOP_MCP_0_X_BEARER"');
    expect(h.args[1]).toContain('env_http_headers={"X-Key"="NOOP_MCP_0_X_H0"}');
    expect(h.env).toEqual({ NOOP_MCP_0_X_BEARER: "pre-s", NOOP_MCP_0_X_H0: "k-s" });
  });
  test("editing helpers", () => {
    expect(splitCommand(`npx -y "a b" 'c'`)).toEqual(["npx", "-y", "a b", "c"]);
    expect(parsePairs("A=1\n\nB = x=y\nbad", "=")).toEqual({ A: "1", B: "x=y" });
    expect(parsePairs("Authorization: Bearer ${X}", ":")).toEqual({ Authorization: "Bearer ${X}" });
  });
});
