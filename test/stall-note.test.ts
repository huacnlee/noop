import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("a tick that holds queued tasks but starts none journals why, once per hour", () => {
  const proc = Bun.spawnSync([process.execPath, "--preload", "./test/preload.ts", "--eval", `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
    const core = { ...await import("./src/core") };
    const accounts = { ...await import("./src/accounts") };
    const resources = { ...await import("./src/resources") };
    const github = { ...await import("./src/github") };
    mkdirSync(core.P("journal"), { recursive: true });
    mkdirSync(core.P("tasks", "inbox"), { recursive: true });
    writeFileSync(core.P("tasks", "inbox", "T-0001.md"), "---\\nid: T-0001\\nagent: lead\\n---\\nwork");
    let allow = 0;
    mock.module("./src/core", () => ({ ...core, hostName: () => "worker", heartbeat: () => {}, pickTask: () => null }));
    mock.module("./src/accounts", () => ({
      ...accounts,
      pickAccount: () => ({ cli: "codex", name: "test", dir: "" }),
      pendingLoginIds: () => new Set(),
      retryLogins: async () => {},
    }));
    mock.module("./src/resources", () => ({
      ...resources,
      sample: () => ({ load1: 16, cores: 16, loadRatio: 1, cpuBusyPct: 27, memFreePct: 4, diskFreeGB: 15, diskFreePct: 2 }),
      allowedParallel: () => allow,
      canRunHeavy: () => false,
      ensureDisk: async () => {},
    }));
    mock.module("./src/github", () => ({ ...github, githubStarved: async () => ({ starved: false }) }));
    const read = () => readdirSync(core.P("journal")).map((f) => readFileSync(core.P("journal", f), "utf8")).join("\\n");
    const { tick } = await import("./src/cli");
    const cfg = { fleet: { primary: "primary" } };
    await tick(cfg, false);
    assert.match(read(), /none started|一个都没启动/);
    assert.match(read(), /0 allowed \\(mem free 4%/);
    // The same gate on the next tick is throttled to one line an hour, not one a minute.
    await tick(cfg, false);
    assert.equal((read().match(/none started|一个都没启动/g) ?? []).length, 1);
    // A different gate is reported at once instead of waiting out the hour.
    allow = 1;
    await tick(cfg, false);
    assert.equal((read().match(/none started|一个都没启动/g) ?? []).length, 2);
    assert.match(read(), /no queued task this host can run now|队列里没有本机现在能跑的任务/);
  `], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  expect(proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
}, 30_000);
