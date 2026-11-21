// Torn-write protection: a crash leaves a file at full length but zero-filled. Sync must not push it (nor copy it into
// sync-base), a damaged remote version must not replace a good local file, and memory files are restored / snapshotted.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sync from "../src/sync";
import { NUL_RUN, isDamaged, isMemoryPath, recoverMemory, snapshotMemory } from "../src/integrity";
import { DATA, HOME_DIR, guardMemory, P } from "../src/core";

let W = "", t: sync.Transport;
const hosts = { a: "", b: "" };
const as = (h: "a" | "b") => { sync.setSyncData(hosts[h]); sync.setTransport(t); return hosts[h]; };
const put = (h: "a" | "b", rel: string, s: string | Uint8Array) => { const f = join(hosts[h], rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, s); };
const get = (h: "a" | "b", rel: string) => readFileSync(join(hosts[h], rel), "utf8");
const base = (h: "a" | "b", rel: string) => readFileSync(join(W, h, "sync-base", rel), "utf8");
const zeros = (n: number) => new Uint8Array(n);
const GOOD = "# Owner's taste\n\n- prefers short answers\n- reads the raw rows\n";
const BADLEN = Buffer.byteLength(GOOD);
/** Newest version of a path in the fake Worker (history rows come newest first). */
const remoteRow = async (rel: string) => (await t(`/api/files/history?path=${rel}&limit=1&content=1`))!.json.history[0];
const remoteText = async (rel: string) => { const h = await remoteRow(rel); return h && h.content != null ? Buffer.from(h.content, "base64").toString() : null; };
const remoteVersion = async (rel: string) => (await remoteRow(rel)).version as number;

beforeAll(async () => {
  W = mkdtempSync(join(tmpdir(), "hub-integrity-"));
  hosts.a = join(W, "a", "data"); hosts.b = join(W, "b", "data");
  mkdirSync(hosts.a, { recursive: true }); mkdirSync(hosts.b, { recursive: true });
  t = await sync.fakeTransport(join(W, "worker.sqlite"), "test");
  sync.syncTiming.pullMinMs = 0; sync.syncTiming.lazyPushMs = 0;
});
afterAll(() => { sync.setSyncData(DATA, HOME_DIR); try { rmSync(W, { recursive: true, force: true }); } catch {} });

test("isDamaged: all-NUL and long NUL runs in text files, nothing else", () => {
  expect(isDamaged("memory/taste.md", zeros(40582))).toBe(true);
  expect(isDamaged("memory/taste.md", zeros(5))).toBe(true); // a short file that is only NULs
  const half = new Uint8Array(1000); half.set(new TextEncoder().encode(GOOD)); // good head, zeroed tail (a lost block)
  expect(isDamaged("agents/x/memory.md", half)).toBe(true);
  const stray = new TextEncoder().encode("a\0b\0\0c"); // a few NULs are not a torn write
  expect(isDamaged("memory/a.md", stray)).toBe(false);
  expect(isDamaged("memory/a.md", new Uint8Array(NUL_RUN - 1).fill(0).map((_, i) => (i === 3 ? 65 : 0)))).toBe(false);
  expect(isDamaged("memory/a.md", new Uint8Array(0))).toBe(false); // empty is a legitimate file
  expect(isDamaged("media/pic.png", zeros(4096))).toBe(false); // binary formats may hold NULs
  expect(isDamaged("memory/a.md", new TextEncoder().encode(GOOD))).toBe(false);
  expect(isMemoryPath("memory/taste.md") && isMemoryPath("agents/lead/memory.md")).toBe(true);
  expect(isMemoryPath("agents/lead/profile.md") || isMemoryPath("tasks/active/T-1.md")).toBe(false);
});

test("sync never pushes a zero-filled file and never copies it into sync-base", async () => {
  as("a");
  put("a", "memory/taste.md", GOOD); put("a", "tasks/inbox/T-0001.md", "---\nid: T-0001\n---\nhello\n");
  expect(await sync.commitPush("a: seed")).toBe(true);
  sync.takeDamageAlerts();
  // the crash: same length, all zeros; a non-memory file is hit too
  put("a", "memory/taste.md", zeros(BADLEN)); put("a", "tasks/inbox/T-0001.md", zeros(30));
  expect(await sync.commitPush("a: after crash")).toBe(true);
  expect(await remoteText("memory/taste.md")).toBe(GOOD);
  expect(await remoteText("tasks/inbox/T-0001.md")).toContain("hello");
  expect(base("a", "memory/taste.md")).toBe(GOOD);
  const alerts = sync.takeDamageAlerts();
  expect(alerts.map((x) => `${x.side}:${x.path}:${x.nul}`).sort()).toEqual([`local:memory/taste.md:${BADLEN}`, "local:tasks/inbox/T-0001.md:30"]);
  expect(await sync.commitPush("a: again")).toBe(true);
  expect(sync.takeDamageAlerts()).toEqual([]); // reported once per distinct case
  // the other host keeps getting the good copy
  as("b"); expect(await sync.pull()).toBe(true);
  expect(get("b", "memory/taste.md")).toBe(GOOD);
});

test("recoverMemory restores from sync-base, leaves other files alone, and the restored file is already in sync", async () => {
  as("a");
  const r = recoverMemory(hosts.a, sync.syncBaseDir(), sync.snapshotDir());
  expect(r.restored).toEqual([{ path: "memory/taste.md", from: "sync-base", bytes: BADLEN }]);
  expect(r.unrecovered).toEqual([]);
  expect(get("a", "memory/taste.md")).toBe(GOOD);
  expect(readFileSync(join(hosts.a, "tasks/inbox/T-0001.md")).every((b) => b === 0)).toBe(true); // not a memory path: untouched
  const before = await remoteVersion("memory/taste.md");
  expect(await sync.commitPush("a: restored")).toBe(true);
  expect(await remoteVersion("memory/taste.md")).toBe(before); // nothing new to push
  expect(readdirSync(join(hosts.a, "memory")).filter((f) => f.includes("recover"))).toEqual([]); // no temp leftovers
});

test("recoverMemory falls back to the newest good daily snapshot, reports files with no good copy", async () => {
  as("a");
  put("a", "agents/lead/memory.md", "# lead\n- one\n"); put("a", "memory/solo.md", "# solo\n");
  const snaps = sync.snapshotDir();
  expect(snapshotMemory(hosts.a, snaps, "2026-11-01").files).toBe(3);
  put("a", "agents/lead/memory.md", "# lead\n- one\n- two\n");
  expect(snapshotMemory(hosts.a, snaps, "2026-11-02").taken).toBe(true);
  rmSync(join(W, "a", "sync-base", "agents/lead/memory.md"), { force: true }); // never synced → no sync-base copy
  put("a", "agents/lead/memory.md", zeros(20)); put("a", "memory/solo.md", zeros(8));
  rmSync(join(snaps, "2026-11-02", "memory/solo.md")); rmSync(join(snaps, "2026-11-01", "memory/solo.md"));
  const r = recoverMemory(hosts.a, sync.syncBaseDir(), snaps);
  expect(r.restored).toEqual([{ path: "agents/lead/memory.md", from: "snapshot 2026-11-02", bytes: 19 }]);
  expect(r.unrecovered).toEqual([{ path: "memory/solo.md", bytes: 8, nul: 8 }]);
  expect(get("a", "agents/lead/memory.md")).toBe("# lead\n- one\n- two\n");
});

test("snapshotMemory: once per day, skips damaged files, keeps the newest N days, stays out of the data folder", () => {
  const d = mkdtempSync(join(W, "snap-")), snaps = join(W, "snap-out");
  mkdirSync(join(d, "memory"), { recursive: true }); mkdirSync(join(d, "agents/x"), { recursive: true });
  writeFileSync(join(d, "memory/a.md"), "a\n"); writeFileSync(join(d, "memory/bad.md"), zeros(100)); writeFileSync(join(d, "agents/x/memory.md"), "x\n");
  writeFileSync(join(d, "agents/x/profile.md"), "not memory\n");
  const s1 = snapshotMemory(d, snaps, "2026-11-10", 2);
  expect(s1).toEqual({ taken: true, files: 2, skipped: ["memory/bad.md"] });
  expect(existsSync(join(snaps, "2026-11-10/agents/x/profile.md"))).toBe(false);
  expect(snapshotMemory(d, snaps, "2026-11-10", 2).taken).toBe(false); // same day: no second copy
  writeFileSync(join(d, "memory/a.md"), "a2\n"); expect(readFileSync(join(snaps, "2026-11-10/memory/a.md"), "utf8")).toBe("a\n");
  snapshotMemory(d, snaps, "2026-11-11", 2); snapshotMemory(d, snaps, "2026-11-12", 2);
  expect(readdirSync(snaps).sort()).toEqual(["2026-11-11", "2026-11-12"]);
  expect(snapshotMemory(d, snaps, "2026-11-13", 2).taken).toBe(true);
  expect(readdirSync(snaps).filter((x) => x.startsWith(".tmp"))).toEqual([]);
});

test("a zero-filled version in the Worker does not replace a good local file; the next commit pushes the good one over it", async () => {
  as("a"); put("a", "memory/principles.md", "# principles\n- p1\n"); expect(await sync.commitPush("a: p")).toBe(true);
  as("b"); await sync.pull();
  const v = await remoteVersion("memory/principles.md");
  // a machine without the guard pushes the damaged file
  const r = await t("/api/files/commit", { method: "POST", body: { msg: "old build", changes: [{ path: "memory/principles.md", base_version: v, content: Buffer.from(zeros(18)).toString("base64") }] } });
  expect(r!.status).toBe(200);
  as("a"); sync.takeDamageAlerts();
  expect(await sync.pull()).toBe(true);
  expect(get("a", "memory/principles.md")).toBe("# principles\n- p1\n");
  expect(base("a", "memory/principles.md")).toBe("# principles\n- p1\n");
  expect(sync.takeDamageAlerts().map((x) => `${x.side}:${x.path}`)).toEqual(["remote:memory/principles.md"]);
  expect(await sync.commitPush("a: heal")).toBe(true);
  expect(await remoteText("memory/principles.md")).toBe("# principles\n- p1\n");
});

test("damaged remote and damaged local: sync-base keeps the good copy, recovery restores it and the cloud is healed", async () => {
  as("a");
  const v = await remoteVersion("memory/principles.md");
  await t("/api/files/commit", { method: "POST", body: { msg: "old build", changes: [{ path: "memory/principles.md", base_version: v, content: Buffer.from(zeros(18)).toString("base64") }] } });
  put("a", "memory/principles.md", zeros(18)); // the crash also hit this host
  expect(await sync.pull()).toBe(true);
  expect(base("a", "memory/principles.md")).toBe("# principles\n- p1\n"); // not overwritten by the zeros
  expect(recoverMemory(hosts.a, sync.syncBaseDir(), sync.snapshotDir()).restored.map((r) => r.path)).toContain("memory/principles.md");
  expect(await sync.commitPush("a: heal 2")).toBe(true);
  expect(await remoteText("memory/principles.md")).toBe("# principles\n- p1\n");
});

test("resetToUpstream also discards a zero-filled file", async () => {
  as("a"); put("a", "memory/reset.md", "# reset\n- good\n"); expect(await sync.commitPush("a: reset seed")).toBe(true);
  as("b"); await sync.pull();
  put("b", "memory/reset.md", zeros(15)); // the crash hit host b
  expect(await sync.commitPush("b: nothing to push")).toBe(true);
  expect(await sync.resetToUpstream()).toBe(true);
  expect(get("b", "memory/reset.md")).toBe("# reset\n- good\n");
  expect(await remoteText("memory/reset.md")).toBe("# reset\n- good\n");
});

test("guardMemory (daemon): restores, journals what it did, takes today's snapshot, and never throws", () => {
  sync.setSyncData(DATA, HOME_DIR); sync.setTransport(null);
  mkdirSync(P("memory"), { recursive: true }); mkdirSync(P("journal"), { recursive: true });
  writeFileSync(P("memory/focus.md"), zeros(64)); // damaged, but a good copy sits in sync-base
  mkdirSync(join(sync.syncBaseDir(), "memory"), { recursive: true }); writeFileSync(join(sync.syncBaseDir(), "memory/focus.md"), "# focus\n");
  writeFileSync(P("memory/lost.md"), zeros(10)); // damaged, no copy anywhere
  guardMemory("testhost", { full: true });
  expect(readFileSync(P("memory/focus.md"), "utf8")).toBe("# focus\n");
  const journal = readdirSync(P("journal")).map((f) => readFileSync(P("journal", f), "utf8")).join("\n");
  expect(journal).toContain("memory/focus.md");
  expect(journal).toMatch(/memory\/lost\.md.*(no good copy|没有可用的好副本)/);
  expect(journal).toMatch(/memory snapshot skipped damaged files: memory\/lost\.md|记忆快照跳过了损坏的文件：memory\/lost\.md/);
  expect(readdirSync(sync.snapshotDir()).length).toBe(1);
  expect(readFileSync(join(sync.snapshotDir(), readdirSync(sync.snapshotDir())[0], "memory/focus.md"), "utf8")).toBe("# focus\n");
  rmSync(P("memory"), { recursive: true, force: true }); // a missing folder is fine too
  expect(() => guardMemory("testhost")).not.toThrow();
});
