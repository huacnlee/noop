import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("review quota shares state, skips calls during cooldown, and resumes without using rounds", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-recovery-"));
  try {
    const data = join(dir, "data"), repo = join(dir, "repo"), bin = join(dir, "bin");
    for (const d of [data, repo, bin, join(data, "reports")]) mkdirSync(d, { recursive: true });
    const env = { ...process.env, NOOP_HOME: join(dir, "home"), HUB_DATA: data, HUB_SYNC: "local",
      PATH: `${bin}:${process.env.PATH}`, NOOP_REVIEW_CODE_DIR: resolve(import.meta.dir, "../src"),
      CODEX_THREAD_ID: "fixture", CLAUDECODE: "", CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", NOOP_SECOND_REVIEW: "1" };
    const run = (cmd: string[], cwd = repo) => spawnSync(cmd[0], cmd.slice(1), { cwd, env, encoding: "utf8", timeout: 20_000 });
    run(["git", "init", "-q"]);
    writeFileSync(join(repo, "a"), "fixture\n"); run(["git", "add", "a"]);
    expect(run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]).status).toBe(0);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho called >> '${dir}/calls'\ncat '${dir}/answer'\n`, { mode: 0o755 });
    writeFileSync(join(dir, "answer"), "You've hit your 5-hour limit · resets in 2h 13m\n");
    const script = resolve(import.meta.dir, "../scripts/second-review.sh");
    const args = ["sh", script, "T-TEST", repo, "--uncommitted", "--author", "codex"];
    const first = run(args);
    expect(first.status).toBe(2);
    expect(first.stdout).toContain("account_recovery=");
    const statePath = join(dir, "home/accounts/state.json");
    const stateText = readFileSync(statePath, "utf8"), state = JSON.parse(stateText);
    expect(Date.parse(state.accounts["claude-default"].cooldown_until)).toBeGreaterThan(Date.now() + 2 * 3600_000);
    // Another task uses the same machine-local account and does not call the reviewer again.
    const second = run(args.map(a => a === "T-TEST" ? "T-OTHER" : a));
    expect(second.status).toBe(2); expect(second.stdout).toContain("reviewer not called");
    expect(readFileSync(join(dir, "calls"), "utf8")).toBe("called\n");
    expect(readFileSync(statePath, "utf8")).toBe(stateText);
    const bridge = join(env.NOOP_REVIEW_CODE_DIR, "review-account.ts");
    expect(run(["bun", bridge, "check", "claude"]).status).toBe(1);
    expect(readFileSync(statePath, "utf8")).toBe(stateText); // wait_check is read-only
    state.accounts["claude-default"].cooldown_until = "2000-01-01T00:00:00Z";
    writeFileSync(statePath, JSON.stringify(state));
    expect(run(["bun", bridge, "check", "claude"]).status).toBe(0);
    writeFileSync(join(dir, "answer"), "No actionable findings.\nVERDICT: CLEAN\n");
    expect(run(args).status).toBe(0);
    expect(readFileSync(join(data, "reports/T-TEST-second-review.md"), "utf8")).toContain("## Round 1");
    expect(existsSync(join(data, "tasks"))).toBe(false); // no duplicate waiting tasks
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
