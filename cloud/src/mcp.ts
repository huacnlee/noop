// Remote MCP server for noop: lets Claude (claude.ai connectors, Claude Code) and ChatGPT (connectors / developer mode)
// read the fleet's state, talk to it like the owner does in chat, and receive live events.
//
// Transport: MCP Streamable HTTP (spec 2025-06-18 / 2025-11-25), hand-rolled JSON-RPC — no SDK dependency.
//   POST   /mcp  one JSON-RPC message → application/json response (202 for notifications / responses)
//   POST   tools/call that reports progress (or wait_for_events) with Accept: text/event-stream → SSE: notifications/progress, then the response
//   GET    /mcp  Accept: text/event-stream → server→client notifications for this Mcp-Session-Id; Last-Event-ID resumes any stream
//   DELETE /mcp  ends the session
// Sessions: 400 without Mcp-Session-Id, 404 when unknown or idle > 24h (client re-initializes); MCP-Protocol-Version validated.
// Every SSE message has an id (<stream>.<seq>) and is kept for replay (15 min / 500 per stream); `retry:` hint, keep-alive comments.
// notifications/cancelled aborts the matching in-flight request (no response is sent); resources/list_changed when open tasks/decisions change.
// Notifications: every hub event as notifications/message (logger "noop", honours logging/setLevel), and
//   notifications/resources/updated for subscribed resources (noop://status, noop://feed, noop://tasks/<id>).
//   Clients that ignore notifications can poll with the `wait_for_events` tool.
// Auth (Bearer): HUB_TOKEN, an owner session, or an OAuth 2.1 access token (which *is* an owner session, minted by
//   /oauth/token after the owner signs in with the email code). Unauthenticated → 401 + WWW-Authenticate pointing at
//   /.well-known/oauth-protected-resource, which leads to /.well-known/oauth-authorization-server:
//   POST /oauth/register (dynamic client registration, public clients + PKCE S256 only)
//   GET|POST /oauth/authorize (email-code sign-in page) · POST /oauth/token (authorization_code, refresh_token)
// Never exposed: merge, release, settings, machine credentials.

export interface McpSql { exec(query: string, ...bindings: any[]): { toArray(): any[] } }
type Ev = { id: string; ts: string; from: string; kind: string; text: string; ref?: string; [k: string]: unknown };

/** What the MCP layer needs from the Hub Durable Object. */
export interface McpHost {
  sql: McpSql;
  status(): any;
  /** Events with seq > after (oldest first). */
  events(after: number, limit: number): { seq: number; ev: Ev }[];
  /** Same as POST /api/messages from the owner. */
  say(text: string, ref?: string): Ev;
  /** Email-code sign-in, reused from /api/auth/*. */
  startCode(email: string): Promise<{ status: number; body: any }>;
  /** Checks the code; on success returns the email (no browser session is created). */
  checkCode(email: string, code: string): Promise<{ email?: string; error?: string }>;
  /** Creates an owner session for this email; returns the raw bearer token. */
  newSession(email: string, ua: string): Promise<string>;
  dropSession(raw: string): Promise<void>;
}

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "noop", title: "noop", version: "1.0.0" };
const LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
const OAUTH_CODE_TTL = 5 * 60_000;
const TASK_STATES = ["inbox", "active", "waiting", "blocked", "failed", "done"] as const;
const TASK_ID = /^T-[\w-]*\d{4}$/, DECISION_ID = /^[DP]-[\w]*\d{4}$/;

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id, www-authenticate",
};
const json = (d: unknown, status = 200, h: Record<string, string> = {}) => Response.json(d, { status, headers: { ...CORS, ...h } });
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
export const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const pkceChallenge = async (verifier: string) => b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function initMcpSchema(sql: McpSql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, json TEXT, created INTEGER);
    CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT, redirect_uri TEXT, challenge TEXT, email TEXT, expires INTEGER);
    CREATE TABLE IF NOT EXISTS oauth_refresh (hash TEXT PRIMARY KEY, client_id TEXT, email TEXT, session TEXT, created INTEGER);
    CREATE TABLE IF NOT EXISTS mcp_sessions (id TEXT PRIMARY KEY, level TEXT, subs TEXT, created INTEGER, last INTEGER);
    CREATE TABLE IF NOT EXISTS mcp_events (session TEXT, stream TEXT, seq INTEGER, data TEXT, ts INTEGER, PRIMARY KEY (session, stream, seq));`);
  for (const col of ["version TEXT", "g_seen INTEGER DEFAULT 0"]) { // added after the first deploy
    try { sql.exec(`ALTER TABLE mcp_sessions ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}

// ---------------------------------------------------------------- hub data views (files table mirrors ~/.agent-hub/data)

/** `---\nk: v\n---\nbody` → {meta, body}. */
export function parseDoc(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { meta, body: m[2] };
}
const textOf = (c: unknown) => typeof c === "string" ? c : new TextDecoder().decode(c instanceof ArrayBuffer ? new Uint8Array(c) : c as Uint8Array);

function readFile(sql: McpSql, path: string) {
  const r = sql.exec("SELECT content, updated FROM files WHERE path = ? AND deleted = 0", path).toArray()[0];
  return r ? { text: textOf(r.content), updated: r.updated as string } : null;
}
function listDir(sql: McpSql, dir: string) {
  return sql.exec("SELECT path, content, updated FROM files WHERE path >= ? AND path < ? AND deleted = 0 ORDER BY path DESC LIMIT 2000",
    dir, dir.slice(0, -1) + "0").toArray().map((r) => ({ path: r.path as string, text: textOf(r.content), updated: r.updated as string }));
}

type TaskRow = { id: string; title: string; state: string; agent?: string; host?: string; priority?: string; repo?: string; created?: string; updated?: string };
const taskRow = (path: string, text: string, updated: string): TaskRow => {
  const { meta } = parseDoc(text);
  return { id: meta.id || path.split("/").pop()!.replace(/\.md$/, ""), title: meta.title ?? "", state: path.split("/")[1],
    agent: meta.agent, host: meta.claimed_by || meta.host, priority: meta.priority, repo: meta.repo, created: meta.created, updated };
};
export function listTasks(sql: McpSql, state = "open", query = "", limit = 50): TaskRow[] {
  const states = state === "all" ? TASK_STATES : state === "open" ? TASK_STATES.filter((s) => s !== "done" && s !== "failed") : [state];
  const q = query.toLowerCase();
  return states.flatMap((s) => listDir(sql, `tasks/${s}/`).filter((f) => /\/T-[^/]*\.md$/.test(f.path)).map((f) => taskRow(f.path, f.text, f.updated)))
    .filter((t) => !q || `${t.id} ${t.title} ${t.repo ?? ""} ${t.agent ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "")).slice(0, Math.max(1, Math.min(limit, 200)));
}
export function getTask(sql: McpSql, id: string) {
  for (const s of TASK_STATES) {
    const f = readFile(sql, `tasks/${s}/${id}.md`);
    if (f) { const { meta, body } = parseDoc(f.text); return { ...taskRow(`tasks/${s}/${id}.md`, f.text, f.updated), meta, body: body.slice(0, 20_000) }; }
  }
  return null;
}
const options = (s?: string) => (s ?? "").split(" | ").map((x) => x.trim()).filter(Boolean);
export function listDecisions(sql: McpSql, which: "open" | "closed" = "open", limit = 30) {
  return listDir(sql, `decisions/${which}/`).filter((f) => f.path.endsWith(".md")).slice(0, limit).map((f) => {
    const { meta, body } = parseDoc(f.text);
    return { id: meta.id, question: meta.question, options: options(meta.options), recommendation: meta.recommendation, task: meta.task,
      agent: meta.agent, created: meta.created, answer: meta.answer, context: body.match(/## Context\n([\s\S]*?)(\n## |$)/)?.[1]?.trim().slice(0, 4000) };
  });
}

// ---------------------------------------------------------------- tools
type Tool = { name: string; title: string; description: string; inputSchema: any; annotations: Record<string, boolean>; write?: boolean };
const RO = { readOnlyHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const str = (description: string, extra: object = {}) => ({ type: "string", description, ...extra });
const int = (description: string, extra: object = {}) => ({ type: "integer", description, ...extra });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS: Tool[] = [
  { name: "get_status", title: "Fleet status", annotations: RO, inputSchema: obj({}),
    description: "Current state of the noop fleet: online machines, running tasks with their latest activity, task counts per state, and decisions waiting for the owner." },
  { name: "list_tasks", title: "List tasks", annotations: RO,
    inputSchema: obj({ state: str("Which tasks: open (default: queued, running, waiting, blocked), all, or one state", { enum: ["open", "all", ...TASK_STATES] }),
      query: str("Case-insensitive filter on id, title, repo, agent"), limit: int("Max rows (default 50, max 200)", { minimum: 1, maximum: 200 }) }),
    description: "List the fleet's tasks (id, title, state, agent, host, repo), newest first." },
  { name: "get_task", title: "Get task", annotations: RO, inputSchema: obj({ id: str("Task id, e.g. T-0184") }, ["id"]),
    description: "One task in full: its metadata, its description/result notes, and the recent feed events about it." },
  { name: "list_decisions", title: "Open decisions", annotations: RO,
    inputSchema: obj({ which: str("open (default) or closed", { enum: ["open", "closed"] }), limit: int("Max rows (default 30)", { minimum: 1, maximum: 100 }) }),
    description: "Decision cards waiting for the owner (question, options, recommendation, context). Answer one with answer_decision." },
  { name: "get_feed", title: "Read the feed", annotations: RO,
    inputSchema: obj({ cursor: int("Return events after this cursor (from a previous call); omit for the latest ones"), limit: int("Max events (default 50, max 300)", { minimum: 1, maximum: 300 }) }),
    description: "The chat/activity feed the owner sees in the noop app: agent reports, decisions, owner messages, system notices. Returns {cursor, events}; pass cursor back to get only newer events." },
  { name: "wait_for_events", title: "Wait for new events", annotations: RO,
    inputSchema: obj({ cursor: int("Cursor from get_feed / a previous wait"), timeout_seconds: int("How long to wait (default 30, max 50)", { minimum: 1, maximum: 50 }) }, ["cursor"]),
    description: "Blocks until the fleet emits new events after `cursor` (or the timeout passes) and returns them. For clients that do not receive MCP notifications." },
  { name: "send_message", title: "Message the fleet", annotations: RW, write: true,
    inputSchema: obj({ text: str("The message, as the owner would type it in chat"), reply_to: str("Optional: task id (T-…) or event id this replies to") }, ["text"]),
    description: "Send a chat message to the fleet as the owner (same as typing in the noop app). The lead agent turns requests into tasks." },
  { name: "create_task", title: "Create a task", annotations: RW, write: true,
    inputSchema: obj({ title: str("Short imperative title"), details: str("Goal, context and acceptance criteria"), repo: str("Optional repo, e.g. longbridge/nsh") }, ["title"]),
    description: "Ask the fleet to do a piece of work. It is posted as an owner request; the lead agent plans it, picks the agent/machine and reports back in the feed." },
  { name: "answer_decision", title: "Answer a decision", annotations: RW, write: true,
    inputSchema: obj({ id: str("Decision id, e.g. D-0025"), answer: str("An option letter (A, B, …) or a free-text answer") }, ["id", "answer"]),
    description: "Answer an open decision card, exactly like tapping an option in the noop app." },
  { name: "search", title: "Search", annotations: RO, inputSchema: obj({ query: str("What to look for") }, ["query"]),
    description: "Search noop tasks and decisions. Returns {results:[{id, title, url}]}; use fetch with an id for the full text." },
  { name: "fetch", title: "Fetch", annotations: RO, inputSchema: obj({ id: str("An id from search: a task (T-…) or decision (D-…)") }, ["id"]),
    description: "Full text of a task or decision found by search. Returns {id, title, text, url, metadata}." },
];

// ---------------------------------------------------------------- server
// Streams. Every SSE message carries `id: <stream>.<seq>` and is kept per session in mcp_events (bounded by count and age),
// so a client that reconnects with Last-Event-ID gets exactly what it missed on *that* stream:
//   "g"      the session's standalone GET stream (one live connection per session; a new GET replaces the old one)
//   "p<hex>" the SSE response to one POST (progress notifications, then the JSON-RPC response)
type Live = { session: string; stream: string; write: (s: string) => void; close: () => void };
type Who = "machine" | { session: string };
type Ctx = { signal?: AbortSignal; progress?: (progress: number, total?: number, message?: string) => void };

export const SESSION_IDLE_MS = 24 * 3600_000;
const REPLAY_KEEP_MS = 15 * 60_000, REPLAY_MAX = 500, RETRY_MS = 3000;
const sseMsg = (id: string, m: unknown) => `id: ${id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`;
const rpcErr = (status: number, code: number, message: string) => json({ jsonrpc: "2.0", id: null, error: { code, message } }, status);

export class Mcp {
  /** Every open SSE connection (GET and POST). */
  streams = new Set<Live>();
  conns = new Map<string, Live>(); // `${session} ${stream}` → live connection
  waiters = new Set<() => void>();
  inflight = new Map<string, { ac: AbortController; stream?: string }>(); // `${session} ${JSON(id)}`
  keepAliveMs = 15_000;
  progressEveryMs = 5_000;
  private listSig: string | undefined;
  constructor(private h: McpHost) { initMcpSchema(h.sql); }

  // -------- live events
  /** Called by the Hub for every appended event. */
  onEvent(ev: Ev) {
    for (const w of [...this.waiters]) w();
    const uris = ["noop://feed"];
    for (const id of new Set([ev.ref, ...String(ev.text ?? "").matchAll(/\bT-[\w]*\d{4}\b/g)].map((x) => (Array.isArray(x) ? x[0] : x)).filter((x): x is string => typeof x === "string" && TASK_ID.test(x))))
      uris.push(`noop://tasks/${id}`);
    if (ev.kind === "decision") uris.push("noop://decisions");
    this.broadcast({ level: ev.kind === "decision" ? "warning" : ev.kind === "system" ? "debug" : "info", data: ev }, uris, ev.kind === "decision" && this.listChanged());
  }
  /** Status snapshot or task/decision files changed. */
  onChanged(uris: string[]) { this.broadcast(null, uris, uris.some((u) => u.startsWith("noop://tasks/") || u === "noop://decisions") && this.listChanged()); }

  /** Did the set of listed resources (open tasks, open decisions) change since we last looked? */
  listChanged() {
    const sig = this.resourceList().map((r) => r.uri).sort().join(" ");
    const changed = this.listSig !== undefined && sig !== this.listSig;
    this.listSig = sig;
    return changed;
  }

  broadcast(log: { level: string; data: unknown } | null, uris: string[], listChanged = false) {
    const now = Date.now();
    const rows = this.h.sql.exec("SELECT id, level, subs, g_seen FROM mcp_sessions WHERE g_seen > 0").toArray();
    for (const row of rows) {
      const sid = row.id as string;
      // Keep writing for a disconnected stream for a while, so a reconnect with Last-Event-ID can replay it.
      if (!this.conns.has(`${sid} g`) && now - Number(row.g_seen) > REPLAY_KEEP_MS) continue;
      const min = LEVELS.indexOf((row.level as string) || "info");
      if (log && LEVELS.indexOf(log.level) >= min) this.send(sid, "g", { jsonrpc: "2.0", method: "notifications/message", params: { level: log.level, logger: "noop", data: log.data } });
      const subs: string[] = JSON.parse(row.subs as string || "[]");
      for (const uri of uris) if (subs.includes(uri)) this.send(sid, "g", { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri, title: uri } });
      if (listChanged) this.send(sid, "g", { jsonrpc: "2.0", method: "notifications/resources/list_changed" });
    }
  }

  /** Stores the message for replay and writes it to the live connection of that stream, if any. */
  send(session: string, stream: string, msg: unknown) {
    const sql = this.h.sql;
    const seq = Number(sql.exec("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM mcp_events WHERE session = ? AND stream = ?", session, stream).toArray()[0]?.n ?? 1);
    sql.exec("INSERT INTO mcp_events (session, stream, seq, data, ts) VALUES (?, ?, ?, ?, ?)", session, stream, seq, JSON.stringify(msg), Date.now());
    if (seq % 50 === 0) sql.exec("DELETE FROM mcp_events WHERE session = ? AND ((stream = ? AND seq <= ?) OR ts < ?)", session, stream, seq - REPLAY_MAX, Date.now() - REPLAY_KEEP_MS);
    this.conns.get(`${session} ${stream}`)?.write(sseMsg(`${stream}.${seq}`, msg));
  }

  /** Opens an SSE response bound to (session, stream). */
  connect(session: string, stream: string, version: string, req: Request, replayAfter?: number): { live: Live; res: Response } {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const w = writable.getWriter(), enc = new TextEncoder(), key = `${session} ${stream}`;
    let timer: ReturnType<typeof setInterval> | undefined, closed = false;
    const live: Live = {
      session, stream,
      write: (s) => { if (!closed) w.write(enc.encode(s)).catch(() => live.close()); },
      close: () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        this.streams.delete(live);
        if (this.conns.get(key) === live) this.conns.delete(key);
        if (stream === "g") this.h.sql.exec("UPDATE mcp_sessions SET g_seen = ? WHERE id = ?", Date.now(), session);
        w.close().catch(() => {});
      },
    };
    this.conns.get(key)?.close(); // one live connection per stream
    this.conns.set(key, live);
    this.streams.add(live);
    live.write(`retry: ${RETRY_MS}\n\n`);
    if (replayAfter !== undefined) {
      for (const r of this.h.sql.exec("SELECT seq, data FROM mcp_events WHERE session = ? AND stream = ? AND seq > ? ORDER BY seq", session, stream, replayAfter).toArray())
        live.write(`id: ${stream}.${r.seq}\nevent: message\ndata: ${r.data}\n\n`);
    } else if (version >= "2025-11-25") { // prime the client with an event id so it can resume even before the first message
      const n = Number(this.h.sql.exec("SELECT COALESCE(MAX(seq), 0) AS n FROM mcp_events WHERE session = ? AND stream = ?", session, stream).toArray()[0]?.n ?? 0);
      live.write(`id: ${stream}.${n}\ndata: \n\n`);
    }
    timer = setInterval(() => live.write(": ping\n\n"), this.keepAliveMs);
    req.signal?.addEventListener?.("abort", () => live.close());
    return { live, res: new Response(readable, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "mcp-session-id": session } }) };
  }

  /** The session row if it exists and hasn't expired; expired sessions are dropped. */
  session(sid: string): { id: string; version: string } | null {
    if (!sid) return null;
    const r = this.h.sql.exec("SELECT id, version, last FROM mcp_sessions WHERE id = ?", sid).toArray()[0];
    if (!r) return null;
    if (Number(r.last) < Date.now() - SESSION_IDLE_MS) { this.endSession(sid); return null; }
    return { id: sid, version: (r.version as string) || "2025-03-26" };
  }
  endSession(sid: string) {
    this.h.sql.exec("DELETE FROM mcp_sessions WHERE id = ?", sid);
    this.h.sql.exec("DELETE FROM mcp_events WHERE session = ?", sid);
    for (const s of [...this.streams]) if (s.session === sid) s.close();
    for (const [k, f] of this.inflight) if (k.startsWith(`${sid} `)) f.ac.abort();
  }

  // -------- HTTP
  async fetch(req: Request, who: Who | null): Promise<Response> {
    const url = new URL(req.url), base = url.origin;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const p = url.pathname;
    if (p.startsWith("/.well-known/oauth-protected-resource")) return json(this.resourceMeta(base));
    if (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration")) return json(this.asMeta(base));
    if (p === "/oauth/register" && req.method === "POST") return this.register(req);
    if (p === "/oauth/authorize") return this.authorize(req, url);
    if (p === "/oauth/token" && req.method === "POST") return this.token(req);
    if (p !== "/mcp") return json({ error: "not found" }, 404);
    if (!who) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }, 401,
      { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="noop"` });
    if (!["GET", "POST", "DELETE"].includes(req.method)) return json({ error: "method not allowed" }, 405, { allow: "GET, POST, DELETE, OPTIONS" });

    const pv = req.headers.get("mcp-protocol-version");
    if (pv && !PROTOCOL_VERSIONS.includes(pv)) return rpcErr(400, -32600, `unsupported MCP-Protocol-Version: ${pv} (supported: ${PROTOCOL_VERSIONS.join(", ")})`);
    const sidHeader = req.headers.get("mcp-session-id") ?? "";

    let msg: any;
    if (req.method === "POST") {
      try { msg = await req.json(); } catch { return rpcErr(400, -32700, "parse error"); }
      if (!Array.isArray(msg) && msg?.method === "initialize") return this.initialize(msg, who, base);
    }
    // Everything but initialize needs a live session (spec: 400 without the header, 404 once it's gone → re-initialize).
    if (!sidHeader) return rpcErr(400, -32600, "Mcp-Session-Id header required");
    const sess = this.session(sidHeader);
    if (!sess) return rpcErr(404, -32001, "session not found; initialize a new one");
    this.h.sql.exec("UPDATE mcp_sessions SET last = ? WHERE id = ?", Date.now(), sess.id);

    if (req.method === "GET") return this.openStream(req, sess);
    if (req.method === "DELETE") { this.endSession(sess.id); return new Response(null, { status: 204, headers: CORS }); }

    if (Array.isArray(msg)) { // JSON-RPC batches only exist in 2025-03-26
      if (sess.version !== "2025-03-26" || !msg.length || msg.some((m) => m?.method === "initialize")) return rpcErr(400, -32600, "batching is not supported in this protocol version");
      const out = (await Promise.all(msg.map((m) => this.handle(m, sess.id, who, base)))).filter((r) => r);
      return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    const isRequest = msg && typeof msg.method === "string" && "id" in msg;
    if (!isRequest) { // notification or response → 202 Accepted
      const r = await this.handle(msg, sess.id, who, base);
      return r ? json(r, 400) : new Response(null, { status: 202, headers: CORS });
    }
    const wantsSse = (req.headers.get("accept") ?? "").includes("text/event-stream");
    const token = msg.params?._meta?.progressToken;
    const streams = msg.method === "tools/call" && (token !== undefined || msg.params?.name === "wait_for_events");
    if (!wantsSse || !streams) {
      const r = await this.handle(msg, sess.id, who, base);
      return r ? json(r) : new Response(null, { status: 202, headers: CORS });
    }
    // SSE response: progress notifications for this request first, then its response; resumable via GET + Last-Event-ID.
    const stream = `p${rand(6)}`;
    const { live, res } = this.connect(sess.id, stream, sess.version, req);
    let last = -1;
    const ctx: Ctx = {
      progress: token === undefined ? undefined : (progress, total, message) => {
        if (progress <= last) return; // progress MUST increase
        last = progress;
        this.send(sess.id, stream, { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) } });
      },
    };
    this.handle(msg, sess.id, who, base, ctx, stream).then((r) => {
      if (r) this.send(sess.id, stream, r);
      (this.conns.get(`${sess.id} ${stream}`) ?? live).close();
    });
    return res;
  }

  async initialize(msg: any, who: Who, base: string): Promise<Response> {
    const id = rand(16), now = Date.now();
    const v = PROTOCOL_VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : PROTOCOL_VERSIONS[0];
    for (const r of this.h.sql.exec("SELECT id FROM mcp_sessions WHERE last < ?", now - SESSION_IDLE_MS).toArray()) this.endSession(r.id as string);
    this.h.sql.exec("INSERT INTO mcp_sessions (id, level, subs, created, last, version, g_seen) VALUES (?, 'info', '[]', ?, ?, ?, 0)", id, now, now, v);
    if (this.listSig === undefined) this.listChanged();
    return json(await this.rpc(msg, id, who, base), 200, { "mcp-session-id": id });
  }

  /** rpc() with cancellation: notifications/cancelled for this request aborts it and suppresses the response. */
  async handle(m: any, sid: string, who: Who, base: string, ctx: Ctx = {}, stream?: string): Promise<any | null> {
    if (!m || typeof m !== "object" || !("id" in m) || typeof m.method !== "string") return this.rpc(m, sid, who, base, ctx);
    const key = `${sid} ${JSON.stringify(m.id)}`, ac = new AbortController();
    this.inflight.set(key, { ac, stream });
    try {
      const r = await this.rpc(m, sid, who, base, { ...ctx, signal: ac.signal });
      return ac.signal.aborted ? null : r;
    } finally { if (this.inflight.get(key)?.ac === ac) this.inflight.delete(key); }
  }

  openStream(req: Request, sess: { id: string; version: string }): Response {
    if (!(req.headers.get("accept") ?? "").includes("text/event-stream")) return json({ error: "Accept: text/event-stream required" }, 406);
    const lastId = req.headers.get("last-event-id");
    if (lastId) {
      const m = lastId.match(/^(g|p[0-9a-f]+)\.(\d+)$/);
      if (!m) return rpcErr(400, -32600, "bad Last-Event-ID");
      const [, stream, seq] = m;
      const { live, res } = this.connect(sess.id, stream, sess.version, req, Number(seq));
      if (stream === "g") this.h.sql.exec("UPDATE mcp_sessions SET g_seen = ? WHERE id = ?", Date.now(), sess.id);
      // A finished POST stream: replay, then close (its response was the last message).
      else if (![...this.inflight.values()].some((f) => f.stream === stream)) queueMicrotask(() => live.close());
      return res;
    }
    this.h.sql.exec("UPDATE mcp_sessions SET g_seen = ? WHERE id = ?", Date.now(), sess.id);
    return this.connect(sess.id, "g", sess.version, req).res;
  }

  // -------- JSON-RPC
  resourceList() {
    return [
      { uri: "noop://status", name: "status", title: "Fleet status", mimeType: "application/json" },
      { uri: "noop://feed", name: "feed", title: "Latest feed events", mimeType: "application/json" },
      { uri: "noop://decisions", name: "decisions", title: "Open decisions", mimeType: "application/json" },
      ...listDecisions(this.h.sql, "open", 100).filter((d) => d.id).map((d) => ({ uri: `noop://decisions/${d.id}`, name: d.id!, title: `${d.id} ${d.question ?? ""}`, mimeType: "application/json" })),
      ...listTasks(this.h.sql, "open", "", 50).map((t) => ({ uri: `noop://tasks/${t.id}`, name: t.id, title: `${t.id} ${t.title}`, mimeType: "application/json" })),
    ];
  }

  async rpc(m: any, sid: string, who: Who, base: string, ctx: Ctx = {}): Promise<any | null> {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return m && "id" in m && !("result" in m || "error" in m) ? err(m.id ?? null, -32600, "invalid request") : null;
    const isNote = !("id" in m);
    const ok = (result: unknown) => (isNote ? null : { jsonrpc: "2.0", id: m.id, result });
    const p = m.params ?? {};
    try {
      switch (m.method) {
        case "initialize": {
          const v = PROTOCOL_VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSIONS[0];
          return ok({ protocolVersion: v, serverInfo: SERVER_INFO,
            // Same feature set in every supported version. Tools are fixed (listChanged false); the resource list follows open tasks/decisions.
            capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: true }, logging: {} },
            instructions: "noop is the owner's AI agent fleet. Read state with get_status / list_tasks / list_decisions / get_feed. "
              + "Talk to the fleet with send_message or create_task (the lead agent plans the work), answer decision cards with answer_decision. "
              + "Live events arrive as notifications/message on the GET stream (resumable with Last-Event-ID); without notifications, poll with wait_for_events." });
        }
        case "ping": return ok({});
        case "logging/setLevel":
          if (!LEVELS.includes(p.level)) return err(m.id, -32602, "unknown level");
          this.h.sql.exec("UPDATE mcp_sessions SET level = ? WHERE id = ?", p.level, sid);
          return ok({});
        case "tools/list": return ok({ tools: TOOLS.map(({ write, ...t }) => t) });
        case "tools/call": {
          const r = await this.call(String(p.name ?? ""), p.arguments ?? {}, base, ctx);
          return r === null ? null : ok(r);
        }
        case "resources/list": return ok({ resources: this.resourceList() });
        case "resources/templates/list": return ok({ resourceTemplates: [
          { uriTemplate: "noop://tasks/{id}", name: "task", title: "A task", mimeType: "application/json" },
          { uriTemplate: "noop://decisions/{id}", name: "decision", title: "A decision card", mimeType: "application/json" }] });
        case "resources/read": {
          const data = this.resource(String(p.uri ?? ""));
          if (data === undefined) return err(m.id, -32002, "resource not found");
          return ok({ contents: [{ uri: p.uri, mimeType: "application/json", text: JSON.stringify(data, null, 1) }] });
        }
        case "resources/subscribe": case "resources/unsubscribe": {
          const uri = String(p.uri ?? "");
          const row = this.h.sql.exec("SELECT subs FROM mcp_sessions WHERE id = ?", sid).toArray()[0];
          if (!row) return err(m.id, -32600, "unknown session");
          const subs = new Set<string>(JSON.parse(row.subs as string || "[]"));
          if (m.method === "resources/subscribe") subs.add(uri); else subs.delete(uri);
          this.h.sql.exec("UPDATE mcp_sessions SET subs = ? WHERE id = ?", JSON.stringify([...subs].slice(-200)), sid);
          return ok({});
        }
        case "notifications/cancelled": {
          if (p.requestId !== undefined) this.inflight.get(`${sid} ${JSON.stringify(p.requestId)}`)?.ac.abort(p.reason);
          return null;
        }
        case "notifications/initialized": case "notifications/roots/list_changed": case "notifications/progress": return null;
        default: return isNote ? null : err(m.id, -32601, `method not found: ${m.method}`);
      }
    } catch (e) { return isNote ? null : err(m.id, -32603, String((e as Error)?.message ?? e)); }
  }

  resource(uri: string): unknown {
    if (uri === "noop://status") return this.statusView();
    if (uri === "noop://feed") return this.feed(undefined, 50);
    if (uri === "noop://decisions") return listDecisions(this.h.sql);
    const d = uri.match(/^noop:\/\/decisions\/(.+)$/)?.[1];
    if (d) return DECISION_ID.test(d) ? listDecisions(this.h.sql, "open", 100).find((x) => x.id === d) : undefined;
    const t = uri.match(/^noop:\/\/tasks\/(.+)$/)?.[1];
    if (t && TASK_ID.test(t)) return getTask(this.h.sql, t) ?? undefined;
    return undefined;
  }

  statusView() {
    const s = this.h.status() ?? {};
    return { hub: s.hub, tasks: s.tasks, decisions: s.decisions,
      hosts: (s.hosts ?? []).map((h: any) => ({ host: h.host, online: h.online, state: h.state, caps: h.caps, running: h.running ?? h.tasks })),
      active: (s.active ?? []).map((t: any) => ({ id: t.id, title: t.title, agent: t.agent, host: t.host, started: t.started, activity: t.activity })) };
  }

  feed(cursor: number | undefined, limit: number) {
    const n = Math.max(1, Math.min(limit || 50, 300));
    const after = cursor === undefined ? this.lastSeq() - n : cursor;
    const rows = this.h.events(Math.max(0, after), n);
    return { cursor: rows.length ? rows[rows.length - 1].seq : Math.max(cursor ?? 0, this.lastSeq()), events: rows.map((r) => r.ev) };
  }
  lastSeq() { return Number(this.h.sql.exec("SELECT COALESCE(MAX(seq), 0) AS n FROM events").toArray()[0]?.n ?? 0); }

  async call(name: string, a: any, base: string, ctx: Ctx = {}): Promise<any | null> {
    const out = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 1) }], structuredContent: Array.isArray(data) ? { items: data } : data });
    const bad = (message: string) => ({ content: [{ type: "text", text: message }], isError: true });
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    switch (name) {
      case "get_status": return out(this.statusView());
      case "list_tasks": return out({ tasks: listTasks(this.h.sql, s(a.state) || "open", s(a.query), Number(a.limit) || 50) });
      case "get_task": {
        const id = s(a.id);
        const t = TASK_ID.test(id) ? getTask(this.h.sql, id) : null;
        if (!t) return bad(`task ${id} not found`);
        const events = this.h.events(Math.max(0, this.lastSeq() - 2000), 2000).map((r) => r.ev)
          .filter((e) => e.ref === id || String(e.text ?? "").includes(id)).slice(-20);
        return out({ ...t, events });
      }
      case "list_decisions": return out({ decisions: listDecisions(this.h.sql, a.which === "closed" ? "closed" : "open", Number(a.limit) || 30) });
      case "get_feed": return out(this.feed(a.cursor === undefined || a.cursor === null ? undefined : Number(a.cursor), Number(a.limit) || 50));
      case "wait_for_events": {
        const cursor = Number(a.cursor) || 0, ms = Math.max(1, Math.min(Number(a.timeout_seconds) || 30, 50)) * 1000, total = ms / 1000;
        if (this.lastSeq() <= cursor) {
          const t0 = Date.now(), { signal, progress } = ctx;
          progress?.(0, total, "waiting for fleet events");
          await new Promise<void>((res) => {
            const done = () => { clearTimeout(t); if (tick) clearInterval(tick); this.waiters.delete(done); signal?.removeEventListener("abort", done); res(); };
            const t = setTimeout(done, ms);
            const tick = progress && setInterval(() => progress(Math.min(total, (Date.now() - t0) / 1000), total, "waiting for fleet events"), this.progressEveryMs);
            signal?.addEventListener("abort", done);
            this.waiters.add(done);
            if (signal?.aborted) done();
          });
          if (signal?.aborted) return null; // cancelled: no response
        }
        return out(this.feed(cursor, 100));
      }
      case "send_message": {
        const text = s(a.text);
        if (!text) return bad("text required");
        const ev = this.h.say(text.slice(0, 20_000), s(a.reply_to) || undefined);
        return out({ ok: true, id: ev.id, ts: ev.ts });
      }
      case "create_task": {
        const title = s(a.title);
        if (!title) return bad("title required");
        const text = [`新任务：${title}`, s(a.repo) && `仓库：${s(a.repo)}`, s(a.details)].filter(Boolean).join("\n\n");
        const ev = this.h.say(text.slice(0, 20_000));
        return out({ ok: true, id: ev.id, note: "Posted to the fleet; the lead agent will plan it and report in the feed (watch with wait_for_events)." });
      }
      case "answer_decision": {
        const id = s(a.id), answer = s(a.answer);
        if (!DECISION_ID.test(id) || !answer) return bad("id (D-…) and answer required");
        if (!readFile(this.h.sql, `decisions/open/${id}.md`)) return bad(`decision ${id} is not open`);
        const ev = this.h.say(`${id} ${answer}`.slice(0, 5000), id);
        return out({ ok: true, id: ev.id });
      }
      case "search": {
        const q = s(a.query);
        const tasks = listTasks(this.h.sql, "all", q, 20).map((t) => ({ id: t.id, title: `${t.id} ${t.title} (${t.state})`, url: `${base}/?ref=${t.id}` }));
        const ql = q.toLowerCase();
        const decisions = [...listDecisions(this.h.sql, "open", 100), ...listDecisions(this.h.sql, "closed", 100)]
          .filter((d) => d.id && (!ql || `${d.id} ${d.question} ${d.context ?? ""}`.toLowerCase().includes(ql)))
          .slice(0, 10).map((d) => ({ id: d.id, title: `${d.id} ${d.question}`, url: `${base}/?ref=${d.id}` }));
        return out({ results: [...decisions, ...tasks] });
      }
      case "fetch": {
        const id = s(a.id);
        if (TASK_ID.test(id)) {
          const t = getTask(this.h.sql, id);
          if (t) return out({ id, title: `${id} ${t.title}`, text: t.body, url: `${base}/?ref=${id}`, metadata: { ...t.meta, state: t.state } });
        }
        if (DECISION_ID.test(id)) for (const w of ["open", "closed"] as const) {
          const f = readFile(this.h.sql, `decisions/${w}/${id}.md`);
          if (f) { const { meta, body } = parseDoc(f.text); return out({ id, title: `${id} ${meta.question ?? ""}`, text: body, url: `${base}/?ref=${id}`, metadata: { ...meta, state: w } }); }
        }
        return bad(`${id} not found`);
      }
    }
    return bad(`unknown tool: ${name}`);
  }

  // -------- OAuth 2.1 (authorization server + protected resource, same origin)
  resourceMeta(base: string) {
    return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["noop"], bearer_methods_supported: ["header"], resource_name: "noop" };
  }
  asMeta(base: string) {
    return { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["noop"] };
  }

  async register(req: Request) {
    const b = (await req.json().catch(() => null)) as any;
    const uris = Array.isArray(b?.redirect_uris) ? b.redirect_uris.filter((u: unknown) => typeof u === "string" && okRedirect(u)) : [];
    if (!uris.length || uris.length !== b.redirect_uris.length) return json({ error: "invalid_redirect_uri", error_description: "https (or http://localhost) redirect_uris required" }, 400);
    const n = Number(this.h.sql.exec("SELECT COUNT(*) AS n FROM oauth_clients WHERE created > ?", Date.now() - 3600_000).toArray()[0]?.n ?? 0);
    if (n >= 30) return json({ error: "temporarily_unavailable" }, 429);
    const client = { client_id: `mcp-${rand(12)}`, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: uris,
      client_name: String(b.client_name ?? "").slice(0, 100) || new URL(uris[0]).host, token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
    this.h.sql.exec("INSERT INTO oauth_clients (id, json, created) VALUES (?, ?, ?)", client.client_id, JSON.stringify(client), Date.now());
    return json(client, 201);
  }
  client(id: string) { const r = this.h.sql.exec("SELECT json FROM oauth_clients WHERE id = ?", id).toArray()[0]; return r ? JSON.parse(r.json as string) : null; }

  async authorize(req: Request, url: URL): Promise<Response> {
    const f: Record<string, string> = Object.fromEntries(url.searchParams);
    if (req.method === "POST") Object.assign(f, Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, String(v)])));
    const client = this.client(f.client_id ?? "");
    if (!client) return page("无法授权", `<p>未知的应用（client_id）。请在客户端里重新添加 noop。</p>`, 400);
    if (!client.redirect_uris.includes(f.redirect_uri)) return page("无法授权", `<p>回调地址和注册的不一致。</p>`, 400);
    const back = (q: Record<string, string>) => {
      const u = new URL(f.redirect_uri);
      for (const [k, v] of Object.entries({ ...q, ...(f.state ? { state: f.state } : {}) })) u.searchParams.set(k, v);
      return new Response(null, { status: 302, headers: { location: u.toString() } });
    };
    if (f.response_type !== "code") return back({ error: "unsupported_response_type" });
    if (!f.code_challenge || f.code_challenge_method !== "S256") return back({ error: "invalid_request", error_description: "PKCE S256 required" });
    if (req.method === "POST" && f.step === "deny") return back({ error: "access_denied" });

    const keep = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]
      .filter((k) => f[k]).map((k) => `<input type="hidden" name="${k}" value="${esc(f[k])}">`).join("");
    const who = `<p><b>${esc(client.client_name)}</b> 想访问你的 noop：查看任务、决策和动态，以你的名义给团队发消息、回答决策。</p>
      <p class="muted">授权后会跳回 <code>${esc(new URL(f.redirect_uri).host)}</code>。不是你本人发起的请直接关闭页面。</p>`;
    const emailForm = (msg = "") => page("授权 noop", `${who}${msg}<form method="post">${keep}<input type="hidden" name="step" value="send">
      <label>邮箱<input name="email" type="email" required autofocus value="${esc(f.email)}"></label>
      <div class="row"><button>发送验证码</button><button name="step" value="deny" class="ghost" formnovalidate>拒绝</button></div></form>`);
    const codeForm = (msg = "") => page("授权 noop", `${who}${msg}<form method="post">${keep}<input type="hidden" name="step" value="verify">
      <input type="hidden" name="email" value="${esc(f.email)}">
      <label>验证码（已发到 ${esc(f.email)}${f.delivery === "cli" ? "；邮件未配置，请在你的电脑上运行 <code>noop login</code> 查看" : ""}）
      <input name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" required autofocus autocomplete="one-time-code"></label>
      <input type="hidden" name="delivery" value="${esc(f.delivery)}">
      <div class="row"><button>授权</button><button name="step" value="deny" class="ghost" formnovalidate>拒绝</button></div></form>`);
    const note = (s: string) => `<p class="err">${esc(s)}</p>`;

    if (req.method !== "POST") return emailForm();
    if (f.step === "send") {
      const r = await this.h.startCode(String(f.email ?? ""));
      if (r.status !== 200) return emailForm(note(r.body?.error ?? "发送失败"));
      f.delivery = r.body?.delivery ?? "";
      return codeForm();
    }
    if (f.step === "verify") {
      const r = await this.h.checkCode(String(f.email ?? ""), String(f.code ?? ""));
      if (!r.email) return codeForm(note(r.error ?? "验证码不对"));
      const code = rand(32);
      this.h.sql.exec("DELETE FROM oauth_codes WHERE expires < ?", Date.now());
      this.h.sql.exec("INSERT INTO oauth_codes (hash, client_id, redirect_uri, challenge, email, expires) VALUES (?, ?, ?, ?, ?, ?)",
        await sha256(code), client.client_id, f.redirect_uri, f.code_challenge, r.email, Date.now() + OAUTH_CODE_TTL);
      return back({ code });
    }
    return emailForm();
  }

  async token(req: Request): Promise<Response> {
    const ct = req.headers.get("content-type") ?? "";
    const b: Record<string, string> = ct.includes("json") ? ((await req.json().catch(() => ({}))) as any)
      : Object.fromEntries([...new URLSearchParams(await req.text())]);
    const fail = (error: string, d?: string) => json({ error, ...(d ? { error_description: d } : {}) }, 400, { "cache-control": "no-store" });
    const client = this.client(b.client_id ?? "");
    if (!client) return json({ error: "invalid_client" }, 401);
    let email: string;
    if (b.grant_type === "authorization_code") {
      const h = await sha256(String(b.code ?? ""));
      const r = this.h.sql.exec("SELECT * FROM oauth_codes WHERE hash = ?", h).toArray()[0];
      this.h.sql.exec("DELETE FROM oauth_codes WHERE hash = ?", h); // single use
      if (!r || (r.expires as number) < Date.now() || r.client_id !== client.client_id) return fail("invalid_grant");
      if (b.redirect_uri && b.redirect_uri !== r.redirect_uri) return fail("invalid_grant", "redirect_uri mismatch");
      if (!b.code_verifier || (await pkceChallenge(b.code_verifier)) !== r.challenge) return fail("invalid_grant", "PKCE verification failed");
      email = r.email as string;
    } else if (b.grant_type === "refresh_token") {
      const h = await sha256(String(b.refresh_token ?? ""));
      const r = this.h.sql.exec("SELECT * FROM oauth_refresh WHERE hash = ?", h).toArray()[0];
      if (!r || r.client_id !== client.client_id) return fail("invalid_grant");
      this.h.sql.exec("DELETE FROM oauth_refresh WHERE hash = ?", h); // rotate
      this.h.sql.exec("DELETE FROM sessions WHERE id = ?", r.session); // the old access token goes with it
      email = r.email as string;
    } else return fail("unsupported_grant_type");
    const access = await this.h.newSession(email, `mcp:${client.client_name}`.slice(0, 300));
    const refresh = rand(32);
    this.h.sql.exec("INSERT INTO oauth_refresh (hash, client_id, email, session, created) VALUES (?, ?, ?, ?, ?)",
      await sha256(refresh), client.client_id, email, await sha256(access), Date.now());
    return json({ access_token: access, token_type: "Bearer", refresh_token: refresh, scope: "noop" }, 200, { "cache-control": "no-store" });
  }
}

const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
export function okRedirect(u: string) {
  try { const x = new URL(u); return !x.hash && (x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname))); }
  catch { return false; }
}

function page(title: string, body: string, status = 200) {
  return new Response(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--mut:#666;--line:#e4e4e7;--acc:#111}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ededed;--mut:#9a9a9a;--line:#2a2a2e;--acc:#ededed}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,system-ui,sans-serif}
main{max-width:400px;margin:12vh auto;padding:0 20px}h1{font-size:20px;margin:0 0 16px}
label{display:block;margin:16px 0 6px;color:var(--mut);font-size:13px}
input:not([type=hidden]){display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:9px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg);font:inherit}
.row{display:flex;gap:8px;margin-top:16px}button{padding:8px 14px;border-radius:6px;border:1px solid var(--acc);background:var(--acc);color:var(--bg);font:inherit;cursor:pointer}
button.ghost{background:transparent;color:var(--fg);border-color:var(--line)}.muted{color:var(--mut);font-size:13px}.err{color:#e5484d}code{font-size:13px}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" } });
}
