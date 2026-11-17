import { describe, expect, test } from "bun:test";
import { type OAuthState, REFRESH_EARLY_MS, authorizeUrl, discover, freshTokens, pkceChallenge, register, resourceMetadataUrl, tokenRequest } from "../cloud/src/mcp-oauth";
import { type McpServer, claudeMcpConfig, oauthVar, usableMcp, withOAuth } from "../app/mcp-servers";

/** A fake MCP server + authorization server. */
function fakeNet() {
  const calls: { url: string; body?: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
    if (url === "https://mcp.example.com/mcp") return new Response("", { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"' } });
    if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") return j({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"] });
    if (url === "https://auth.example.com/.well-known/oauth-authorization-server") return j({ authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token", registration_endpoint: "https://auth.example.com/register", scopes_supported: ["read"] });
    if (url === "https://auth.example.com/register") return j({ client_id: "cid-1" }, 201);
    if (url === "https://auth.example.com/token") {
      const b = new URLSearchParams(String(init?.body));
      if (b.get("grant_type") === "authorization_code") return j({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
      if (b.get("grant_type") === "refresh_token" && b.get("refresh_token") === "rt-1") return j({ access_token: "at-2", expires_in: 3600 });
      return j({ error: "invalid_grant" }, 400);
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

describe("MCP OAuth", () => {
  test("discovers, registers, authorizes with PKCE and resource, exchanges and refreshes", async () => {
    const { f, calls } = fakeNet();
    const found = (await discover(f, "https://mcp.example.com/mcp"))!;
    expect(found.resource).toBe("https://mcp.example.com/mcp");
    expect(found.meta.token_endpoint).toBe("https://auth.example.com/token");
    const client = (await register(f, found.meta, "https://hub.example.com/api/mcp-oauth/callback"))!;
    expect(client.client_id).toBe("cid-1");
    const s: OAuthState = { ...found, client };
    const u = new URL(authorizeUrl(s, "https://hub.example.com/api/mcp-oauth/callback", "st", await pkceChallenge("v")));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(u.searchParams.get("scope")).toBe("read");
    const now = 1_000_000;
    const t = (await tokenRequest(f, s, { grant_type: "authorization_code", code: "c", code_verifier: "v", redirect_uri: "x" }, now))!;
    expect(t).toEqual({ access_token: "at-1", refresh_token: "rt-1", expires_at: now + 3600_000 });
    // fresh enough: handed out as is
    expect((await freshTokens(f, { ...s, tokens: t }, now)).changed).toBe(false);
    // ending soon: refreshed, refresh token kept when not rotated
    const soon = await freshTokens(f, { ...s, tokens: t }, t.expires_at! - REFRESH_EARLY_MS + 1);
    expect(soon.changed).toBe(true);
    expect(soon.tokens).toMatchObject({ access_token: "at-2", refresh_token: "rt-1" });
    expect(calls.some((c) => c.url.endsWith("/token") && c.body?.includes("resource="))).toBe(true);
  });

  test("an ended token that cannot be renewed is not handed out", async () => {
    const { f } = fakeNet();
    const s = { meta: { authorization_endpoint: "https://a/x", token_endpoint: "https://auth.example.com/token" }, client: { client_id: "c" }, resource: "r", tokens: { access_token: "old", refresh_token: "bad", expires_at: 10 } };
    expect((await freshTokens(f, s, 20)).tokens).toBeNull();
  });

  test("a server without OAuth metadata is not signed in to", async () => {
    const f = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await discover(f, "https://plain.example.com/mcp")).toBeNull();
  });

  test("reads resource_metadata from WWW-Authenticate", () => {
    expect(resourceMetadataUrl('Bearer realm="x", resource_metadata="https://a/b"')).toBe("https://a/b");
    expect(resourceMetadataUrl(null)).toBeNull();
  });

  test("machines use the shared sign-in for remote servers without their own Authorization", () => {
    const list: McpServer[] = [
      { name: "linear", type: "http" as const, url: "https://mcp.linear.app/mcp", headers: {} },
      { name: "own", type: "http" as const, url: "https://x/mcp", headers: { Authorization: "Bearer ${OWN}" } },
    ];
    // not signed in: left as is (a server that needs sign-in then fails on its own, as before)
    expect(withOAuth(list, {})[0]!.headers).toEqual({});
    const env = { [oauthVar("linear")]: "tok", OWN: "o" };
    const used = usableMcp(withOAuth(list, env), env).use;
    expect(used[0]!.headers).toEqual({ Authorization: "Bearer ${NOOP_OAUTH_LINEAR}" });
    expect(used[1]!.headers).toEqual({ Authorization: "Bearer ${OWN}" });
    expect(JSON.parse(claudeMcpConfig(used, env)).mcpServers.linear.headers.Authorization).toBe("Bearer tok");
  });
});
