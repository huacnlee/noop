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
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho called >> '${dir}/calls'\ncat '${dir}/answer'\nexit "$(cat '${dir}/exit-code')"\n`, { mode: 0o755 });
    writeFileSync(join(dir, "exit-code"), "0");
    // Stock macOS has no GNU timeout. Never rely on a host-installed copy.
    writeFileSync(join(bin, "timeout"), "#!/bin/sh\necho timeout unavailable >&2\nexit 127\n", { mode: 0o755 });
    writeFileSync(join(dir, "answer"), "You've hit your 5-hour limit · resets in 2h 13m\n");
    const script = resolve(import.meta.dir, "../scripts/second-review.sh");
    const args = ["sh", script, "T-TEST", repo, "--uncommitted", "--author", "codex"];
    const statePath = join(dir, "home/accounts/state.json");
    writeFileSync(join(dir, "answer"), 'Review mentions quota, 429 and "resets in 2h 13m" but forgot a verdict.\n');
    const malformed = run(args);
    expect(malformed.status).toBe(2);
    expect(malformed.stdout).toContain("reason=parse");
    expect(existsSync(statePath)).toBe(false);
    writeFileSync(join(dir, "exit-code"), "1");
    writeFileSync(join(dir, "answer"), '- [P2] Review quotes usage limit and "resets in 2h 13m" but crashed.\n');
    const crashed = run(args);
    expect(crashed.status).toBe(2);
    expect(crashed.stdout).toContain("reason=error");
    expect(existsSync(statePath)).toBe(false);
    writeFileSync(join(dir, "calls"), "");
    writeFileSync(join(dir, "answer"), "You've hit your 5-hour limit · resets in 2h 13m\n");
    writeFileSync(join(dir, "exit-code"), "1");
    const first = run(args);
    expect(first.status).toBe(2);
    expect(first.stdout).toContain("reason=quota");
    expect(first.stdout).toContain("account_recovery=");
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
    writeFileSync(join(dir, "exit-code"), "0");
    expect(run(args).status).toBe(0);
    expect(readFileSync(join(data, "reports/T-TEST-second-review.md"), "utf8")).toContain("## Round 1");
    expect(existsSync(join(data, "tasks"))).toBe(false); // no duplicate waiting tasks
    // A custom CLI config directory remains usable, with a separate stable machine-local key.
    env.CLAUDE_CONFIG_DIR = join(dir, "custom-claude");
    expect(run(args.map(a => a === "T-TEST" ? "T-CUSTOM" : a)).status).toBe(0);
    writeFileSync(join(dir, "answer"), "usage limit; resets in 13m\n");
    writeFileSync(join(dir, "exit-code"), "1");
    expect(run(args.map(a => a === "T-TEST" ? "T-CUSTOM" : a)).stdout).toContain("reason=quota");
    expect(Object.keys(JSON.parse(readFileSync(statePath, "utf8")).accounts).some(k => /^claude-env-[a-f0-9]{16}$/.test(k))).toBe(true);
    const beforeRecord = readFileSync(statePath, "utf8");
    const invalidRecord = spawnSync("bun", [bridge, "record", "claude"], { cwd: repo, env, input: "ordinary failure", encoding: "utf8" });
    expect(invalidRecord.status).toBe(2);
    expect(readFileSync(statePath, "utf8")).toBe(beforeRecord);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);


test("concurrent quota writers preserve complete state and other account fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "account-writers-"));
  try {
    const accountDir = join(dir, "accounts"); mkdirSync(accountDir);
    const statePath = join(accountDir, "state.json");
    writeFileSync(statePath, JSON.stringify({ accounts: { "claude-shared": { needs_login: true, token: "fixture-value" } }, seq: 7 }));
    const source = `import {recordQuota} from ${JSON.stringify(resolve(import.meta.dir, "../src/accounts.ts"))};
      for (let i=0; i<20; i++) recordQuota({cli:"claude", name:process.argv[1], dir:"/nonexistent"}, "usage limit resets in 13m");`;
    const env = { ...process.env, NOOP_HOME: dir, HUB_DATA: join(dir, "data"), HUB_SYNC: "local" };
    const children = ["shared", "one", "two", "three"].map(name => Bun.spawn(["bun", "-e", source, name], { env, stdout: "ignore", stderr: "pipe" }));
    let running = true;
    const reader = (async () => {
      while (running) { JSON.parse(readFileSync(statePath, "utf8")); await Bun.sleep(1); }
    })();
    try { expect(await Promise.all(children.map(p => p.exited))).toEqual([0, 0, 0, 0]); }
    finally { running = false; await reader; }
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(Object.keys(state.accounts)).toHaveLength(4);
    expect(state.accounts["claude-shared"].needs_login).toBe(true);
    expect(state.accounts["claude-shared"].token).toBe("fixture-value");
    expect(state.seq).toBe(7);
    const killed = spawnSync("bun", ["-e", `import { Database } from "bun:sqlite";
      const db = new Database(${JSON.stringify(join(accountDir, "state-lock.sqlite"))});
      db.exec("BEGIN IMMEDIATE"); console.log("locked"); while (true) Bun.sleepSync(1000);`],
      { env, encoding: "utf8", timeout: 1000, killSignal: "SIGKILL" });
    expect(killed.stdout).toContain("locked");
    expect(killed.signal).toBe("SIGKILL");
    const recovered = spawnSync("bun", ["-e", source, "after-crash"], { env, encoding: "utf8", timeout: 10_000 });
    expect(recovered.status).toBe(0);
    expect(JSON.parse(readFileSync(statePath, "utf8")).accounts["claude-after-crash"].cooldown_until).toBeDefined();
    expect(existsSync(join(accountDir, "state.lock"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
