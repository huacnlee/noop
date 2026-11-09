// A task pinned to a CLI that no online host can run must fall back instead of parking in inbox forever
// (seen live: planner pinned cli:codex, the only host had no codex on PATH → uptime-watch stalled 5 days).
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const core = await import("../src/core");
const { P, runnableClis, writeDoc } = core;
if (!core.DATA.startsWith(tmpdir())) throw new Error(`refusing to run: DATA=${core.DATA} is not a temp dir`);

afterAll(() => rmSync(core.DATA, { recursive: true, force: true }));
beforeEach(() => rmSync(core.DATA, { recursive: true, force: true }));

const beat = (host: string, caps: string[], minAgo = 1) => {
  const p = P("fleet", "hosts", `${host}.json`);
  mkdirSync(p.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(p, JSON.stringify({ host, caps, seen: new Date(Date.now() - minAgo * 60_000).toISOString(), busy: 0, version: "1" }));
};
const cfg = {} as any;
const installed = ["claude", "codex"].includes(process.env.TEST_CLI ?? "claude") ? "claude" : "claude";

// Bun.which in this test env: only assume claude may exist; pin codex → must fall back to an allowed cli.
test("pinned cli absent on every online host falls back", () => {
  beat("pc", ["os:linux", "host:pc", "cli:claude"]);
  const meta = { agent: "ops-watcher", cli: "codex" };
  const r = runnableClis(meta, cfg);
  expect(r).not.toEqual(["codex"]);
  expect(r).toContain("claude");
});

test("pinned cli present on another online host stays pinned", () => {
  beat("pc", ["os:linux", "host:pc", "cli:claude"]);
  beat("w2", ["os:linux", "host:w2", "cli:codex"]);
  expect(runnableClis({ agent: "ops-watcher", cli: "codex" }, cfg)).toEqual(["codex"]);
});

test("unpinned task keeps default order", () => {
  beat("pc", ["os:linux", "host:pc", "cli:claude"]);
  expect(runnableClis({ agent: "lead" }, cfg)).toEqual(["claude", "codex"]);
});

test("per-agent config is the fallback list", () => {
  beat("pc", ["os:linux", "host:pc", "cli:claude"]);
  const cfg2 = { clis: { agents: { dispatcher: ["claude"] } } } as any;
  expect(runnableClis({ agent: "dispatcher", cli: "codex" }, cfg2)).toEqual(["claude"]);
});
