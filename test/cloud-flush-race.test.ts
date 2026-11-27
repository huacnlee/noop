// Repro: one local event must reach the Worker exactly once, even when two flushes overlap.
import { expect, test } from "bun:test";
import { startCloudBridge } from "../src/cloud";
import { appendEvent } from "../src/server";

// Wait for a condition instead of a fixed sleep: self-update runs this suite on a loaded host where the event loop
// stalls for seconds, and a fixed 300 ms window then closed before the second upload arrived (2.1 s run, ["one"]).
// On 2026-11-27 a host stall outlasted the whole 15 s window before even the first upload arrived (uploads: []) and
// rolled a valid release back; the suite's default guard is 60 s (test/preload.ts), so wait that long here too.
const until = async (ok: () => boolean, ms = 60_000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await Bun.sleep(10);
};

test("one local event is uploaded exactly once while another flush is in flight", async () => {
  const seen: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/events" && req.method === "POST") {
        seen.push(await req.json());
        await gate; // hold the first upload in flight so a second flush can start
        return Response.json({ ok: true });
      }
      if (u.pathname === "/api/host/inbox") return Response.json({ items: [] });
      return Response.json({ ok: true, watchers: 0 });
    },
  });
  const cfg: any = { cloud: { url: `http://127.0.0.1:${server.port}`, poll_seconds: 600 }, server: { token: "t" } };
  startCloudBridge(cfg);
  appendEvent({ from: "test", kind: "notice", text: "one" });
  // `gate` holds this upload, so wait until the server has it: "two" then starts a second flush that really overlaps
  await until(() => seen.some((e) => e.text === "one"));
  expect(seen.some((e) => e.text === "one")).toBe(true);
  appendEvent({ from: "test", kind: "notice", text: "two" }); // mirror hook fires a second flush
  release();
  await until(() => seen.some((e) => e.text === "two"));
  await Bun.sleep(100); // room for a duplicate "one" to show up after "two"
  server.stop(true);
  const ids = seen.map((e) => e.text);
  console.log("uploads:", JSON.stringify(ids));
  expect(ids.filter((t) => t === "one")).toHaveLength(1);
  expect(ids).toContain("two");
}, 180_000); // two 60 s host-stall waits (see until) plus the duplicate window

test("a refused upload waits for the poll instead of retrying in a tight loop", async () => {
  let posts = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/events" && req.method === "POST") { posts++; return Response.json({ error: "nope" }, { status: 500 }); }
      if (u.pathname === "/api/host/inbox") return Response.json({ items: [] });
      return Response.json({ ok: true, watchers: 0 });
    },
  });
  const cfg: any = { cloud: { url: `http://127.0.0.1:${server.port}`, poll_seconds: 600 }, server: { token: "t" } };
  startCloudBridge(cfg);
  appendEvent({ from: "test", kind: "notice", text: "refused" });
  await until(() => posts > 0);
  await Bun.sleep(500); // a tight retry loop would post many more times in this window
  server.stop(true);
  expect(posts).toBe(1); // one attempt; the 3s loop owns the retry
}, 120_000); // one 60 s host-stall wait (see until) plus the 500 ms quiet window

