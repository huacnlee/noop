import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("[env] in config.local.toml fills missing process env without overriding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noop-env-"));
  writeFileSync(join(dir, "config.local.toml"), `[env]\nNOOP_TEST_ENV_A = "from-config"\nNOOP_TEST_ENV_B = "from-config"\n`);
  const proc = Bun.spawnSync(["bun", "-e", `
    process.env.NOOP_TEST_ENV_B = "from-shell";
    const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "core.ts"))});
    loadConfig();
    console.log(process.env.NOOP_TEST_ENV_A + "," + process.env.NOOP_TEST_ENV_B);
  `], { env: { ...process.env, HUB_DATA: dir, NOOP_HOME: dir } });
  expect(proc.stdout.toString().trim()).toBe("from-config,from-shell");
});
