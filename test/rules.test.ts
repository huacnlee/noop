import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA, HOME_DIR, P, list, readDoc } from "../src/core";
import { FILE_BUDGET, buildRules, maybeCompactMemory } from "../src/rules";

const hub = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "rules-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(d, rel, ".."), { recursive: true });
    writeFileSync(join(d, rel), text);
  }
  return d;
};

test("logs and archives are listed by path instead of inlined", () => {
  const d = hub({
    "policies/autonomy.md": "gate: merge needs the owner",
    "memory/principles.md": "rule P",
    "memory/lessons.md": "- override log line",
    "memory/principles-archive-2026-11-18.md": "old rule",
  });
  const { body, omitted } = buildRules(d);
  expect(body).toContain("gate: merge needs the owner");
  expect(body).toContain("rule P");
  expect(body).not.toContain("override log line");
  expect(body).not.toContain("old rule");
  expect(body).toContain(join(d, "memory/lessons.md"));
  expect(body).toContain(join(d, "memory/principles-archive-2026-11-18.md"));
  expect(omitted.map((o) => o.why).sort()).toEqual(["archive", "log"]);
});

test("the budget keeps the important files and names the ones left out", () => {
  const d = hub({
    "memory/a-notes.md": "x".repeat(3000),
    "memory/principles.md": "p".repeat(3000),
    "memory/owner.md": "o".repeat(3000),
  });
  const { body, omitted } = buildRules(d, 7000);
  expect(body.length).toBeLessThan(7000 + 500);
  expect(body).toContain("p".repeat(3000));
  expect(body).toContain("o".repeat(3000));
  expect(omitted).toEqual([{ path: "memory/a-notes.md", chars: 3000, why: "budget" }]);
  expect(body).toContain(join(d, "memory/a-notes.md"));
});

test("an oversized memory file is reported, a log of the same size is not", () => {
  const d = hub({ "memory/taste.md": "t".repeat(FILE_BUDGET + 1), "memory/lessons.md": "l".repeat(FILE_BUDGET + 1) });
  expect(buildRules(d).oversized).toEqual([{ path: "memory/taste.md", chars: FILE_BUDGET + 1 }]);
});

beforeEach(() => {
  if (!DATA.startsWith(tmpdir())) throw new Error(`Refusing to use live DATA: ${DATA}`);
  rmSync(P("tasks"), { recursive: true, force: true });
  for (const f of ["inbox", "proposed", "active", "waiting", "blocked"]) mkdirSync(P("tasks", f), { recursive: true });
  rmSync(join(HOME_DIR, "memory-compact.json"), { force: true });
});

test("compaction is queued once: not while one is open, and not again within a day", () => {
  const build = buildRules(hub({ "memory/principles.md": "p".repeat(FILE_BUDGET + 10) }));
  const now = Date.now();
  const id = maybeCompactMemory("test", build, now);
  expect(id).toBeTruthy();
  const tasks = () => ["inbox", "proposed"].flatMap((f) => list(P("tasks", f)));
  expect(tasks()).toHaveLength(1);
  const { meta, body } = readDoc(tasks()[0]);
  expect(meta.kind).toBe("memory-compact");
  expect(body).toContain("memory/principles.md");
  expect(body).toContain("memory/archive/");
  expect(body).toContain("memory-compact.diff");
  expect(maybeCompactMemory("test", build, now + 1000)).toBeNull(); // still open
  rmSync(tasks()[0]);
  expect(maybeCompactMemory("test", build, now + 3_600_000)).toBeNull(); // done, but within the cooldown
  expect(maybeCompactMemory("test", build, now + 25 * 3_600_000)).toBeTruthy();
});

test("nothing is queued while every file fits", () => {
  expect(maybeCompactMemory("test", buildRules(hub({ "memory/principles.md": "short" })))).toBeNull();
});
