#!/usr/bin/env bun
// The demo hub (app/demo.ts) over real HTTP and WebSocket, for local development of the app's network path.
//   bun scripts/demo-server.ts [--port 8790] [--lang zh]
// Then sign in to http://localhost:8790 with any email, code DEMO2026 and 2FA 000000. State lives in memory only.
import { parseArgs } from "util";

// app/i18n.ts reads its language from an NSH signal; outside the runtime a plain cell stands in for it.
Bun.plugin({
  name: "nsh-signal",
  setup(build) {
    build.module("nsh", () => ({
      loader: "object",
      exports: {
        signal<T>(v: T) {
          const read = () => v;
          return Object.assign(read, { set: (x: T) => { v = x; }, update: (f: (x: T) => T) => { v = f(v); } });
        },
      },
    }));
  },
});

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { port: { type: "string", default: "8790" }, lang: { type: "string", default: "en" } } });
const { lang } = await import("../app/i18n.ts");
if (values.lang === "zh") lang.set("zh");
const { createDemoHub, DEMO_CODE, DEMO_TOTP } = await import("../app/demo.ts");
const hub = createDemoHub();

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS" };
type Conn = { close: () => void; send: (d: string) => void };

const server = Bun.serve<{ conn?: Conn }>({
  port: Number(values.port),
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (url.pathname === "/api/stream") return srv.upgrade(req, { data: {} }) ? undefined : new Response("websocket expected", { status: 426 });
    let body: unknown;
    if (req.method !== "GET" && (req.headers.get("content-type") ?? "").includes("json")) body = await req.json().catch(() => undefined);
    const r = await hub.handle(req.method, url.pathname + url.search, body);
    if (r.text !== undefined) return new Response(r.text, { status: r.status, headers: { ...cors, "Content-Type": "text/markdown; charset=utf-8" } });
    return Response.json(r.data, { status: r.status, headers: cors });
  },
  websocket: {
    open(ws) { ws.data.conn = hub.connect((frame) => ws.send(frame)); },
    message(ws, msg) { ws.data.conn?.send(String(msg)); },
    close(ws) { ws.data.conn?.close(); },
  },
});

console.log(`Noop demo server on http://localhost:${server.port} — any email, code ${DEMO_CODE}, 2FA ${DEMO_TOTP}`);
