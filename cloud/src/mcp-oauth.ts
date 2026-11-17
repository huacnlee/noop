// Signing in to a remote MCP server once, for every machine (Settings → MCP → a server's "Sign in").
//
// The MCP authorization flow (spec 2025-06-18): the server's protected-resource metadata (RFC 9728) names its
// authorization server; that server's metadata (RFC 8414, or OpenID discovery) gives the endpoints; the Worker
// registers itself as a client (RFC 7591) when the server allows it, then runs an authorization-code flow with PKCE
// (S256) and the `resource` parameter (RFC 8707). The browser only ever sees the authorization page; the code comes
// back to the Worker, which exchanges it.
//
// Tokens live where the shared keys live (secrets.ts): AES-GCM sealed in the Worker's storage, never in the data
// repo or settings. The owner's app sees only "signed in, until when"; machines receive the current access token with
// the shared keys. The Worker alone holds the refresh token and refreshes before expiry, so machines never race over a
// rotating refresh token.

export type OAuthMeta = { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; scopes_supported?: string[] };
export type OAuthClient = { client_id: string; client_secret?: string };
export type OAuthTokens = { access_token: string; refresh_token?: string; expires_at?: number; scope?: string };
/** Everything kept per server (sealed). */
export type OAuthState = { meta: OAuthMeta; client: OAuthClient; resource: string; tokens?: OAuthTokens };

/** A token that ends within this is refreshed before it is handed out (agent runs last up to an hour). */
export const REFRESH_EARLY_MS = 15 * 60_000;
/** A started sign-in that is not finished within this is dropped. */
export const PENDING_TTL_MS = 10 * 60_000;

export { oauthVar } from "../../app/mcp-servers";

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function pkceChallenge(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

type F = typeof fetch;
const getJson = async (f: F, url: string): Promise<Record<string, unknown> | null> => {
  const r = await f(url, { headers: { Accept: "application/json", "MCP-Protocol-Version": "2025-06-18" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return r?.ok ? ((await r.json().catch(() => null)) as Record<string, unknown> | null) : null;
};
const httpsOnly = (u: unknown): u is string => typeof u === "string" && /^https:\/\//.test(u);

/** `resource_metadata="…"` of a 401's WWW-Authenticate. */
export const resourceMetadataUrl = (header: string | null) => header?.match(/resource_metadata="([^"]+)"/)?.[1] ?? null;

/** Find the authorization server of an MCP server and its endpoints. null: it does not do OAuth. */
export async function discover(f: F, serverUrl: string): Promise<{ meta: OAuthMeta; resource: string } | null> {
  const u = new URL(serverUrl);
  // 1. protected-resource metadata: from the 401's header, else the well-known paths (path-aware first)
  let prm: Record<string, unknown> | null = null;
  const probe = await f(serverUrl, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "noop", version: "1" } } }),
    signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const hinted = probe?.status === 401 ? resourceMetadataUrl(probe.headers.get("www-authenticate")) : null;
  for (const m of [hinted, `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`]) {
    if (m && (prm = await getJson(f, m))) break;
  }
  const issuer = Array.isArray(prm?.authorization_servers) && typeof prm.authorization_servers[0] === "string" ? prm.authorization_servers[0] : u.origin;
  const resource = typeof prm?.resource === "string" ? prm.resource : serverUrl;
  // 2. authorization-server metadata (RFC 8414 path insertion, then OpenID discovery)
  const iu = new URL(issuer);
  const path = iu.pathname === "/" ? "" : iu.pathname.replace(/\/$/, "");
  let as: Record<string, unknown> | null = null;
  for (const m of [`${iu.origin}/.well-known/oauth-authorization-server${path}`, `${iu.origin}/.well-known/openid-configuration${path}`, `${iu.origin}${path}/.well-known/openid-configuration`]) {
    if ((as = await getJson(f, m))) break;
  }
  if (!as || !httpsOnly(as.authorization_endpoint) || !httpsOnly(as.token_endpoint)) return null;
  return {
    resource,
    meta: {
      authorization_endpoint: as.authorization_endpoint, token_endpoint: as.token_endpoint,
      ...(httpsOnly(as.registration_endpoint) ? { registration_endpoint: as.registration_endpoint } : {}),
      ...(Array.isArray(as.scopes_supported) ? { scopes_supported: as.scopes_supported.filter((s): s is string => typeof s === "string") } : {}),
    },
  };
}

/** Dynamic client registration. null when the server does not offer it (then a client id must be given). */
export async function register(f: F, meta: OAuthMeta, redirectUri: string): Promise<OAuthClient | null> {
  if (!meta.registration_endpoint) return null;
  const r = await f(meta.registration_endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_name: "Noop", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const j = r?.ok ? ((await r.json().catch(() => null)) as Record<string, unknown> | null) : null;
  if (!j || typeof j.client_id !== "string") return null;
  return { client_id: j.client_id, ...(typeof j.client_secret === "string" ? { client_secret: j.client_secret } : {}) };
}

export function authorizeUrl(s: OAuthState, redirectUri: string, state: string, challenge: string): string {
  const u = new URL(s.meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", s.client.client_id);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", s.resource);
  if (s.meta.scopes_supported?.length) u.searchParams.set("scope", s.meta.scopes_supported.join(" "));
  return u.toString();
}

/** POST to the token endpoint; null on any failure. Keeps the old refresh token when the server does not rotate it. */
export async function tokenRequest(f: F, s: OAuthState, params: Record<string, string>, now = Date.now()): Promise<OAuthTokens | null> {
  const body = new URLSearchParams({ ...params, client_id: s.client.client_id, resource: s.resource });
  if (s.client.client_secret) body.set("client_secret", s.client.client_secret);
  const r = await f(s.meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const j = r?.ok ? ((await r.json().catch(() => null)) as Record<string, unknown> | null) : null;
  if (!j || typeof j.access_token !== "string") return null;
  return {
    access_token: j.access_token,
    ...(typeof j.refresh_token === "string" ? { refresh_token: j.refresh_token } : s.tokens?.refresh_token ? { refresh_token: s.tokens.refresh_token } : {}),
    ...(typeof j.expires_in === "number" ? { expires_at: now + j.expires_in * 1000 } : {}),
    ...(typeof j.scope === "string" ? { scope: j.scope } : {}),
  };
}

/** The tokens to hand out now: as they are, refreshed when they end soon, or null when they ended and cannot be renewed. */
export async function freshTokens(f: F, s: OAuthState, now = Date.now()): Promise<{ tokens: OAuthTokens | null; changed: boolean }> {
  const t = s.tokens;
  if (!t) return { tokens: null, changed: false };
  if (!t.expires_at || t.expires_at - now > REFRESH_EARLY_MS) return { tokens: t, changed: false };
  if (t.refresh_token) {
    const n = await tokenRequest(f, s, { grant_type: "refresh_token", refresh_token: t.refresh_token }, now);
    if (n) return { tokens: n, changed: true };
  }
  return { tokens: t.expires_at > now ? t : null, changed: false };
}

/** The small page the browser lands on after signing in. */
export function callbackPage(ok: boolean, title: string, text: string): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#222}@media(prefers-color-scheme:dark){body{background:#161616;color:#eee}}main{max-width:360px;padding:24px}h1{font-size:18px;margin:0 0 6px}p{margin:0;opacity:.7}</style>
<main><h1>${ok ? "✓ " : ""}${esc(title)}</h1><p>${esc(text)}</p></main>`, { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
