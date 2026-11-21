// Torn-write protection for the hub mirror.
// A machine that loses power (or is killed) while a file is being written can come back with the file at its new length
// but zero-filled (NTFS commits the size before the data). Left alone, sync would push that file as an ordinary edit and
// overwrite the good copy in the Worker AND in sync-base. This module
//   isDamaged()      recognises such files (all NUL bytes, or a long run of them) so sync can skip them,
//   writeFileDurable() writes + fsyncs, so the files sync itself writes survive the next power loss,
//   recoverMemory()  restores damaged memory files from the newest good copy (sync-base, then daily snapshots),
//   snapshotMemory() keeps one copy of the memory files per day OUTSIDE the data folder (never synced to the cloud).
// It must not import sync.ts (sync.ts imports it).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/** Only text formats are checked: a binary file (png, sqlite, ...) may legitimately contain NUL bytes. */
const TEXT = /\.(md|json|jsonl|toml|txt|csv|ya?ml)$/i;
/** Text never holds this many NULs in a row; a torn write leaves whole blocks (512 bytes and up) zeroed. */
export const NUL_RUN = 64;

/** True when `data` is a zero-filled (or partly zero-filled) text file. Empty files are fine. */
export function isDamaged(rel: string, data: Uint8Array): boolean {
  if (!data.length || !TEXT.test(rel)) return false;
  const b = Buffer.from(data.buffer, data.byteOffset, data.length);
  for (let at = b.indexOf(0); at !== -1; ) {
    let end = at;
    while (end < b.length && b[end] === 0) end++;
    if (end - at >= NUL_RUN || end - at === b.length) return true;
    at = b.indexOf(0, end);
  }
  return false;
}
export const nulCount = (data: Uint8Array) => { let n = 0; for (let i = data.indexOf(0); i !== -1; i = data.indexOf(0, i + 1)) n++; return n; };

/** Write and flush to disk. Rename-after-write alone is not enough: the rename can reach the disk before the data does. */
export function writeFileDurable(abs: string, data: Uint8Array | string) {
  const fd = openSync(abs, "w");
  try { writeSync(fd, typeof data === "string" ? Buffer.from(data) : data); fsyncSync(fd); } finally { closeSync(fd); }
}
function replaceDurable(abs: string, data: Uint8Array) {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.recover-${process.pid}.tmp`; // ".tmp" files are never synced
  writeFileDurable(tmp, data);
  renameSync(tmp, abs);
}

// ------------------------------------------------------------------ memory files
/** The files agents learn from: memory/** and agents/<id>/memory.md. */
export const isMemoryPath = (rel: string) => rel.startsWith("memory/") || /^agents\/[^/]+\/memory\.md$/.test(rel);

function listMemory(dataDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (e.isFile() && isMemoryPath(r) && !/\.tmp$/.test(e.name)) out.push(r);
    }
  };
  walk(join(dataDir, "memory"), "memory");
  if (existsSync(join(dataDir, "agents"))) {
    for (const a of readdirSync(join(dataDir, "agents"), { withFileTypes: true }))
      if (a.isDirectory() && existsSync(join(dataDir, "agents", a.name, "memory.md"))) out.push(`agents/${a.name}/memory.md`);
  }
  return out.sort();
}
const readBytes = (p: string): Uint8Array | null => { try { return new Uint8Array(readFileSync(p)); } catch { return null; } };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Snapshot days, newest first. */
function snapshotDays(snapDir: string): string[] {
  try { return readdirSync(snapDir).filter((d) => DAY.test(d)).sort().reverse(); } catch { return []; }
}

export type Restored = { path: string; from: string; bytes: number };
export type Unrecovered = { path: string; bytes: number; nul: number };

/** Restore damaged memory files (all of them, or just `only`) from the newest good copy: sync-base (the last content that
 *  was synced) first, then the daily snapshots. Anything written after that copy is lost; a file with no good copy stays put. */
export function recoverMemory(dataDir: string, baseDir: string, snapDir: string, only?: string[]): { restored: Restored[]; unrecovered: Unrecovered[] } {
  const restored: Restored[] = [], unrecovered: Unrecovered[] = [];
  for (const rel of only ? only.filter(isMemoryPath) : listMemory(dataDir)) {
    const cur = readBytes(join(dataDir, rel));
    if (!cur || !isDamaged(rel, cur)) continue;
    const candidates: [string, string][] = [["sync-base", join(baseDir, rel)], ...snapshotDays(snapDir).map((d): [string, string] => [`snapshot ${d}`, join(snapDir, d, rel)])];
    let done = false;
    for (const [from, p] of candidates) {
      const good = readBytes(p);
      if (!good || !good.length || isDamaged(rel, good)) continue;
      replaceDurable(join(dataDir, rel), good);
      restored.push({ path: rel, from, bytes: good.length });
      done = true;
      break;
    }
    if (!done) unrecovered.push({ path: rel, bytes: cur.length, nul: nulCount(cur) });
  }
  return { restored, unrecovered };
}

/** Copy the memory files into <snapDir>/<day>/ once per day (a damaged file is never copied) and keep the newest `keep` days. */
export function snapshotMemory(dataDir: string, snapDir: string, day: string, keep = 14): { taken: boolean; files: number; skipped: string[] } {
  const target = join(snapDir, day);
  if (existsSync(target)) return { taken: false, files: 0, skipped: [] };
  const tmp = join(snapDir, `.tmp-${day}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  let files = 0;
  const skipped: string[] = [];
  for (const rel of listMemory(dataDir)) {
    const b = readBytes(join(dataDir, rel));
    if (!b || isDamaged(rel, b)) { skipped.push(rel); continue; }
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    writeFileDurable(join(tmp, rel), b);
    files++;
  }
  mkdirSync(tmp, { recursive: true });
  renameSync(tmp, target);
  for (const d of snapshotDays(snapDir).slice(keep)) rmSync(join(snapDir, d), { recursive: true, force: true });
  return { taken: true, files, skipped };
}
