import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedClis, chooseCli } from "../src/core";
import { failoverAccount } from "../src/accounts";
import { routerClis } from "../src/runner";

const codexOnly = { clis: { agents: { lead: ["codex"], reviewer: ["codex"] } } };

test("member settings override stale task pins, difficulty and preference order", () => {
  expect(allowedClis({ agent: "lead", cli: "claude", difficulty: "hard" }, codexOnly)).toEqual(["codex"]);
  expect(allowedClis({ agent: "reviewer", cli: "claude" }, codexOnly)).toEqual(["codex"]);
  expect(allowedClis({ cli: "codex" }, { clis: { agents: { lead: ["claude", "codex"] } } })).toEqual(["claude", "codex"]);
  expect(allowedClis({ cli: "codex" }, {})).toEqual(["codex"]);
  expect(allowedClis({}, {})).toEqual(["claude", "codex"]);
  expect(allowedClis({}, { clis: { agents: { lead: [] } } })).toEqual([]);
  expect(chooseCli({}, { clis: { agents: { lead: [] } } })).toBeNull();
});

test("recovery never adds a disabled CLI, including when only that CLI is installed", () => {
  const cfg = { accounts: [{ cli: "codex", name: "test-a" }, { cli: "claude", name: "test-b" }] };
  const failed = { cli: "codex", name: "test-a", dir: "" };
  expect(failoverAccount(cfg, failed, ["codex"], () => true)).toBeNull();
  expect(failoverAccount(cfg, null, ["codex"], (c) => c === "claude")).toBeNull();
  expect(failoverAccount(cfg, failed, ["codex", "claude"], () => true)?.cli).toBe("claude");
});

test("system routing respects lead restrictions even with an explicit router override", () => {
  expect(routerClis({ ...codexOnly, router: { cli: "claude", model: "claude-test" } })).toEqual([{ cli: "codex", model: "gpt-6-luna" }]);
  expect(routerClis({ clis: { agents: { lead: [] } } })).toEqual([]);
  expect(routerClis({})).toHaveLength(2);
});

test("chat, router, judge and medic never launch disabled Claude", async () => {
  const w = mkdtempSync(join(tmpdir(), "noop-cli-policy-"));
  try {
    const bin = join(w, "bin"), data = join(w, "data"), trace = join(w, "calls");
    mkdirSync(bin); mkdirSync(data);
    for (const cli of ["claude", "codex"]) writeFileSync(join(bin, cli), `#!/bin/sh\ncat >/dev/null\necho ${cli} >> "$TRACE"\nprintf '\x60\x60\x60json\\n{"ok":true,"fixed":true,"summary":"fixture"}\\n\x60\x60\x60\\n'\n`, { mode: 0o755 });
    const core = fileURLToPath(new URL("../src/core.ts", import.meta.url));
    const runner = fileURLToPath(new URL("../src/runner.ts", import.meta.url));
    const medic = fileURLToPath(new URL("../src/medic.ts", import.meta.url));
    const brain = fileURLToPath(new URL("../src/brain.ts", import.meta.url));
    const script = join(w, "run.ts");
    writeFileSync(script, `
      import { quickAsk, ask } from ${JSON.stringify(runner)};
      import { medic } from ${JSON.stringify(medic)};
      import { P } from ${JSON.stringify(core)};
      import { chatModel } from ${JSON.stringify(brain)};
      const cfg = ${JSON.stringify({ ...codexOnly, router: { cli: "claude" }, judge: { cli: "claude" }, medic: { push: false } })};
      const chat = chatModel(cfg);
      if (chat) throw new Error("disabled Claude chat model was created");
      let current = {};
      const warm = chatModel(current, () => current);
      if (!warm) throw new Error("enabled Claude chat model was not created");
      current = cfg;
      warm.warm("fixture");
      let blocked = false;
      try { await warm.open("fixture"); } catch { blocked = true; }
      if (!blocked) throw new Error("chat ignored a live settings change");
      warm.stop();
      if (!(await quickAsk("fixture", cfg, P("router.log")))?.ok) throw new Error("router failed");
      if (!(await ask("fixture", cfg, P("judge.log")))?.ok) throw new Error("judge failed");
      if (!(await medic("fixture", cfg))?.fixed) throw new Error("medic failed");
      const none = { clis: { agents: { lead: [] } } };
      if (await quickAsk("fixture", none, P("none.log"))) throw new Error("disabled router ran");
      if (await ask("fixture", none, P("none.log"))) throw new Error("disabled judge ran");
      if (await medic("fixture", none)) throw new Error("disabled medic ran");
    `);
    const proc = Bun.spawn([process.execPath, script], { env: { ...process.env, NOOP_HOME: join(w, "home"), HUB_DATA: data,
      HUB_SYNC: "local", HUB_NO_MEDIC: "", PATH: `${bin}:${process.env.PATH}`, TRACE: trace }, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual(["codex", "codex", "codex"]);
  } finally { rmSync(w, { recursive: true, force: true }); }
});
