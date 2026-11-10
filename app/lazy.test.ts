import { describe, expect, open, test } from "nsh/test";
import { signal } from "nsh";
import { latch, lazyModule } from "./lazy";

describe("lazy modules", () => {
  test("loads once, however many ask, and keeps the module", async () => {
    let imports = 0;
    const m = lazyModule(async () => {
      imports++;
      return { answer: 42 };
    });
    expect(m.loaded()).toBe(null);
    const [a, b] = await Promise.all([m.load(), m.load()]);
    expect(a).toBe(b);
    expect(imports).toBe(1);
    expect(m.loaded()).toBe(a);
    expect(await m.load()).toBe(a);
    expect(imports).toBe(1);
  });

  test("a failed load says why, and the next one tries again", async () => {
    let attempts = 0;
    const m = lazyModule(async () => {
      if (++attempts === 1) throw new Error("offline");
      return { ok: true };
    });
    await expect(m.load()).rejects.toThrow("offline");
    expect(m.failed()).toBe("offline");
    expect(m.loaded()).toBe(null);
    const loaded = await m.load();
    expect(loaded).toEqual({ ok: true });
    expect(m.failed()).toBe("");
    expect(m.loaded()).toBe(loaded);
    expect(attempts).toBe(2);
  });

  test("a module that is a function stays a module (the signal never calls it)", async () => {
    const fn = () => "called";
    const m = lazyModule(async () => fn);
    await m.load();
    expect(m.loaded()).toBe(fn);
  });
});

describe("latch", () => {
  test("stays true once its condition was, so a closed overlay stays mounted", () => {
    const open = signal(false);
    const mounted = latch(open);
    expect(mounted()).toBe(false);
    open.set(true);
    expect(mounted()).toBe(true);
    open.set(false);
    expect(mounted()).toBe(true);
  });
});

// The fixture (lazy.fixture.tsx) fetches each chunk before importing it, as a web page downloads one: a test fails the
// download, then lets it through, and looks at what the owner would see.
describe("lazy interfaces that could not load", () => {
  const chunks = (state: { fail: boolean; delay?: number }, asked: string[]) => ({
    "GET http://chunk.test/*": (req: { url: string }) => {
      asked.push(req.url);
      return state.fail ? { error: "offline" } : { body: "", delay: state.delay };
    },
  });

  test("an overlay says it could not open, and opening it again after closing loads it", async () => {
    const state = { fail: true }, asked: string[] = [];
    const app = await open("./lazy.fixture.tsx", { width: 900, height: 700, platform: "macos", network: chunks(state, asked) });
    await app.press("open-help");
    await app.waitFor("text:Couldn’t open the keyboard shortcuts");
    expect(app.shows("id:lazy-retry")).toBe(true);
    expect(app.shows("Keyboard shortcuts")).toBe(false);
    await app.press("id:lazy-close");
    await app.waitUntil(() => !app.shows("id:lazy-overlay"));

    state.fail = false;
    await app.press("open-help");
    await app.waitFor("Keyboard shortcuts");
    expect(app.shows("id:lazy-overlay")).toBe(false);
    expect(asked.length).toBe(2);
    // loaded: the Dialog stays mounted between openings, so it closes (animated) and opens again with no new download
    await app.press("label:Close");
    await app.waitUntil(() => !app.shows("Keyboard shortcuts"));
    await app.press("open-help");
    await app.waitFor("Keyboard shortcuts");
    expect(asked.length).toBe(2);
  });

  test("Retry on a failed overlay clears the failure while it loads again", async () => {
    const state = { fail: true, delay: 0 }, asked: string[] = [];
    const app = await open("./lazy.fixture.tsx", { width: 900, height: 700, platform: "macos", network: chunks(state, asked) });
    await app.press("open-help");
    await app.waitFor("id:lazy-retry");
    state.fail = false;
    state.delay = 400;
    void app.press("id:lazy-retry");
    await app.waitFor("text:Loading…");
    expect(app.shows("text:Couldn’t open the keyboard shortcuts")).toBe(false);
    expect(app.shows("id:lazy-retry")).toBe(false);
    await app.waitFor("Keyboard shortcuts", { timeout: 3000 });
    expect(app.shows("id:lazy-overlay")).toBe(false);
  });

  test("a failed overlay's card works from the keyboard: Escape closes it, Retry takes Enter", async () => {
    const state = { fail: true }, asked: string[] = [];
    const app = await open("./lazy.fixture.tsx", { width: 900, height: 700, platform: "macos", network: chunks(state, asked) });
    await app.press("open-help");
    await app.waitFor("id:lazy-retry");
    await app.keyboard.press("escape");
    await app.waitUntil(() => !app.shows("id:lazy-overlay"));

    await app.press("open-help");
    await app.waitFor("id:lazy-retry");
    state.fail = false;
    // Tab order: open-help, open-page, relabel, then the card's Retry
    for (let i = 0; i < 4; i++) await app.keyboard.press("tab");
    await app.keyboard.press("enter");
    await app.waitFor("Keyboard shortcuts");
    expect(asked.length).toBe(3);
  });

  test("a page offers Retry and Close, and once loaded its props stay live", async () => {
    const state = { fail: true }, asked: string[] = [];
    const app = await open("./lazy.fixture.tsx", { width: 900, height: 700, platform: "macos", network: chunks(state, asked) });
    await app.press("open-page");
    await app.waitFor("text:Couldn’t load this page");
    // closing a failed page and opening it again tries again
    await app.press("id:lazy-close");
    await app.waitUntil(() => !app.shows("id:lazy-status"));
    await app.press("open-page");
    await app.waitFor("text:Couldn’t load this page");
    expect(asked.length).toBe(2);

    state.fail = false;
    await app.press("id:lazy-retry");
    await app.waitFor("id:page-label");
    expect(app.shows("text:first")).toBe(true);
    expect(app.shows("id:lazy-status")).toBe(false);
    await app.press("relabel");
    await app.waitFor("text:second");
  });
});
