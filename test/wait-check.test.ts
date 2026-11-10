import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkWaits, wakeParents } from "../src/cli";
import { P, readDoc, writeDoc } from "../src/core";
import { newWaitCheckMode, waitCheckMode } from "../src/waits";

const id = "T-99075";
const path = P("tasks", "waiting", `${id}.md`);
const scratch = mkdtempSync(join(tmpdir(), "noop-completion-"));
const flag = join(scratch, "exit-code").replace(/\\/g, "/");
const cmd = `exit $(cat '${flag}')`;
const t0 = Date.now();
mkdirSync(P("journal"), { recursive: true });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const put = (extra: Record<string, string> = {}) => writeDoc(path, {
  id, title: "completion test", wait_kind: "ci", wake_at: new Date(t0 + 3_600_000).toISOString(),
  parked_at: new Date(t0).toISOString(), wait_check: cmd, wait_check_mode: "success", ...extra,
}, "test body");
const poll = async (offset = 0) => (await checkWaits(t0 + offset, 1000)).has(id);
afterEach(() => {
  for (const folder of ["waiting", "inbox", "blocked"]) rmSync(P("tasks", folder, `${id}.md`), { force: true });
  rmSync(flag, { force: true });
});

test("new machine waits default to success; persisted legacy and human waits keep change", () => {
  expect(newWaitCheckMode({ wait_kind: "ci" })).toBe("success");
  expect(newWaitCheckMode({ wait_check_mode: "change" })).toBe("change");
  expect(newWaitCheckMode({ waiting_on: "owner 手动合并", wait_check_mode: "success" })).toBe("change");
  expect(waitCheckMode({})).toBe("change");
  expect(waitCheckMode({ wait_kind: "human", wait_check_mode: "success" })).toBe("change");
});

test("already complete on the first poll requeues immediately without a baseline write or wake penalty", async () => {
  writeFileSync(flag, "0"); put({ wakes: "4" });
  const ready = await checkWaits(t0, 1000);
  expect(ready.has(id)).toBe(true);
  expect(readDoc(path).meta.wait_check_base).toBeUndefined();
  wakeParents("test", ready);
  expect(existsSync(path)).toBe(false);
  const resumed = readDoc(P("tasks", "inbox", `${id}.md`));
  expect(resumed.meta.wakes).toBe("4");
  expect(resumed.meta.resumed).toBe("yes");
  expect(resumed.meta.gate_override).toBeUndefined();
});

test("pending remains parked across different failure codes and wakes only on success", async () => {
  writeFileSync(flag, "8"); put();
  expect(await poll()).toBe(false);
  const before = readDoc(path);
  writeFileSync(flag, "1");
  expect(await poll(2000)).toBe(false);
  expect(readDoc(path)).toEqual(before); // no steady-state hub writes
  writeFileSync(flag, "0");
  expect(await poll(2010)).toBe(false); // backoff still applies
  expect(await poll(4000)).toBe(true);
});

test("a fresh daemon accepts success even with a saved zero baseline", async () => {
  writeFileSync(flag, "0"); put({ wait_check_base: `0 ${cmd}` });
  const modulePath = resolve(import.meta.dir, "../src/cli.ts");
  const proc = Bun.spawn([process.execPath, "--eval", `const {checkWaits}=await import(${JSON.stringify(modulePath)}); console.log(JSON.stringify([...await checkWaits()]));`], {
    cwd: tmpdir(), env: process.env, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(err).toBe(""); expect(code).toBe(0); expect(JSON.parse(out)).toContain(id);
});

test("legacy waits with no mode keep a zero baseline until the exit code changes", async () => {
  writeFileSync(flag, "0"); put();
  const doc = readDoc(path); delete doc.meta.wait_check_mode; writeDoc(path, doc.meta, doc.body);
  expect(await poll()).toBe(false);
  expect(readDoc(path).meta.wait_check_base).toBe(`0 ${cmd}`);
  expect(await poll(2000)).toBe(false);
  writeFileSync(flag, "7");
  expect(await poll(4000)).toBe(true);
});

test("explicit change mode accepts pending to failed, preserving nonzero terminal checks", async () => {
  writeFileSync(flag, "1"); put({ wait_check_mode: "change", wait_check_base: `8 ${cmd}` });
  expect(await poll()).toBe(true);
});

test.each(["noop-no-such-check-command-99075", "if", "kill -TERM $$"])("execution error is not completion: %s", async (command) => {
  put({ wait_check: command });
  expect(await poll()).toBe(false);
  expect(await poll(2000)).toBe(false);
  expect(readDoc(path).meta.wait_check_base).toBeUndefined();
});

test("a missing bash executable is an unanswered poll and backs off", async () => {
  put();
  const saved = process.env.PATH;
  try {
    process.env.PATH = scratch; // no bash to launch
    expect(await poll()).toBe(false);
  } finally { process.env.PATH = saved; }
  writeFileSync(flag, "0");
  expect(await poll(10)).toBe(false);
  expect(await poll(2000)).toBe(true);
});

test("human waits do not wake on initial success or on a stale deadline", async () => {
  writeFileSync(flag, "0");
  put({ wait_kind: "human", wake_at: new Date(0).toISOString() });
  expect(await poll()).toBe(false);
  expect(await poll(2000)).toBe(false);
  wakeParents("test");
  expect(existsSync(path)).toBe(true);
  expect(existsSync(P("tasks", "inbox", `${id}.md`))).toBe(false);
  // A later observed event can resume work, without granting approval.
  writeFileSync(flag, "1");
  wakeParents("test", await checkWaits(t0 + 4000, 1000));
  expect(readDoc(P("tasks", "inbox", `${id}.md`)).meta.gate_override).toBeUndefined();
});

test("owner decision tasks in blocked are never auto-unblocked", async () => {
  writeDoc(P("tasks", "blocked", `${id}.md`), {
    id, wait_kind: "human", decision: "D-99075", wait_check: "true", wait_check_mode: "success",
  }, "await owner");
  expect(await poll()).toBe(false);
  wakeParents("test", new Set([id]));
  expect(existsSync(P("tasks", "blocked", `${id}.md`))).toBe(true);
  expect(existsSync(P("tasks", "inbox", `${id}.md`))).toBe(false);
});

test("switching an existing check from change to success invalidates its cache", async () => {
  writeFileSync(flag, "0"); put({ wait_check_mode: "change" });
  expect(await poll()).toBe(false);
  put();
  expect(await poll(10)).toBe(true);
});

test("a result from a replaced task is discarded", async () => {
  put({ wait_check: "sleep 0.1; exit 0" });
  const checking = poll();
  put({ wait_check: "exit 8", parked_at: new Date(t0 + 1).toISOString() });
  expect(await checking).toBe(false);
  expect(readDoc(path).meta.wait_check).toBe("exit 8");
});
