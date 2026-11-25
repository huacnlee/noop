import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointFallback, checkpointRecoveryBody, due, recordRunLimit } from "../src/cli";
import { matches, signature, type Cfg } from "../src/core";
import { dirtyPaths } from "../src/setup";
import { RUN_LIMIT, cliCommand, deadlinePrompt, parseResult, runAgent, runLimits, stripImages } from "../src/runner";
import { tooManyWakes } from "../src/waits";

test("dirtyPaths keeps every path intact, including the first line", () => {
  // the first line of `git status --porcelain` for an unstaged edit starts with a space
  expect(dirtyPaths(" M src/accounts.ts\nA  src/new.ts\nR  old.ts -> new.ts\n?? docs/x.md\n")).toEqual([
    "src/accounts.ts", "src/new.ts", "old.ts -> new.ts", "docs/x.md",
  ]);
  expect(dirtyPaths("")).toEqual([]);
});

test("routine schedule", () => {  const t = new Date("2026-11-02T19:05:00"); // Monday
  expect(due("15m", undefined, t)).toBe(true);
  expect(due("15m", new Date(+t - 5 * 60e3).toISOString(), t)).toBe(false);
  expect(due("weekdays 19:00", undefined, t)).toBe(true);
  expect(due("weekdays 19:00", new Date("2026-11-02T19:01:00").toISOString(), t)).toBe(false);
  expect(due("weekly FRI 17:00", undefined, t)).toBe(false);
  expect(due("daily 20:00", undefined, t)).toBe(false);
  expect(due("daily 02:30", undefined, t)).toBe(false); // first run long after slot → wait for next slot
});

test("routine schedule catches up a slot missed while the machine slept", () => {
  // Ran yesterday 19:00, tick at 03:00 before today's slot → nothing due yet.
  expect(due("daily 19:00", "2026-11-17T19:00:00", new Date("2026-11-18T03:00:00"))).toBe(false);
  // Missed yesterday 19:00 entirely (asleep), tick at 03:00 → fire yesterday's slot now.
  expect(due("daily 19:00", "2026-11-16T19:00:00", new Date("2026-11-18T03:00:00"))).toBe(true);
  // Weekday routine missed on Friday fires on Saturday morning.
  expect(due("weekdays 19:00", "2026-11-12T19:00:00", new Date("2026-11-14T10:00:00"))).toBe(true);
  // Weekly Sunday routine missed fires on Monday.
  expect(due("weekly SUN 21:00", "2026-11-08T21:00:00", new Date("2026-11-16T08:00:00"))).toBe(true);
  // ...but not a second time once it has caught up.
  expect(due("daily 19:00", "2026-11-18T03:00:00", new Date("2026-11-18T03:05:00"))).toBe(false);
});

test("capability matching", () => {
  const caps = ["os:linux", "host:pc", "gpu"];
  expect(matches({ requires: "os:linux" }, caps)).toBe(true);
  expect(matches({ requires: "os:macos" }, caps)).toBe(false);
  expect(matches({ host: "pc", requires: "gpu" }, caps)).toBe(true);
  expect(matches({ host: "mbp" }, caps)).toBe(false);
});

test("external signature links the Noop name to its site", () => {
  const cfg = { owner: { github: "huacnlee" } } as Cfg;
  expect(signature("lead", "host", cfg)).toBe(
    "🤖 [Noop](https://huacnlee.github.io/noop) (lead) · AI agent acting for @huacnlee",
  );
});

test("external signature never mentions the template's placeholder login", () => {
  const tail = (github?: string) => signature("lead", "host", { owner: { github } } as Cfg).split(" · ")[1];
  expect(tail("your-github")).toBe("AI agent acting for its owner");
  expect(tail(undefined)).toBe("AI agent acting for its owner");
  expect(tail("")).toBe("AI agent acting for its owner");
  expect(tail("@huacnlee")).toBe("AI agent acting for @huacnlee");
});

test("result parsing", () => {
  expect(parseResult('blah\n```json\n{"status":"done","summary":"ok"}\n```').status).toBe("done");
  expect(parseResult("no block").status).toBe("failed");
  expect(parseResult('```json\n{"status":"done","followups":[{"title":"A"},{"title":"B"}]}\n```').summary).toBe("Dispatched 2: A; B");
  expect(parseResult('```json\n{"status":"done"}\n```').summary).toBe("(done, no summary)");
  // codex sometimes ends its reply with a bare JSON object instead of a fenced ```json block
  expect(parseResult('{"status":"done","summary":"ok"}').status).toBe("done");
});

test("result parsing keeps a lone backslash such as a Windows drive path", () => {
  const out = '```json\n{"status":"done","summary":"can\'t reach D:\\、USB drives"}\n```';
  expect(parseResult(out)).toMatchObject({ status: "done", summary: "can't reach D:\\、USB drives" });
});

test("result parsing drops a stray bare word between members", () => {
  // a real run (T-2208, 2026-11-23) finished its work and was re-run because codex wrote this
  const out = '```json\n{\n  "status": "done",\n  "summary": "ok",\n tml "channels": ["c"]\n}\n```';
  expect(parseResult(out)).toMatchObject({ status: "done", summary: "ok", channels: ["c"] });
  // literals and exponents survive the repair
  expect(parseResult('```json\n{"status":"done","summary":"ok",x "n":1e3,"b":true,"z":null}\n```')).toMatchObject({ n: 1000, b: true, z: null });
});

test("result parsing repairs a raw line break inside a JSON string", () => {
  const out = '```json\n{"status":"delegated","summary":"ok","followups":[{"title":"x","body":"line one\n","agent":"a"}]}\n```';
  expect(parseResult(out)).toMatchObject({ status: "delegated", followups: [{ title: "x", body: "line one\n", agent: "a" }] });
});

test("long runs reserve a checkpoint window before the hard limit", () => {
  const limits = runLimits({ clis: { timeout_minutes: 90 } } as Cfg, 0);
  expect(limits).toEqual({
    totalMinutes: 90,
    workMinutes: 80,
    checkpointMinutes: 10,
    checkpointAt: "1970-01-01T01:20:00.000Z",
    hardAt: "1970-01-01T01:30:00.000Z",
  });
  expect(runLimits({ clis: { timeout_minutes: 90, checkpoint_minutes: 15 } } as Cfg, 0).workMinutes).toBe(75);
  expect(runLimits({ clis: { timeout_minutes: 29 } } as Cfg, 0).checkpointMinutes).toBe(0);
  expect(runLimits({ clis: { timeout_minutes: 15, checkpoint_minutes: 5 } } as Cfg, 0).workMinutes).toBe(10);
  expect(runLimits({ clis: { timeout_minutes: 90, checkpoint_minutes: 0 } } as Cfg, 0).checkpointMinutes).toBe(0);
});

test("every task prompt states the checkpoint and hard deadlines", () => {
  const cfg = { clis: { timeout_minutes: 90 }, owner: { name: "owner" } } as Cfg;
  const prompt = deadlinePrompt(runLimits(cfg, 0));
  expect(prompt).toContain("90-minute hard limit");
  expect(prompt).toContain("1970-01-01T01:20:00.000Z");
  expect(prompt).toContain("1970-01-01T01:30:00.000Z");
  expect(prompt).toContain("return `waiting` with a quick read-only `wait_check`");
});

test("checkpoint fallback parks with an executable time-based wait_check", () => {
  expect(checkpointFallback("T-1", "/tmp/run.log", 300_000)).toMatchObject({
    status: "waiting",
    wait_kind: "ci",
    wait_minutes: 5,
    wait_check: 'test "$(date +%s)" -ge 300',
  });
});

test("work-limit resumes use a separate counter with the MAX_WAKES safety cap", () => {
  const meta: Record<string, string> = {};
  for (let hit = 1; hit <= 6; hit++) expect(tooManyWakes(recordRunLimit(meta))).toBe(false);
  expect(tooManyWakes(recordRunLimit(meta))).toBe(true);
  expect(meta.run_limits).toBe("7");
});

test("result parsing repairs a bare double quote inside a JSON string", () => {
  // a real run (T-0016, 2026-11-16) was requeued and re-run because of this one line
  const out = '```json\n{"status":"done","summary":"ok","lessons":["旧的两条"压到一条绑 2FA"仍在和新结论打架。"]}\n```';
  expect(parseResult(out)).toMatchObject({ status: "done", lessons: ['旧的两条"压到一条绑 2FA"仍在和新结论打架。'] });
  // escaped quotes and nested objects must keep parsing as before
  const ok = '```json\n{"status":"done","summary":"say \\"hi\\"","followups":[{"title":"x"}]}\n```';
  expect(parseResult(ok)).toMatchObject({ status: "done", summary: 'say "hi"', followups: [{ title: "x" }] });
});

test("owner image uploads: images only, 10 MB, attachments are the hub's own media", async () => {
  const { uploadProblem, ownerAttachments, MAX_UPLOAD } = await import("../cloud/src/uploads");
  expect(uploadProblem("image/png", 1000)).toBeNull();
  expect(uploadProblem("image/svg+xml", 1000)?.status).toBe(415);
  expect(uploadProblem("application/pdf", 1000)?.status).toBe(415);
  expect(uploadProblem("image/jpeg", MAX_UPLOAD + 1)?.status).toBe(413);
  expect(ownerAttachments(undefined)).toEqual([]);
  expect(ownerAttachments(["/media/1-a.png"])).toEqual(["/media/1-a.png"]);
  expect(ownerAttachments(["https://evil.example/x.png"])).toBeNull();
  expect(ownerAttachments(["/media/../noop.toml"])).toBeNull();
  expect(ownerAttachments(Array(11).fill("/media/a.png"))).toBeNull();
});

test("owner images are downloaded and named by absolute path in the task text", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveAttachments, withAttachments } = await import("../src/server");
  const root = mkdtempSync(join(tmpdir(), "noop-att-"));
  const got: string[] = [];
  const files = await saveAttachments("ev-1", ["/media/1-shot.png", "/media/2-gone.png"], async (p) => {
    got.push(p);
    return p.includes("gone") ? null : new Uint8Array([1, 2, 3]);
  }, root);
  expect(got).toEqual(["/media/1-shot.png", "/media/2-gone.png"]);
  expect(files).toEqual([join(root, "ev-1", "1-shot.png")]);
  expect([...readFileSync(files[0])]).toEqual([1, 2, 3]);
  const text = withAttachments("看这个报错", files, 1);
  expect(text.startsWith("看这个报错\n\nAttached images")).toBe(true);
  expect(text).toContain(`- ${files[0]}`);
  expect(text).toContain("1 more image(s) could not be downloaded");
  expect(withAttachments("", files).split("\n")[0]).toBe("(see the attached images)");
  expect(withAttachments("plain", [])).toBe("plain");
  rmSync(root, { recursive: true, force: true });
});

test("media older than media_days is pruned", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pruneMedia, mediaDays } = await import("../src/server");
  expect(mediaDays({} as any)).toBe(7);
  expect(mediaDays({ media_days: 30 } as any)).toBe(30);
  expect(mediaDays({ media_days: 5 } as any)).toBe(7);
  const media = mkdtempSync(join(tmpdir(), "noop-media-"));
  const att = mkdtempSync(join(tmpdir(), "noop-att-"));
  const now = Date.now();
  const age = (f: string, days: number) => utimesSync(f, (now - days * 86_400_000) / 1000, (now - days * 86_400_000) / 1000);
  writeFileSync(join(media, "old.png"), "x"); age(join(media, "old.png"), 8);
  writeFileSync(join(media, "new.png"), "x"); age(join(media, "new.png"), 6);
  mkdirSync(join(att, "ev-old")); writeFileSync(join(att, "ev-old", "a.png"), "x"); age(join(att, "ev-old"), 10);
  expect(pruneMedia(7, [media, att, join(media, "missing")], now)).toBe(2);
  expect(existsSync(join(media, "old.png"))).toBe(false);
  expect(existsSync(join(media, "new.png"))).toBe(true);
  expect(existsSync(join(att, "ev-old"))).toBe(false);
  rmSync(media, { recursive: true, force: true }); rmSync(att, { recursive: true, force: true });
});

test("repo language → host requirements (only when the repo is on disk)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { capOk, repoRequires } = await import("../src/core");
  const rust = mkdtempSync(join(tmpdir(), "noop-rust-"));
  writeFileSync(join(rust, "Cargo.toml"), "[package]\n");
  const js = mkdtempSync(join(tmpdir(), "noop-js-"));
  writeFileSync(join(js, "package.json"), "{}");
  expect(repoRequires(rust)).toEqual(["cli:cargo"]);
  expect(repoRequires("/nonexistent/repo/xyz")).toEqual([]);
  const mac = ["os:macos", "host:mbp", "cli:claude", "cli:node"];
  expect(matches({ repo: rust }, mac)).toBe(false); // the Mac without cargo must not claim a Rust task
  expect(matches({ repo: rust }, [...mac, "cli:cargo"])).toBe(true);
  expect(matches({ repo: js }, mac)).toBe(true); // node is enough for package.json
  expect(matches({ repo: js }, ["os:linux"])).toBe(false);
  expect(capOk("cli:bun|cli:node", ["cli:bun"])).toBe(true);
  expect(matches({ repo: "/nonexistent/repo/xyz", requires: "cli:cargo" }, mac)).toBe(false); // stored at creation
});

test("quota/auth failover: same CLI's other account, then the other CLI, else nothing", async () => {
  const { failoverAccount } = await import("../src/accounts");
  const all = () => true;
  const a = { cli: "claude", name: "zz-test-a", dir: "" };
  const two = { accounts: [{ cli: "claude", name: "zz-test-a" }, { cli: "claude", name: "zz-test-b" }] } as any;
  expect(failoverAccount(two, a, ["claude"], all)?.name).toBe("zz-test-b");
  const solo = { accounts: [{ cli: "claude", name: "zz-test-a" }, { cli: "codex", name: "zz-test-c" }] } as any;
  expect(failoverAccount(solo, a, ["claude"], all)?.cli).toBe("codex"); // claude-only (owner/hard) work still falls back
  expect(failoverAccount(solo, a, ["claude"], (c) => c === "claude")).toBeNull(); // codex not installed → requeue
  expect(failoverAccount(solo, { cli: "codex", name: "zz-test-c", dir: "" }, ["codex", "claude"], all)?.cli).toBe("claude");
});

test("classify: OpenAI 'no credits remaining' is a quota wall, so codex work falls back", async () => {
  const { classify } = await import("../src/accounts");
  expect(classify("ERROR: stream disconnected before completion: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.")).toBe("quota");
  expect(classify("Credit balance is too low")).toBe("quota");
  expect(classify("exit 1: task failed")).toBeNull();
});

test("restart throttle: at most one voluntary restart per hour unless forced", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { restartAllowed } = await import("../src/cli");
  const f = join(mkdtempSync(join(tmpdir(), "noop-rs-")), "last-restart");
  expect(restartAllowed(false, f)).toBe(true); // never restarted
  const t = Date.parse("2026-11-02T17:00:00Z");
  writeFileSync(f, "2026-11-02T16:30:00Z");
  expect(restartAllowed(false, f, t)).toBe(false);
  expect(restartAllowed(true, f, t)).toBe(true);
  expect(restartAllowed(false, f, t + 31 * 60_000)).toBe(true);
});

test("selfUpdate defers while tasks run on this host", async () => {
  const { selfUpdate } = await import("../src/setup");
  expect(await selfUpdate({ busy: 2 })).toBe(false);
});

test("a blocked self-update is reported once per distinct state", async () => {
  const { join } = await import("node:path");
  const { updateBlocked } = await import("../src/setup");
  const f = join(mkdtempSync(join(tmpdir(), "noop-blocked-")), "update-blocked");
  const dirty = "local edits: src/accounts.ts (HEAD aaaa, origin bbbb)";
  expect(updateBlocked(dirty, f)).toBe(dirty); // first sighting → the caller journals it
  expect(updateBlocked(dirty, f)).toBeNull(); // same state every 30 min → one line, not a flood
  expect(updateBlocked("local edits: src/accounts.ts, src/cli.ts (HEAD aaaa, origin bbbb)", f)).not.toBeNull(); // a new edit is news
});

test("a release whose tests failed here is not installed again until origin moves on", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { updateRejected } = await import("../src/setup");
  const f = join(mkdtempSync(join(tmpdir(), "noop-up-")), "update-rejected");
  expect(updateRejected("1c6ae5a", f)).toBe(false); // nothing refused yet
  writeFileSync(f, "1c6ae5a\n");
  expect(updateRejected("1c6ae5a", f)).toBe(true); // the same bad release is skipped, no reinstall, no medic
  expect(updateRejected("d23c0de", f)).toBe(false); // a newer release is tried again
});

test("taskView shows the original ask, not daemon requeue notes", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeDoc } = await import("../src/core");
  const { taskView } = await import("../src/server");
  const dir = mkdtempSync(join(tmpdir(), "noop-tv-"));
  const old = join(dir, "T-1.md"); // legacy body: note appended as a quote, no owner quote
  writeDoc(old, { id: "T-1", title: "Fix build" }, "Fix the Rust build on CI.\n\n> Requeued after daemon restart on pc; check for partial work.\n");
  expect(taskView(old, "inbox", []).request).toBe("Fix the Rust build on CI.");
  const chat = join(dir, "T-2.md");
  writeDoc(chat, { id: "T-2", title: "x", requeue_note: "Requeued after daemon restart on pc; check for partial work." },
    "The owner (CEO) said in chat:\n\n> ship the release\n\nHandle it.\n\n> Attempt 1 failed: boom. Try a different approach.\n");
  expect(taskView(chat, "inbox", []).request).toBe("ship the release");
});

test("uploads: the real image type comes from the bytes", async () => {
  const { sniffImage } = await import("../cloud/src/uploads");
  expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "application/octet-stream")).toBe("image/jpeg");
  expect(sniffImage(new TextEncoder().encode("\0\0\0\x18ftypheic"), "")).toBe("image/heic");
  expect(sniffImage(new Uint8Array([1, 2, 3]), "image/jpg")).toBe("image/jpeg");
});


test("update the fleet: the owner's request reaches the hook and the feed says how many machines", async () => {
  const { updateFleet, setUpdateFleet, setMirror } = await import("../src/server");
  const seen: string[] = [];
  setMirror((e) => { seen.push(e.text); });
  expect(await updateFleet()).toBe("not available");
  setUpdateFleet(async () => 3);
  expect(await updateFleet()).toBe("ok");
  expect(seen.at(-1)).toContain("已通知 3 台机器");
  setMirror(() => {});
});

test("heartbeat carries the running code version, linked to its commit", async () => {
  const { runningRev } = await import("../src/core");
  const r = runningRev();
  expect(r.rev).toMatch(/^[0-9a-f]{40}$/);
  if (r.rev_url) expect(r.rev_url).toEndWith(`/commit/${r.rev}`);
});

test("heartbeat reports the LAN address, skipping tunnels, containers and VPNs", async () => {
  const { lanAddress } = await import("../src/core");
  const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal });
  // the owner's Mac mini: a proxy TUN (198.18.x) next to the wired port
  expect(lanAddress({ lo0: [v4("127.0.0.1", true)], en0: [{ address: "fe80::1", family: "IPv6", internal: false }, v4("10.20.94.156")], utun4: [v4("198.18.0.1")] })).toBe("10.20.94.156");
  // a Linux box with Docker and Tailscale: the Wi-Fi address wins
  expect(lanAddress({ docker0: [v4("172.17.0.1")], "br-1a2b": [v4("172.18.0.1")], tailscale0: [v4("100.101.1.2")], wlan0: [v4("192.168.1.23")] })).toBe("192.168.1.23");
  // Windows names its adapters; the WSL switch is virtual
  expect(lanAddress({ "vEthernet (WSL)": [v4("172.24.0.1")], Ethernet: [v4("172.20.3.4")] })).toBe("172.20.3.4");
  // nothing private on a physical adapter: report nothing rather than a wrong address
  expect(lanAddress({ en0: [v4("169.254.3.4"), v4("203.0.113.9")], utun2: [v4("10.8.0.2")] })).toBeUndefined();
  expect(lanAddress({})).toBeUndefined();
});

test("recentChat: the channel before an owner message, without the message itself", async () => {
  const { appendEvent, recentChat } = await import("../src/server");
  appendEvent({ from: "Kai", kind: "notice", text: "已补写 gpui-kit v0.9.0 的更新日志", ref: "T-0115" });
  appendEvent({ from: "owner", kind: "owner", text: "不行，得留下贡献者名单" });
  appendEvent({ from: "hub", kind: "system", text: "收到，接着 T-0115 处理（T-0116）", ref: "T-0116" });
  appendEvent({ from: "owner", kind: "owner", text: "这个细节记录下来，以后都这样" });
  const lines = recentChat("这个细节记录下来，以后都这样");
  expect(lines.slice(-3).map((l) => l.slice(8))).toEqual(["Kai (T-0115): 已补写 gpui-kit v0.9.0 的更新日志", "owner: 不行，得留下贡献者名单", "hub (T-0116): 收到，接着 T-0115 处理（T-0116）"]);
  expect(recentChat("x", { limit: 1 }).length).toBe(1);
});

test("pickTask: a task no machine here can run (needs another OS) never holds back the ones behind it", async () => {
  const { pickTask, writeDoc, P } = await import("../src/core");
  const other = process.platform === "win32" ? "os:linux" : "os:windows";
  const at = new Date(Date.now() - 3600_000).toISOString();
  writeDoc(P("tasks", "inbox", "T-9001.md"), { id: "T-9001", title: "needs another OS", agent: "lead", requires: other, priority: "urgent", planned: at, created: at, parked: at }, "x");
  writeDoc(P("tasks", "inbox", "T-9002.md"), { id: "T-9002", title: "runs anywhere", agent: "lead", priority: "normal", planned: at, created: at }, "y");
  const cfg = { clis: { default: ["claude", "codex"] } } as any;
  const picked = pickTask(cfg);
  if (picked === null && !Bun.which("claude") && !Bun.which("codex")) return; // no AI CLI here: nothing is pickable
  expect(picked).toContain("T-9002");
});

test("pickTask: a heavy task no host has headroom for starts after heavy_wait_minutes, never on a saturated host", async () => {
  const { pickTask, writeDoc, P } = await import("../src/core");
  const cfg = { clis: { default: ["claude", "codex"] } } as any;
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 2 * 3600_000).toISOString();
  // heavyOk=false everywhere here: no host reports heavy headroom (the evolve-deep case: memory under 25%)
  writeDoc(P("tasks", "inbox", "T-9011.md"), { id: "T-9011", title: "heavy, waited 2h", agent: "lead", weight: "heavy", priority: "urgent", planned: now, created: old }, "x");
  writeDoc(P("tasks", "inbox", "T-9013.md"), { id: "T-9013", title: "heavy, just queued", agent: "lead", weight: "heavy", priority: "urgent", planned: now, created: now }, "y");
  if (!Bun.which("claude") && !Bun.which("codex")) return; // no AI CLI here: nothing is pickable
  expect(pickTask(cfg, 0.2, false)).toContain("T-9011"); // waited long enough: the gate lapses, the fresh copy still waits
  expect(pickTask(cfg, 0.95, false) ?? "").not.toContain("T-9011"); // saturated host: still no heavy work
  rmSync(P("tasks", "inbox", "T-9011.md"));
  expect(pickTask(cfg, 0.2, false) ?? "").not.toContain("T-9013");
  rmSync(P("tasks", "inbox", "T-9013.md"));
});

test("a reply to an agent's message goes to the brain with that task, never as an amendment of the last decision", async () => {
  const { handleOwnerMessage, setOwnerTask, pendingInbound, ackInbound } = await import("../src/server");
  const calls: [string, { reply?: string; answered?: string }][] = [];
  setOwnerTask(async (text, o) => { calls.push([text, { reply: o.reply, answered: o.answered }]); });
  await handleOwnerMessage("D-0001 A"); // just answered a decision: the brain hears it may be amended
  await handleOwnerMessage("为何我看图片不清晰呢", "T-0125"); // a reply names its task: never an amendment
  expect(calls).toEqual([["为何我看图片不清晰呢", { reply: "T-0125", answered: undefined }]]);
  await handleOwnerMessage("等等，选 B");
  expect(calls.at(-1)).toEqual(["等等，选 B", { reply: undefined, answered: "D-0001" }]);
  expect(pendingInbound()).toEqual([{ id: "D-0001", answer: "A", source: "chat" }]);
  ackInbound(1);
});

test("an answer in words to a proposals card goes to the brain; numbers, all and none go straight to the card", async () => {
  const { handleOwnerMessage, setOwnerTask, pendingInbound, ackInbound } = await import("../src/server");
  const calls: string[] = [];
  setOwnerTask(async (text) => { calls.push(text); });
  await handleOwnerMessage("只做文档那项，另一个先不做", "P-0005");
  await handleOwnerMessage("P-0006 1、不做 2、做");
  await handleOwnerMessage("1，3", "P-0008");
  await handleOwnerMessage("P-0009 all");
  expect(calls).toEqual(["P-0005 只做文档那项，另一个先不做", "P-0006 1、不做 2、做"]);
  expect(pendingInbound()).toEqual([{ id: "P-0008", answer: "1，3", source: "chat" }, { id: "P-0009", answer: "all", source: "chat" }]);
  ackInbound(2);
});

test("a result block survives a later turn from a background task notification", async () => {
  const lines = [
    { type: "result", result: "still compiling" },
    { type: "result", result: '```json\n{"status":"done","summary":"tested"}\n```' },
    { type: "result", result: "that notification changes nothing" },
  ].map((l) => JSON.stringify(l)).join("\n");
  const cfg = { clis: { fake: { command: ["sh", "-c", 'printf "%s\\n" "$1"', "stream-json", lines] } } } as unknown as Cfg;
  const log = `${tmpdir()}/noop-run-${process.pid}.log`;
  const res = parseResult(await runAgent("fake", "", tmpdir(), cfg, log));
  rmSync(log, { force: true });
  expect(res).toMatchObject({ status: "done", summary: "tested" });
});

test("run logs keep screenshot events but not their base64 payloads", () => {
  const png = "iVBORw0KGgo".repeat(400);
  const event = {
    type: "user",
    message: { role: "user", content: [{ tool_use_id: "t1", type: "tool_result",
      content: [{ type: "image", source: { type: "base64", data: png, media_type: "image/png" } }] }] },
    parent_tool_use_id: null,
    tool_use_result: { type: "image", file: { base64: png, type: "image/png", originalSize: 3300 } },
  };
  const out = stripImages(JSON.stringify(event));
  expect(out).not.toContain(png);
  const e = JSON.parse(out);
  expect(e.message.content[0].content[0].source).toEqual({ type: "base64", data: "[image/png, 3300 bytes omitted]", media_type: "image/png" });
  expect(e.tool_use_result.file).toEqual({ base64: "[image/png, 3300 bytes omitted]", type: "image/png", originalSize: 3300 });
  const text = '{"type":"assistant","message":{"content":[{"type":"text","text":"base64","note":"caf\\u00e9"}]}}'; // parsed, no image: kept byte for byte
  expect(stripImages(text)).toBe(text);
  const broken = '{"type":"user","source":{"type":"base64","data":"iVBOR';
  expect(stripImages(broken)).toBe(broken);
  expect(stripImages("plain codex output")).toBe("plain codex output");
});

test("a run log exists and grows while the agent runs, and has the usual layout at exit", async () => {
  const dir = mkdtempSync(`${tmpdir()}/noop-live-log-`);
  const go = `${dir}/go`;
  const first = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  const last = JSON.stringify({ type: "result", result: '```json\n{"status":"done","summary":"ok"}\n```' });
  // prints one line, then waits for the test to release it before printing the result
  const script = `const fs = require("node:fs");`
    + `process.stdout.write(${JSON.stringify(`${first}\n`)});`
    + `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) { clearInterval(t);`
    + `process.stdout.write(${JSON.stringify(`${last}\n`)}); process.stderr.write("warn"); } }, 20);`;
  const cfg = { clis: { fake: { command: [process.execPath, "-e", script, "stream-json"] } } } as unknown as Cfg;
  const log = `${dir}/run.log`;
  try {
    const run = runAgent("fake", "prompt", dir, cfg, log);
    let mid = "";
    for (let i = 0; i < 250 && !mid.endsWith(`${first}\n`); i++) { // the header holds the script, so it contains the text too
      await Bun.sleep(20);
      mid = existsSync(log) ? readFileSync(log, "utf8") : "";
    }
    expect(mid).toBe(`$ ${process.execPath} -e ${script} stream-json\n\n${first}\n`);
    writeFileSync(go, "");
    expect(parseResult(await run)).toMatchObject({ status: "done", summary: "ok" });
    expect(readFileSync(log, "utf8")).toBe(`$ ${process.execPath} -e ${script} stream-json\n(exit 0)\n\n${first}\n${last}\n\n\n[stderr]\nwarn`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("an empty completion (no text, no tool call, exit 0) is retried once instead of failing the task", async () => {
  // The provider sometimes answers with nothing at all and the CLI still exits 0; Claude Code's own
  // "no visible output" retry gets nothing either. runAgent must not hand that back as the task's result.
  const dir = mkdtempSync(`${tmpdir()}/noop-empty-`);
  const mark = `${dir}/ran`;
  const block = JSON.stringify({ type: "result", result: '```json\n{"status":"done","summary":"second try"}\n```' });
  // first spawn: no output at all; second one: the normal result line (a marker file carries the state)
  const script = `const fs = require("node:fs");`
    + `if (fs.existsSync(${JSON.stringify(mark)})) process.stdout.write(${JSON.stringify(`${block}\n`)});`
    + `else fs.writeFileSync(${JSON.stringify(mark)}, "");`;
  const cfg = { clis: { fake: { command: [process.execPath, "-e", script, "stream-json"] } } } as unknown as Cfg;
  const log = `${dir}/run.log`;
  try {
    const res = parseResult(await runAgent("fake", "prompt", dir, cfg, log));
    expect(res).toMatchObject({ status: "done", summary: "second try" });
    expect(readFileSync(log, "utf8")).toContain("[retried after an empty response]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("a run that never reached the API is retried once instead of failing the task", async () => {
  // A DNS or connection blip makes the CLI exit non-zero after burning no tokens and touching nothing; without a
  // rerun one blip ends every task running at that moment with no result and wakes the medic.
  const dir = mkdtempSync(`${tmpdir()}/noop-unreachable-`);
  const mark = `${dir}/ran`;
  const down = JSON.stringify({ type: "result", is_error: true, api_error: "connection_failed",
    result: "API Error: Can't reach the API server \u2014 check your internet or DNS (ENOTFOUND)" });
  const block = JSON.stringify({ type: "result", result: '```json\n{"status":"done","summary":"second try"}\n```' });
  // first spawn: the connection failure and exit 1; second one: the normal result (a marker file carries the state)
  const script = `const fs = require("node:fs");`
    + `if (fs.existsSync(${JSON.stringify(mark)})) process.stdout.write(${JSON.stringify(`${block}\n`)});`
    + `else { fs.writeFileSync(${JSON.stringify(mark)}, ""); process.stdout.write(${JSON.stringify(`${down}\n`)}); process.exit(1); }`;
  const cfg = { clis: { fake: { command: [process.execPath, "-e", script, "stream-json"] } } } as unknown as Cfg;
  const log = `${dir}/run.log`;
  try {
    const res = parseResult(await runAgent("fake", "prompt", dir, cfg, log));
    expect(res).toMatchObject({ status: "done", summary: "second try" });
    expect(readFileSync(log, "utf8")).toContain("[retried after an unreachable API]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("a run stopped by its work limit uses a distinct checkpoint marker", async () => {
  const dir = mkdtempSync(`${tmpdir()}/noop-run-limit-`);
  const script = `setTimeout(() => {}, 5000)`;
  const cfg = { clis: { fake: { command: [process.execPath, "-e", script] }, timeout_minutes: 0.001 } } as unknown as Cfg;
  const log = `${dir}/run.log`;
  try {
    const out = await runAgent("fake", "prompt", dir, cfg, log);
    expect(out).toContain(RUN_LIMIT);
    expect(out).not.toContain("[stalled]");
    expect(readFileSync(log, "utf8")).toContain("[stderr]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 5_000);

test("a work-limit run hands off to a checkpoint-only run end to end", async () => {
  const dir = mkdtempSync(`${tmpdir()}/noop-checkpoint-e2e-`);
  const script = `let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  if (input.includes("# Checkpoint-only recovery")) {
    console.log('\`\`\`json\\n{"status":"waiting","wait_kind":"ci","wait_minutes":5,"wait_check":"test -f /tmp/noop-ready","waiting_on":"saved checkpoint","summary":"progress saved"}\\n\`\`\`');
  } else setTimeout(() => {}, 5000);
});`;
  const workCfg = { clis: { fake: { command: [process.execPath, "-e", script] }, timeout_minutes: 0.001 } } as unknown as Cfg;
  const checkpointCfg = { clis: { fake: { command: [process.execPath, "-e", script] }, timeout_minutes: 1 } } as unknown as Cfg;
  const workLog = `${dir}/work.log`;
  const checkpointLog = `${dir}/checkpoint.log`;
  try {
    const work = await runAgent("fake", "do work", dir, workCfg, workLog);
    expect(work).toContain(RUN_LIMIT);
    const body = checkpointRecoveryBody("do work", workLog, Date.now() + 300_000, 5);
    const checkpoint = parseResult(await runAgent("fake", body, dir, checkpointCfg, checkpointLog));
    expect(checkpoint).toMatchObject({ status: "waiting", wait_kind: "ci", wait_minutes: 5, waiting_on: "saved checkpoint" });
    expect(checkpoint.wait_check).toBe("test -f /tmp/noop-ready");
    expect(readFileSync(checkpointLog, "utf8")).toContain("progress saved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 5_000);

test("a failed run that already did work is not retried, however its text reads", async () => {
  // The medic reports connection errors in its own result text. Replaying a run that ran a tool would repeat its
  // side effects, so only a run that did nothing at all may be spawned again.
  const dir = mkdtempSync(`${tmpdir()}/noop-unreachable-work-`);
  const counter = `${dir}/n`;
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "curl api" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "down" }] } },
    { type: "result", result: "the host could not resolve the API (ENOTFOUND)" },
  ].map((l) => JSON.stringify(l)).join("\n");
  const script = `const fs = require("node:fs");`
    + `const p = ${JSON.stringify(counter)};`
    + `fs.writeFileSync(p, String(Number(fs.existsSync(p) ? fs.readFileSync(p, "utf8") : 0) + 1));`
    + `process.stdout.write(${JSON.stringify(`${lines}\n`)}); process.exit(1);`;
  const cfg = { clis: { fake: { command: [process.execPath, "-e", script, "stream-json"] } } } as unknown as Cfg;
  const log = `${dir}/run.log`;
  try {
    const out = await runAgent("fake", "prompt", dir, cfg, log);
    expect(out).toContain("ENOTFOUND");
    expect(Number(readFileSync(counter, "utf8"))).toBe(1);
    expect(readFileSync(log, "utf8")).not.toContain("[retried after");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("a completed tool call with an empty result is not retried", async () => {
  // A stream that already ran a tool and then ended with result:"" must not be replayed: the first run may have
  // posted, committed, or done other work, and a fresh prompt would repeat it.
  const dir = mkdtempSync(`${tmpdir()}/noop-tool-empty-`);
  const counter = `${dir}/n`;
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }] } },
    { type: "result", result: "" },
  ].map((l) => JSON.stringify(l)).join("\n");
  const script = `const fs = require("node:fs");`
    + `const p = ${JSON.stringify(counter)};`
    + `fs.writeFileSync(p, String(Number(fs.existsSync(p) ? fs.readFileSync(p, "utf8") : 0) + 1));`
    + `process.stdout.write(${JSON.stringify(`${lines}\n`)});`;
  const cfg = { clis: { fake: { command: [process.execPath, "-e", script, "stream-json"] } } } as unknown as Cfg;
  const log = `${dir}/run.log`;
  try {
    const out = await runAgent("fake", "prompt", dir, cfg, log);
    expect(out.trim()).toBe("");
    expect(Number(readFileSync(counter, "utf8"))).toBe(1);
    expect(readFileSync(log, "utf8")).not.toContain("[retried after an empty response]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("visible assistant text with an empty result is not retried", async () => {
  // An empty result currently masks earlier visible assistant text via `resultText ?? assistantText`; that must not
  // trigger a replay either.
  const dir = mkdtempSync(`${tmpdir()}/noop-text-empty-`);
  const counter = `${dir}/n`;
  const lines = [
    { type: "assistant", message: { content: [{ type: "text", text: "I looked around" }] } },
    { type: "result", result: "" },
  ].map((l) => JSON.stringify(l)).join("\n");
  const script = `const fs = require("node:fs");`
    + `const p = ${JSON.stringify(counter)};`
    + `fs.writeFileSync(p, String(Number(fs.existsSync(p) ? fs.readFileSync(p, "utf8") : 0) + 1));`
    + `process.stdout.write(${JSON.stringify(`${lines}\n`)});`;
  const cfg = { clis: { fake: { command: [process.execPath, "-e", script, "stream-json"] } } } as unknown as Cfg;
  const log = `${dir}/run.log`;
  try {
    const out = await runAgent("fake", "prompt", dir, cfg, log);
    expect(out.trim()).toBe("");
    expect(Number(readFileSync(counter, "utf8"))).toBe(1);
    expect(readFileSync(log, "utf8")).not.toContain("[retried after an empty response]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("status: a task parked on something slow stays listed however many tasks finished after it", async () => {
  const { status } = await import("../src/server");
  const { P } = await import("../src/core");
  const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const doc = (id: string, extra: string) => `---\nid: ${id}\ntitle: ${id}\nsource: routine:macos-check\n${extra}\n---\n\nbody\n`;
  mkdirSync(P("tasks", "waiting"), { recursive: true });
  mkdirSync(P("tasks", "done"), { recursive: true });
  const files = [P("tasks", "waiting", "T-9900.md")];
  writeFileSync(files[0], doc("T-9900", "started: 2020-01-01T00:00:00Z\nwake_at: 2999-01-01T00:00:00Z"));
  for (let i = 1; i <= 15; i++) {
    const f = P("tasks", "done", `T-99${String(i).padStart(2, "0")}.md`);
    files.push(f);
    writeFileSync(f, doc(`T-99${String(i).padStart(2, "0")}`, "finished: 2999-01-01T00:00:00Z"));
  }
  try {
    expect(status().recent.find((t) => t.id === "T-9900")?.state).toBe("parked");
  } finally {
    for (const f of files) rmSync(f);
  }
});

test("codex can write to project checkouts and scratch, not only its cwd", async () => {
  const { cliCommand, codexWritableDirs } = await import("../src/runner");
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "noop-home-")));
  mkdirSync(join(home, "work"));
  mkdirSync(join(home, ".noop", "work"), { recursive: true });
  symlinkSync(join(home, ".noop"), join(home, ".agent-hub"));
  const dirs = codexWritableDirs(home);
  expect(dirs).toContain(join(home, "work"));
  expect(dirs.filter((d) => d === join(home, ".noop", "work")).length).toBe(1); // the symlinked alias collapses
  expect(dirs).not.toContain(join(home, ".cargo")); // missing dirs are left out
  const cmd = cliCommand("codex", {} as any);
  expect(cmd.at(-1)).toBe("-");
  expect(cmd).toContain("--add-dir");
});

test("checkWaits: a waiting task wakes early once its wait_check exit code changes", async () => {
  const { writeDoc, P } = await import("../src/core");
  const { checkWaits } = await import("../src/cli");
  // The check runs in bash, which reads a Windows "C:\..." path as an escape, so keep it POSIX-style.
  const flag = `${tmpdir()}/noop-waitcheck-${process.pid}`.replace(/\\/g, "/");
  rmSync(flag, { force: true });
  const wake = new Date(Date.now() + 3600_000).toISOString();
  writeDoc(P("tasks", "waiting", "T-9101.md"), { id: "T-9101", title: "wait for CI", wake_at: wake, wait_check: `test -f ${flag}` }, "x");
  const t0 = Date.now();
  expect((await checkWaits(t0, 1000)).size).toBe(0); // baseline: still pending
  expect((await checkWaits(t0 + 10, 1000)).size).toBe(0); // throttled
  await Bun.write(flag, "1");
  expect([...(await checkWaits(t0 + 2000, 1000))]).toEqual(["T-9101"]);
  rmSync(flag, { force: true });
});

test("checkWaits: a wait that finished while the daemon was down still wakes after a restart", async () => {
  const { writeDoc, P } = await import("../src/core");
  const { checkWaits } = await import("../src/cli");
  const flag = `${tmpdir()}/noop-waitcheck-r-${process.pid}`.replace(/\\/g, "/");
  rmSync(flag, { force: true });
  const wake = new Date(Date.now() + 3600_000).toISOString();
  const cmd = `test -f ${flag}`;
  // An earlier daemon saw the check pending (exit 1) and recorded that baseline in the task.
  writeDoc(P("tasks", "waiting", "T-9102.md"), { id: "T-9102", title: "wait", wake_at: wake, wait_check: cmd, wait_check_base: `1 ${cmd}` }, "x");
  await Bun.write(flag, "1"); // finished during the restart
  expect([...(await checkWaits(Date.now() + 999_999_999, 1000))]).toContain("T-9102");
  rmSync(flag, { force: true });
});

test("Codex keeps the completed result before an empty hook turn and ignores tool output", async () => {
  const { codexMessages } = await import("../src/codex-output");
  const result = '```json\n{"status":"done","summary":"captured"}\n```';
  const lines = [
    { type: "item.completed", item: { type: "agent_message", text: result } },
    { type: "item.completed", item: { type: "command_execution", aggregated_output: '```json\n{"status":"failed"}\n```' } },
    { type: "item.completed", item: { type: "agent_message", text: "" } },
    { type: "turn.completed" },
  ].map((e) => JSON.stringify(e)).join("\n");
  const cfg = { clis: { codex: { command: ["sh", "-c", 'printf "%s\\n" "$1"', "--json", lines] } } } as unknown as Cfg;
  const log = `${tmpdir()}/noop-codex-${process.pid}.log`;
  try {
    expect(parseResult(await runAgent("codex", "", tmpdir(), cfg, log))).toMatchObject({ status: "done", summary: "captured" });
    expect(parseResult(codexMessages(lines))).toMatchObject({ status: "done", summary: "captured" });
  } finally { rmSync(log, { force: true }); }
});

test("gate_override relaxes only the approvable gates", () => {
  const cfg = { gates: { extra: ["Bash(kubectl delete:*)"] } } as unknown as Cfg;
  const full = cliCommand("claude", cfg);
  for (const g of ["Bash(gh pr merge:*)", "Bash(gh repo delete:*)", "Bash(gh secret:*)", "Bash(rm -rf ~:*)", "Bash(gh api repos/:*)", "Bash(kubectl delete:*)", "Bash(pkill:*)", "Bash(killall:*)"])
    expect(full).toContain(g);
  const relaxed = cliCommand("claude", cfg, true);
  expect(relaxed).not.toContain("Bash(gh pr merge:*)");
  expect(relaxed).not.toContain("Bash(gh release create:*)");
  expect(relaxed).not.toContain("Bash(gh api repos/:*)");
  for (const g of ["--disallowedTools", "Bash(rm -rf /:*)", "Bash(rm -rf ~:*)", "Bash(gh repo delete:*)", "Bash(gh secret:*)", "Bash(kubectl delete:*)"])
    expect(relaxed).toContain(g);
});

test("a model-emitted followup without a title cannot abort the run", async () => {
  const { asText, newTask, readDoc, P } = await import("../src/core");
  const { followupsOf } = await import("../src/cli");
  // what the model actually sent when the daemon died: no title, only a body
  const res = parseResult('```json\n{"status":"delegated","summary":"ok","followups":[{"body":"no title here"},{"title":"real work","agent":"lead"},"a bare string",null,{"title":42}]}\n```');
  expect(followupsOf(res, 8).map((f) => f.title)).toEqual(["real work", "a bare string", "42"]);
  expect(followupsOf({ status: "done", summary: "" }, 8)).toEqual([]); // no followups at all
  expect(followupsOf({ status: "delegated", summary: "", followups: "nope" as any }, 8)).toEqual([]);
  expect(followupsOf(res, 1).map((f) => f.title)).toEqual(["real work"]); // the depth cap still applies
  // and the boundary itself no longer throws when a title is missing or not a string
  for (const title of [undefined, null, 7, { a: 1 }]) expect(newTask(title as any, "")).toMatch(/^T-/);
  expect(readDoc(P("tasks", "inbox", `${newTask("kept", "")}.md`)).meta.title).toBe("kept");
  expect(asText({ a: 1 })).toBe('{"a":1}');
});

test("a followup whose requires is a list or another non-string cannot abort the run", async () => {
  const { newTask, readDoc, P } = await import("../src/core");
  const read = (id: string) => readDoc(P("tasks", "inbox", `${id}.md`)).meta;
  // an agent told "leave requires empty" sent `"requires": []`; `.split` on an array killed the worker three times
  // (each time after a long run, so the whole run was requeued)
  expect(read(newTask("empty list", "", { requires: [] as any })).requires).toBe("");
  expect(read(newTask("listed", "", { requires: ["os:windows", " cli:claude "] as any })).requires).toBe("os:windows,cli:claude");
  expect(read(newTask("string still works", "", { requires: "os:macos, host:Mac" })).requires).toBe("os:macos,host:Mac");
  // the other string-typed fields come from the same untrusted JSON
  const odd = read(newTask("odd fields", "", { requires: 7 as any, repo: [] as any, agent: 3 as any, host: ["a"] as any, priority: { p: 1 } as any }));
  expect(odd.requires).toBe("7");
  expect(odd.repo).toBe("");
  expect(odd.agent).toBe("3");
  expect(odd.host).toBe("a");
  expect(odd.priority).toBe('{"p":1}');
});

test("lessons sent as a bare string are kept, not fatal", async () => {
  const { readIf, remember, P } = await import("../src/core");
  const dir = P("agents", "crashguard-test", "memory.md");
  rmSync(dir, { force: true });
  expect(() => remember("crashguard-test", "one lesson" as any, "T-1")).not.toThrow();
  expect(readIf(dir)).toContain("- one lesson _(T-1");
  rmSync(dir, { force: true });
  remember("crashguard-test", ["first", "", 5 as any], "T-2");
  expect(readIf(dir)).toContain("- first _(T-2");
  expect(readIf(dir)).toContain("- 5 _(T-2");
  expect(readIf(dir)).not.toContain("-  _("); // blanks dropped
  rmSync(dir, { force: true });
  expect(() => remember("crashguard-test", undefined, "T-3")).not.toThrow();
  expect(() => remember("crashguard-test", { length: 2 } as any, "T-4")).not.toThrow(); // no write, no crash
});

test("runsCheckHere: the host that parked a wait runs its check; the primary runs the rest it can", async () => {
  const { runsCheckHere } = await import("../src/cli");
  const mac = { host_caps: "os:macos,host:mbp", wait_check: "test -f /Users/j/done" };
  expect(runsCheckHere(mac, "mbp", false, "linux")).toBe(true);
  expect(runsCheckHere(mac, "lb", true, "linux")).toBe(false); // macOS path: the primary can't answer it
  expect(runsCheckHere({ host_caps: "host:mbp", wait_check: "gh pr checks 1 -R o/r" }, "lb", true, "linux")).toBe(true);
  expect(runsCheckHere({ host_caps: "host:mbp", wait_check: "gh pr checks 1 -R o/r" }, "win", false, "linux")).toBe(false);
});

test("a prompt says when it cuts the start of a file", async () => {
  const { readTail } = await import("../src/core");
  const dir = mkdtempSync(join(tmpdir(), "noop-tail-"));
  try {
    const f = join(dir, "memory.md");
    writeFileSync(f, "STANDING-RULES\n" + "x".repeat(100) + "\nnewest lesson\n");
    expect(readTail(f, 1000)).toBe(readFileSync(f, "utf8")); // fits: untouched, no notice
    const cut = readTail(f, 40);
    expect(cut.split("\n")[0]).toContain(f); // the notice says where the rest is
    expect(cut.split("\n")[0]).toContain("cut");
    expect(cut.endsWith("newest lesson\n")).toBe(true); // the newest text is still there
    expect(cut).not.toContain("STANDING-RULES");
    expect(readTail(join(dir, "missing.md"))).toBe("");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readAll names the files that no longer fit instead of dropping them silently", async () => {
  const { readAll } = await import("../src/core");
  const dir = mkdtempSync(join(tmpdir(), "noop-readall-"));
  try {
    writeFileSync(join(dir, "a-principles.md"), "A".repeat(300));
    writeFileSync(join(dir, "b-focus.md"), "B".repeat(300));
    writeFileSync(join(dir, "c-taste.md"), "C".repeat(300));
    expect(readAll(dir, 5000)).not.toContain("cut to the last"); // fits: no notice
    const out = readAll(dir, 400);
    const first = out.split("\n")[0];
    expect(first).toContain("not shown: a-principles.md");
    expect(first).toContain("partly shown: b-focus.md");
    expect(first).not.toContain("c-taste.md"); // fully shown
    expect(out.endsWith("C".repeat(300))).toBe(true);
    expect(out.length).toBeLessThan(400 + first.length + 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a long paste uploads as Markdown; other text types stay refused", async () => {
  const { uploadProblem } = await import("../cloud/src/uploads");
  expect(uploadProblem("text/markdown", 10)).toBeNull();
  expect(uploadProblem("text/html", 10)?.status).toBe(415);
});

test("pickTask: a higher-priority online machine with room takes the task first; a saturated one or a long wait does not hold it", async () => {
  const { pickTask, writeDoc, P, hostName } = await import("../src/core");
  const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  if (!Bun.which("claude") && !Bun.which("codex")) return;
  const cfg: any = { clis: { default: ["claude", "codex"] }, fleet: { host_priority: { "prio-big": 10 } } };
  mkdirSync(P("fleet", "hosts"), { recursive: true });
  const beat = (stats: any) => writeFileSync(P("fleet", "hosts", "prio-big.json"), JSON.stringify({ host: "prio-big", caps: [], seen: new Date().toISOString(), busy: 0, version: "1", stats }));
  const now = new Date().toISOString();
  writeDoc(P("tasks", "inbox", "T-9031.md"), { id: "T-9031", title: "fresh", agent: "lead", priority: "urgent", planned: now, created: now }, "x");
  try {
    beat({ cpuBusyPct: 5, memFreePct: 60 });
    expect(pickTask(cfg) ?? "").not.toContain("T-9031"); // the idle higher-priority machine gets it
    beat({ cpuBusyPct: 95, memFreePct: 60 });
    expect(pickTask(cfg)).toContain("T-9031"); // it is saturated: this machine runs it
    cfg.fleet.host_priority[hostName(cfg)] = 20;
    beat({ cpuBusyPct: 5, memFreePct: 60 });
    expect(pickTask(cfg)).toContain("T-9031"); // this machine ranks higher
  } finally { rmSync(P("fleet", "hosts", "prio-big.json"), { force: true }); rmSync(P("tasks", "inbox", "T-9031.md"), { force: true }); }
});

test("pasted long text attachments are inlined for the chat brain", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { withAttachments } = await import("../src/server");
  const root = mkdtempSync(join(tmpdir(), "noop-paste-"));
  const md = join(root, "pasted-3.md");
  writeFileSync(md, "第一点：修复滚动\n第二点：改图标\n");
  const text = withAttachments("", [md]);
  expect(text.startsWith("(the owner pasted a long text, below)")).toBe(true);
  expect(text).toContain("第二点：改图标");
  expect(text).toContain(`- ${md}`);
  rmSync(root, { recursive: true, force: true });
});
