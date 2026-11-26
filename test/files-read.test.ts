import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FilesSql, handleFiles, handleReadFiles, initFilesSchema, prefixEnd, readable } from "../cloud/src/files";
import { listDataFiles, readDataFile } from "../src/server";

/** bun:sqlite adapter for the DO SqlStorage subset; records every query. */
function sqlOf(): FilesSql & { queries: string[] } {
  const db = new Database(":memory:");
  const queries: string[] = [];
  return {
    queries,
    exec(q: string, ...raw: any[]) {
      const b = raw.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
      queries.push(q);
      const parts = q.split(";").map((s) => s.trim()).filter(Boolean);
      let rows: any[] = [];
      for (const part of parts) {
        const st = db.query(part);
        if (/^SELECT/i.test(part)) rows = st.all(...b) as any[];
        else st.run(...b);
      }
      return { toArray: () => rows };
    },
  };
}
const b64 = (s: string) => Buffer.from(s).toString("base64");

test("readable whitelist", () => {
  expect(readable("policies/a.md")).toBe(true);
  expect(readable("decisions/closed/D-1.md")).toBe(true);
  expect(readable("config.toml")).toBe(false);
  expect(readable("decisions/open/D-2.md")).toBe(false);
  expect(readable("tasks/")).toBe(false);
  expect(readable("policies/../config.toml")).toBe(false);
  expect(prefixEnd("memory/")).toBe("memory0");
});

test("worker list/read: files table only, whitelist enforced", async () => {
  const sql = sqlOf();
  initFilesSchema(sql);
  const commit = new Request("http://x/api/files/commit", { method: "POST", body: JSON.stringify({ msg: "seed", changes: [
    { path: "policies/a.md", base_version: 0, content: b64("# 规则") },
    { path: "policies0", base_version: 0, content: b64("x") },
    { path: "config.toml", base_version: 0, content: b64("secret") },
  ] }) });
  expect((await handleFiles(sql, commit, new URL(commit.url), "m"))!.status).toBe(200);
  sql.queries.length = 0;
  let r = handleReadFiles(sql, new URL("http://x/api/files/list?prefix=policies/"))!;
  const list = await r.json() as any;
  expect(list.files.map((f: any) => f.path)).toEqual(["policies/a.md"]);
  expect(list.files[0].size).toBe(Buffer.byteLength("# 规则"));
  expect(sql.queries.some((q) => /history/.test(q))).toBe(false);
  expect(sql.queries[0]).toContain("path >= ? AND path < ?");
  r = handleReadFiles(sql, new URL("http://x/api/files/read?path=policies/a.md"))!;
  expect(((await r.json()) as any).content).toBe("# 规则");
  expect(handleReadFiles(sql, new URL("http://x/api/files/read?path=config.toml"))!.status).toBe(403);
  expect(handleReadFiles(sql, new URL("http://x/api/files/list?prefix="))!.status).toBe(403);
  expect(handleReadFiles(sql, new URL("http://x/api/files/read?path=memory/none.md"))!.status).toBe(404);
});

test("directory listings walk live rows only, never the tombstones every task move leaves behind", async () => {
  // 2026-11-26: tasks/inbox/ and tasks/active/ held a tombstone for each of ~11k tasks; the MCP resource list (after
  // every commit) and /api/channels listed them on the primary key and read 6.9M rows in a day, 138% of the free plan.
  const db = new Database(":memory:");
  const plans: string[] = [];
  const sql: FilesSql = {
    exec(q: string, ...raw: any[]) {
      const b = raw.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
      let rows: any[] = [];
      for (const part of q.split(";").map((s) => s.trim()).filter(Boolean)) {
        if (/^SELECT/i.test(part) && /path >= \? AND path < \?/.test(part))
          plans.push((db.query(`EXPLAIN QUERY PLAN ${part}`).all(...b) as { detail: string }[]).map((r) => r.detail).join(" | "));
        const st = db.query(part);
        if (/^SELECT/i.test(part)) rows = st.all(...b) as any[]; else st.run(...b);
      }
      return { toArray: () => rows };
    },
  };
  initFilesSchema(sql);
  const { Mcp } = await import("../cloud/src/mcp");
  const { listTasks } = await import("../cloud/src/tools");
  let rev = 0;
  const row = (path: string, deleted: boolean) => sql.exec("INSERT INTO files (path, content, hash, version, updated, by, deleted, rev) VALUES (?, ?, '', 1, '', 'x', ?, ?)",
    path, deleted ? null : new TextEncoder().encode(`---\nid: ${path.split("/").pop()!.slice(0, -3)}\ntitle: t\n---\n`), deleted ? 1 : 0, ++rev);
  for (let i = 0; i < 300; i++) { row(`tasks/inbox/T-${1000 + i}.md`, true); row(`policies/old-${i}.md`, true); }
  row("tasks/inbox/T-2000.md", false); row("policies/a.md", false);
  const open = listTasks(new Mcp({ sql } as never).store(), "open");
  expect(open.map((t) => t.id)).toEqual(["T-2000"]);
  const list = await handleReadFiles(sql, new URL("http://x/api/files/list?prefix=policies/"))!.json() as { files: { path: string }[] };
  expect(list.files.map((f) => f.path)).toEqual(["policies/a.md"]);
  expect(plans.length).toBeGreaterThan(1);
  for (const p of plans) expect(p).toContain("files_live");
});

test("local server list/read", () => {
  const root = mkdtempSync(join(tmpdir(), "hub-read-"));
  mkdirSync(join(root, "agents/lead"), { recursive: true });
  writeFileSync(join(root, "agents/lead/profile.md"), "hi");
  writeFileSync(join(root, "config.toml"), "secret");
  expect(listDataFiles("agents", root)!.map((f) => f.path)).toEqual(["agents/lead/profile.md"]);
  expect(readDataFile("agents/lead/profile.md", root)!.content).toBe("hi");
  expect(readDataFile("config.toml", root)).toBeNull();
  expect(readDataFile("memory/x.md", root)).toBeUndefined();
  expect(listDataFiles("tasks/", root)).toBeNull();
});
