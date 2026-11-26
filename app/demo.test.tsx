import { describe, expect, open, test } from "nsh/test";
import { createDemoHub, isDemo } from "./demo";

describe("demo server", () => {
  test("demo addresses are recognised, real ones are not", () => {
    expect(isDemo("http://demo")).toBe(true);
    expect(isDemo("demo")).toBe(true);
    expect(isDemo("https://demo.example.com")).toBe(false);
    expect(isDemo("https://noop.acme.workers.dev")).toBe(false);
  });

  test("signs in with any code and a message becomes a finished task", async () => {
    const hub = createDemoHub({ pace: 0 });
    expect((await hub.handle("POST", "/api/auth/start", { email: "x@y.z" })).data).toEqual({ ok: true, delivery: "demo" });
    expect((await hub.handle("POST", "/api/auth/verify", { code: "ANYTHING", totp: "123456" })).status).toBe(200);
    const frames: string[] = [];
    hub.connect((f) => frames.push(f));
    const before = hub.status().tasks.done;
    await hub.handle("POST", "/api/messages", { text: "Check the website for broken links" });
    expect(hub.status().tasks.done).toBe(before + 1);
    const feed = (await hub.handle("GET", "/api/feed")).data as { events: { from: string; text: string }[] };
    expect(feed.events.some((e) => e.from === "lead@studio" && e.text.includes("214 links"))).toBe(true);
    expect(frames.some((f) => f.includes("$status"))).toBe(true);
  });

  test("answering the open decision closes it", async () => {
    const hub = createDemoHub({ pace: 0 });
    expect(hub.status().decisions.map((d) => d.id)).toEqual(["D-0041", "P-0007"]);
    await hub.handle("POST", "/api/messages", { text: "D-0041 A", reply_to: "D-0041" });
    expect(hub.status().decisions.map((d) => d.id)).toEqual(["P-0007"]);
  });

  test("history, task detail, channels, files and settings answer", async () => {
    const hub = createDemoHub({ pace: 0 });
    const list = (await hub.handle("GET", "/api/tasks?limit=30&offset=0&q=login")).data as { tasks: { id: string }[]; total: number };
    expect(list.tasks.map((t) => t.id)).toEqual(["T-0116"]);
    const task = (await hub.handle("GET", "/api/tasks/get?id=T-0116")).data as { decisions: string[]; events: unknown[] };
    expect(task.decisions).toEqual(["D-0041"]);
    expect(task.events.length).toBeGreaterThan(0);
    const ch = (await hub.handle("GET", "/api/channels")).data as { channels: { slug: string }[] };
    expect(ch.channels.map((c) => c.slug)).toEqual(["website"]);
    expect((await hub.handle("GET", "/api/files/read?path=memory%2Fpreferences.md")).status).toBe(200);
    expect((await hub.handle("GET", "/media/demo-report.md")).text).toContain("PR #42");
    expect((await hub.handle("PUT", "/api/settings", { max_parallel: 2 })).status).toBe(200);
  });
});

describe("demo in the app", () => {
  test("the test account opens a working chat at once, without codes or any network", async () => {
    const app = await open("./App.tsx", { network: {} });
    await app.waitFor("Sign in to Noop");
    await app.type("id:email", "Demo@noop.dev");
    await app.press("id:send-code");
    await app.waitFor("id:composer");
    await app.waitFor("text:/Merge PR #42/");
    expect(app.storage()["hub.url"]).toBe("http://demo");
    expect(app.storage()["hub.email"]).toBe("demo@noop.dev");
  });

  test("the visible Try the demo link opens the demo on every platform", async () => {
    const app = await open("./App.tsx", { network: {} });
    await app.waitFor("id:try-demo");
    await app.press("id:try-demo");
    await app.waitFor("id:composer");
    expect(app.storage()["hub.url"]).toBe("http://demo");
  });

  test("a task's self-grade shows under its result, in the task list and on its page", async () => {
    const app = await open("./App.tsx", { network: {} });
    await app.waitFor("id:try-demo");
    await app.press("id:try-demo");
    await app.waitFor("id:composer");
    // under the agent's result in the chat
    await app.waitFor("text:Attention 24");
    await app.waitFor("text:Over-built");
    // the task's own page: the radar, the meters and each grade's evidence
    await app.press("text:T-0116");
    await app.waitFor("id:task-grade");
    await app.waitFor("id:task-grade-radar");
    await app.waitFor("text:/Right-sized/");
    await app.waitFor("text:/50 CI runs in a row passed/");
    if (process.env.GRADE_SHOTS) await app.screenshot(`${process.env.GRADE_SHOTS}/task-grade.png`);
  });

  test("the address demo signs in with the codes it shows", async () => {
    const app = await open("./App.tsx", { network: {} });
    await app.waitFor("Sign in to Noop");
    await app.clear("id:url");
    await app.type("id:url", "demo");
    await app.type("id:email", "review@example.com");
    await app.press("id:send-code");
    await app.waitFor("text:/Demo server: enter DEMO2026/");
    await app.type("id:totp", "000000");
    await app.type("id:code", "DEMO2026");
    await app.waitFor("id:composer");
  });
});
