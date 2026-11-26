// A stale active copy of a task that is queued again must not be requeued over and over: each reap rewrote the inbox
// copy from the stale claim and reset its attempt/stall counters, so a task could retry forever.
// 2026-11-25: 69 "requeued (host … offline)" lines for three tasks, all on the host that was writing them.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { DATA, HOME_DIR, P, claim, readDoc, writeDoc } from "../src/core";
import { reapStale } from "../src/cli";
import * as sync from "../src/sync";

const H = 3_600_000;
const hoursAgo = (n: number) => new Date(Date.now() - n * H).toISOString();
const clean: string[] = [];
mkdirSync(P("journal"), { recursive: true }); // reapStale journals what it did
afterAll(() => { for (const f of clean) rmSync(f, { force: true }); });

test("a stale claim of a queued task is dropped, not requeued over the queue copy", () => {
  const id = "T-9401";
  const active = P("tasks", "active", `${id}.md`), inbox = P("tasks", "inbox", `${id}.md`);
  mkdirSync(P("tasks", "active"), { recursive: true });
  mkdirSync(P("tasks", "inbox"), { recursive: true });
  clean.push(active, inbox);
  writeDoc(active, { id, title: "stale claim", claimed_by: "h1", started: hoursAgo(2) }, "body\n");
  writeDoc(inbox, { id, title: "queued again", attempt: "2", stalls: "1" }, "body\n");
  reapStale({} as never, "h1");
  expect(existsSync(active)).toBe(false); // the stale claim is gone
  const q = readDoc(inbox).meta;
  expect(q.attempt).toBe("2"); // the queue copy keeps its retry counters
  expect(q.stalls).toBe("1");
});

test("an own-host orphan with no queued copy is still requeued", () => {
  const id = "T-9402";
  const active = P("tasks", "active", `${id}.md`), inbox = P("tasks", "inbox", `${id}.md`);
  rmSync(inbox, { force: true });
  mkdirSync(P("tasks", "active"), { recursive: true });
  clean.push(active, inbox);
  writeDoc(active, { id, title: "orphan", claimed_by: "h1", started: hoursAgo(2) }, "body\n");
  reapStale({} as never, "h1");
  expect(existsSync(active)).toBe(false);
  expect(existsSync(inbox)).toBe(true);
});

test("a failed claim does not restore a stale active copy of a task that is queued again", async () => {
  sync.setSyncData(DATA, HOME_DIR);
  const t = await sync.fakeTransport(":memory:", "test"); // in memory: Windows cannot remove a database file still open
  sync.syncTiming.pullMinMs = 0; sync.syncTiming.lazyPushMs = 0;
  const id = "T-9403";
  const inbox = P("tasks", "inbox", `${id}.md`), active = P("tasks", "active", `${id}.md`);
  mkdirSync(P("tasks", "inbox"), { recursive: true });
  clean.push(inbox, active);
  writeFileSync(inbox, `---\nid: ${id}\ntitle: x\n---\nbody\n`);
  sync.setTransport(t);
  try {
    // the first claim reaches the Worker, so the sync base remembers tasks/active/T-9403.md
    expect(await claim(inbox, "h1")).toBe(active);
    expect(existsSync(active)).toBe(true);
    // the run stalls and puts the task back, but that delete never reaches the Worker (offline at that moment)
    writeFileSync(inbox, `---\nid: ${id}\ntitle: x\nrequeued: ${hoursAgo(1)}\n---\nbody\n`);
    unlinkSync(active);
    sync.setTransport(async () => null); // offline: the next claim cannot be pushed
    expect(await claim(inbox, "h1")).toBeNull();
    expect(existsSync(active)).toBe(false); // the stale claim must not come back from the sync base
    expect(existsSync(inbox)).toBe(true); // the task stays queued
  } finally {
    sync.setTransport(null);
  }
});
