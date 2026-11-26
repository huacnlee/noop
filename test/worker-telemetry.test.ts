import { expect, test } from "bun:test";
import { DailyReport, platformOf, telemetryOn, workerReport } from "../cloud/src/telemetry";

const ID = "0b5f1c9e-3f0a-4a57-9d55-6c1f3a2b7e10";

test("the Worker's report is one /worker event with counts only", () => {
  const b = workerReport("2026-11-26", ID, {
    machines: 3,
    sessions: [
      { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", scope: "owner" },
      { ua: "Noop/1.0.8 (iPhone; iOS 27.1; Mobile)", scope: "owner" },
      { ua: "nsh (Android 16)", scope: null },
      { ua: "mcp:claude", scope: null },
      { ua: "Claude-User", scope: "mcp" },
    ],
  }, 1_795_000_000_000);
  expect(b.site).toBe("noop");
  expect(b.events).toHaveLength(1);
  const [e] = b.events;
  expect(e).toMatchObject({ name: "heartbeat", url: "/worker", ts: 1_795_000_000, user_id: ID, app_version: "2026-11-26", ua: "Noop/2026-11-26 (Cloudflare Workers)" });
  expect(e!.props).toEqual({ machines: 3, mcp: 2, web: 1, ios: 1, android: 1, macos: 0, windows: 0, linux: 0, other: 0 });
  // NsMetry: at most 10 flat props, and no bot / monitor / preview / scanner in the UA
  expect(Object.keys(e!.props).length).toBeLessThanOrEqual(10);
  expect(e!.ua).not.toMatch(/bot|monitor|preview|scanner/i);
});

test("platforms come from the login's User-Agent", () => {
  expect(platformOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)")).toBe("web");
  expect(platformOf("Noop/1.0 (macOS 15.1)")).toBe("macos");
  expect(platformOf("Noop/1.0 (Windows NT 10.0)")).toBe("windows");
  expect(platformOf("Noop/1.0 (Linux)")).toBe("linux");
  expect(platformOf("")).toBe("other");
});

test("HUB_TELEMETRY=off turns the report off; unset is on", () => {
  expect(telemetryOn(undefined)).toBe(true);
  expect(telemetryOn("on")).toBe(true);
  expect(telemetryOn("off")).toBe(false);
  expect(telemetryOn("0")).toBe(false);
});

function harness(statuses: number[], enabled = true) {
  const posts: unknown[] = [];
  let last = "";
  const r = new DailyReport({
    enabled: () => enabled, build: () => "2026-11-26", lastDay: () => last, markDay: (d) => { last = d; },
    installId: () => ID, seen: () => ({ machines: 1, sessions: [] }),
    post: async (b) => { posts.push(b); return statuses.shift() ?? 204; },
  });
  return { r, posts, last: () => last };
}

test("one report a day, however many requests", async () => {
  const h = harness([204]);
  const t0 = Date.parse("2026-11-26T08:00:00Z");
  await h.r.tick(t0);
  expect(h.r.tick(t0 + 1000)).toBeUndefined();
  expect(h.r.tick(t0 + 3600_000)).toBeUndefined();
  expect(h.posts).toHaveLength(1);
  expect(h.last()).toBe("2026-11-26");
  await h.r.tick(Date.parse("2026-11-27T00:01:00Z"));
  expect(h.posts).toHaveLength(2);
});

test("a day already reported before a restart is not sent again", () => {
  const h = harness([]);
  h.r["io"].markDay("2026-11-26");
  expect(h.r.tick(Date.parse("2026-11-26T09:00:00Z"))).toBeUndefined();
  expect(h.posts).toHaveLength(0);
});

test("429 / 5xx / network errors back off; 404 ends the day", async () => {
  const h = harness([503, 429, 404]);
  const t0 = Date.now();
  await h.r.tick(t0);
  expect(h.r.tick(t0 + 1000)).toBeUndefined(); // backing off for a minute
  await h.r.tick(t0 + 61_000);
  expect(h.posts).toHaveLength(2);
  expect(h.r.tick(t0 + 62_000)).toBeUndefined(); // now two minutes
  await h.r.tick(t0 + 61_000 + 121_000);
  expect(h.posts).toHaveLength(3);
  expect(h.last()).not.toBe("");
});

test("off sends nothing", () => {
  const h = harness([], false);
  expect(h.r.tick()).toBeUndefined();
  expect(h.posts).toHaveLength(0);
});
