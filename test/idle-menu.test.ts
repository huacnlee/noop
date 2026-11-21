import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DATA, P, list, readDoc, writeDoc } from "../src/core";
import { maybeProposeNext } from "../src/cli";

const dirs = ["tasks/inbox", "tasks/active", "decisions/open", "decisions/closed", "journal"];
const cfg = { idle: { after_minutes: 20, cooldown_minutes: 180 } };
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const state = () => ({ idle_since: ago(60), last_menu: ago(30) });
const menu = (id: string, minutes: number, kind = "menu") =>
  writeDoc(P("decisions/open", `${id}.md`), { id, kind, created: ago(minutes) }, "pending");
const tasks = () => list(P("tasks/inbox"));

beforeEach(() => {
  if (!DATA.startsWith(tmpdir())) throw new Error(`Refusing to use live DATA: ${DATA}`);
  for (const dir of dirs) {
    rmSync(P(dir), { recursive: true, force: true });
    mkdirSync(P(dir), { recursive: true });
  }
});
afterAll(() => {
  for (const dir of dirs) rmSync(P(dir), { recursive: true, force: true });
});

test("a recent pending menu suppresses another even when an older menu sorts first", () => {
  menu("D-F0004", 480);
  menu("D-F0014", 179);
  maybeProposeNext(cfg, "test", state());
  expect(tasks()).toEqual([]);
});

test("cooldown expiry refreshes the latest menu by time, ignoring newer non-menu decisions", () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    menu("D-F0004", 180);
    menu("D-F0014", 480);
    menu("D-9999", 1, "decision");
    maybeProposeNext(cfg, "test", state());
    expect(tasks()).toHaveLength(1);
    const task = readDoc(tasks()[0]);
    expect(task.meta.kind).toBe("menu");
    expect(task.body).toContain("An earlier menu D-F0004 is still unanswered");
    expect(task.body).not.toContain("An earlier menu D-F0014");
  } finally { clock.mockRestore(); }
});

test("without pending menus the existing 15-minute generation guard still applies", () => {
  maybeProposeNext(cfg, "test", { idle_since: ago(60), last_menu: ago(14) });
  expect(tasks()).toEqual([]);
  maybeProposeNext(cfg, "test", state());
  expect(tasks()).toHaveLength(1);
});

test("active work resets the idle window and prevents a menu", () => {
  writeDoc(P("tasks/active/T-0001.md"), { id: "T-0001" }, "work");
  const st: Record<string, string> = state();
  maybeProposeNext(cfg, "test", st);
  expect(tasks()).toEqual([]);
  expect(st.idle_since).toBeUndefined();
});

test("an idle run that raised no menu waits out the full cooldown before the next one", () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    // T-0100 was the last idle run; the chief of staff found nothing worth asking, so no decision points at it.
    const st = { idle_since: ago(600), last_menu: ago(30), last_idle_task: "T-0100" };
    maybeProposeNext(cfg, "test", st);
    expect(tasks()).toEqual([]);
    maybeProposeNext(cfg, "test", { ...st, last_menu: ago(181) });
    expect(tasks()).toHaveLength(1);
  } finally { clock.mockRestore(); }
});

test("an idle run whose menu was answered does not delay the next menu past the 15-minute guard", () => {
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    writeDoc(P("decisions/closed", "D-0001.md"), { id: "D-0001", kind: "menu", task: "T-0100", created: ago(40) }, "answered");
    maybeProposeNext(cfg, "test", { idle_since: ago(60), last_menu: ago(30), last_idle_task: "T-0100" });
    expect(tasks()).toHaveLength(1);
  } finally { clock.mockRestore(); }
});

test("launching an idle run remembers its task id for the next check", () => {
  const st: Record<string, string> = { idle_since: ago(60) };
  maybeProposeNext(cfg, "test", st);
  expect(st.last_idle_task).toBe(readDoc(tasks()[0]).meta.id);
});
