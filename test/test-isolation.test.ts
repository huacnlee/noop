import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("absolute-path tests outside the repo fail before importing live hub state", () => {
  const dir = mkdtempSync(join(tmpdir(), "noop-isolation-check-"));
  try {
    for (const entry of ["core", "sync"]) {
      const file = join(dir, `${entry}.test.ts`);
      writeFileSync(file, `import ${JSON.stringify(resolve(import.meta.dir, `../src/${entry}.ts`))};\n`);
      const env = { ...process.env };
      delete env.NODE_ENV;
      // Do not inherit the parent's isolated paths: reproduce an unconfigured invocation.
      delete env.NOOP_HOME;
      delete env.HUB_DATA;
      delete env.HUB_SYNC;
      const child = Bun.spawnSync([process.execPath, "test", file], { cwd: dir, env });
      expect(child.exitCode).not.toBe(0);
      expect(child.stderr.toString()).toContain("Noop tests require test/preload.ts");
      const safe = Bun.spawnSync([process.execPath, "test", "--preload", resolve(import.meta.dir, "preload.ts"), file], { cwd: dir, env });
      expect(safe.exitCode).toBe(0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
