/** Analytics headless: pages become screen views without ids, sent in one batch when the app goes to the background. */
import { expect, open, test } from "nsh/test";

const URL = "http://hub.test:8787";
const BATCH = "POST https://nsmetry.huacnlee-account.workers.dev/api/events/batch";

interface Batch {
  site: string;
  events: Array<Record<string, unknown>>;
}

test("screens are batched until the app goes to the background, with no hub data", async () => {
  const bodies: Batch[] = [];
  const raw: string[] = [];
  const app = await open("./App.tsx", {
    storage: { "hub.url": URL, "hub.token": "tok" },
    width: 1200, height: 800, platform: "macos",
    network: {
      [`GET ${URL}/api/feed`]: { body: { events: [] } },
      [`GET ${URL}/api/feed?*`]: { body: { events: [] } },
      [`GET ${URL}/api/status`]: { body: { tasks: {}, active: [], decisions: [], recent: [], hosts: [] } },
      [`GET ${URL}/api/settings`]: { status: 500 },
      [BATCH]: (r: { body?: string | null }) => {
        raw.push(r.body ?? "");
        bodies.push(JSON.parse(r.body ?? "{}") as Batch);
        return { status: 204 };
      },
    },
  });
  await app.press("id:user-menu");
  await app.press("id:settings");
  await app.waitFor("id:settings-tab-account");
  // Nothing is sent while the app is in use: one request per batch, not per screen.
  expect(bodies).toHaveLength(0);

  await app.setLifecycle("background");
  await app.waitUntil(() => bodies.length > 0);

  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.site).toBe("noop");
  const events = bodies[0]!.events;
  expect(events.map((e) => `${e.name} ${e.url}`)).toEqual(["screen_view /chat", "screen_view /settings"]);
  expect(events[0]!.app_version).toBe("dev");
  expect(app.storage()["nsmetry.uid"]).toBe(events[0]!.user_id as string);
  // The hub's address and session never leave the device.
  expect(raw.join("")).not.toContain("hub.test");
  expect(raw.join("")).not.toContain("tok\"");
  app.dispose();
});
