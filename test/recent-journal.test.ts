import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { P, recentJournal } from "../src/core";

// other test files share this data dir and journal today's date, which would sort after the fixed days below
const freshJournal = () => {
  rmSync(P("journal"), { recursive: true, force: true });
  mkdirSync(P("journal"), { recursive: true });
};

test("the prompt's recent journal is the latest days, even when agents left other notes in journal/", () => {
  freshJournal();
  writeFileSync(P("journal", "2026-11-20.md"), "- 10:00 day one\n");
  writeFileSync(P("journal", "2026-11-21.md"), "- 10:00 day two\n");
  // agent-written notes sort after the dated files by name
  writeFileSync(P("journal", "T-0001.md"), "task note\n");
  writeFileSync(P("journal", "uptime-watch-T-0002.md"), "uptime note\n");
  const text = recentJournal();
  expect(text).toContain("day one");
  expect(text).toContain("day two");
  expect(text).not.toContain("uptime note");
});

test("a task's timeline in the app reads the daily journal, not the agent notes after it", async () => {
  const { status } = await import("../src/server");
  freshJournal();
  mkdirSync(P("tasks", "done"), { recursive: true });
  writeFileSync(P("tasks", "done", "T-0003.md"), "---\nid: T-0003\ntitle: t\nfinished: 2999-01-01T00:00:00Z\n---\n\nbody\n");
  writeFileSync(P("journal", "2026-11-21.md"), "- 10:00 `pc` ✅ T-0003 did it\n");
  writeFileSync(P("journal", "uptime-watch-T-0004.md"), "uptime note\n");
  expect(status().recent.find((t) => t.id === "T-0003")?.steps).toHaveLength(1);
});
