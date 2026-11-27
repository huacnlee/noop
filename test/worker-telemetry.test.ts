import { expect, test } from "bun:test";
import { DailyReport, platformOf, telemetryOn, usersReport, workerReport, type Seen } from "../cloud/src/telemetry";

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

function harness(statuses: number[], enabled = true, seen: Seen = { machines: 1, sessions: [] }) {
  const posts: any[] = [];
  let last = "";
  const r = new DailyReport({
    enabled: () => enabled, build: () => "2026-11-26", lastDay: () => last, markDay: (d) => { last = d; },
    installId: () => ID, seen: () => seen, owner: () => "owner@example.com",
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

const APP = "Noop/1.0.8 (iPhone; iOS 27.1; Mobile)";
const WEB = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15";

test("in use: one noop-users event per signed-in Email, MCP connectors not counted", () => {
  const b = usersReport("2026-11-26", {
    machines: 2,
    sessions: [
      { ua: APP, scope: "owner", email: "a@example.com" },
      { ua: WEB, scope: "owner", email: "A@Example.com " },
      { ua: WEB, scope: "owner", email: "b@example.com" },
      { ua: "Claude-User", scope: "mcp", email: "c@example.com" },
    ],
  }, "", 1_795_000_000_000)!;
  expect(b.site).toBe("noop-users");
  expect(b.events).toEqual([
    { name: "active", url: "/worker", ts: 1_795_000_000, user_id: "a@example.com", app_version: "2026-11-26", ua: "Noop/2026-11-26 (Cloudflare Workers)", props: { machines: 2, devices: 2 } },
    { name: "active", url: "/worker", ts: 1_795_000_000, user_id: "b@example.com", app_version: "2026-11-26", ua: "Noop/2026-11-26 (Cloudflare Workers)", props: { machines: 2, devices: 1 } },
  ]);
});

test("a session without an email is the owner's", () => {
  const b = usersReport("x", { machines: 1, sessions: [{ ua: APP, scope: "owner", email: "" }] }, "Owner@Example.com");
  expect(b!.events.map((e) => e.user_id)).toEqual(["owner@example.com"]);
  expect(usersReport("x", { machines: 1, sessions: [{ ua: APP, scope: "owner", email: "" }] }, "")).toBeNull();
});

test("not in use: no machine online, or no app sign-in in the last day, sends nothing to noop-users", () => {
  expect(usersReport("x", { machines: 0, sessions: [{ ua: APP, scope: "owner", email: "a@example.com" }] })).toBeNull();
  expect(usersReport("x", { machines: 3, sessions: [] })).toBeNull();
  expect(usersReport("x", { machines: 3, sessions: [{ ua: "mcp:claude", scope: null, email: "a@example.com" }] })).toBeNull();
});

test("the daily report sends noop-users after the noop report, once", async () => {
  const h = harness([503], true, { machines: 1, sessions: [{ ua: APP, scope: "owner", email: "a@example.com" }] });
  const t0 = Date.parse("2026-11-26T08:00:00Z");
  await h.r.tick(t0);
  expect(h.posts.map((b) => b.site)).toEqual(["noop"]); // backing off: noop-users waits for the day to settle
  await h.r.tick(t0 + 61_000);
  expect(h.posts.map((b) => b.site)).toEqual(["noop", "noop", "noop-users"]);
  expect(h.posts[2].events[0].user_id).toBe("a@example.com");
  expect(h.posts[1].events[0].user_id).toBe(ID); // the noop report never carries an email
  expect(JSON.stringify(h.posts[1])).not.toContain("@");
  await h.r.tick(t0 + 3600_000);
  expect(h.posts).toHaveLength(3);
});

test("no machines or no sign-in: only the noop report", async () => {
  for (const seen of [{ machines: 0, sessions: [{ ua: APP, scope: "owner", email: "a@example.com" }] }, { machines: 2, sessions: [] }]) {
    const h = harness([], true, seen);
    await h.r.tick();
    expect(h.posts.map((b) => b.site)).toEqual(["noop"]);
  }
});

test("telemetry off also stops noop-users", () => {
  const h = harness([], false, { machines: 1, sessions: [{ ua: APP, scope: "owner", email: "a@example.com" }] });
  expect(h.r.tick()).toBeUndefined();
  expect(h.posts).toHaveLength(0);
});
