import { describe, expect, open, test } from "nsh/test";

describe("main window", () => {
  test("on macOS closing it hides it, and the Dock icon shows it again", async () => {
    const app = await open("./App.tsx", { platform: "macos", network: {} });
    await app.waitUntil(() => app.window("main").state()?.visible === true);
    await app.window("main").pressClose();
    await app.waitUntil(() => app.window("main").state()?.visible === false);
    expect(app.windowIds()).toEqual(["main"]);
    expect(app.quit()).toBe(false);
    await app.reopen();
    await app.waitUntil(() => app.window("main").state()?.visible === true);
    expect(app.windowIds()).toEqual(["main"]);
  });

  test("on Windows closing it still quits", async () => {
    const app = await open("./App.tsx", { platform: "windows", network: {} });
    await app.window("main").pressClose();
    await app.waitUntil(() => app.window("main").state() === null);
    expect(app.quit()).toBe(true);
  });
});
