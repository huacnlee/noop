import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { P, list, readDoc, writeDoc } from "../src/core";
import { sweepPlatform, alreadyAsked, cardFor, checkUnrunnable, classify, groupByCause, supervise, type Ctx, type Task } from "../src/supervisor";
import { closeDecision, ignoreDecision } from "../src/decisions";

const H = 3_600_000;
const NOW = Date.parse("2026-11-07T04:00:00Z");
const mac = { host: "huacnlee-macbook", caps: ["os:macos", "host:huacnlee-macbook"], seen: "", busy: 0, version: "1" };
const lin = { host: "lb", caps: ["os:linux", "host:lb"], seen: "", busy: 0, version: "1" };
const old = { host: "omarchy-jason", caps: ["os:linux", "host:omarchy-jason"], seen: "", busy: 0, version: "1" };
const ctx = (o: Partial<Ctx> = {}): Ctx => ({ now: NOW, online: [mac, lin, old], retired: ["omarchy-jason"], primaryOs: "linux",
  maxAgeHours: 3, maxWakes: 3, decision: () => undefined, ...o });
const task = (m: Record<string, string>, folder: "waiting" | "blocked" = "waiting"): Task =>
  ({ folder, meta: { title: m.id, created: new Date(NOW - H).toISOString(), waiting_on: "x", wait_check: "true", ...m } });

// Every test file shares one throwaway hub (see test/preload.ts), and reroute/resume move tasks into
// tasks/inbox with their host requirement stripped. A leftover there is a pickable task, so a later
// file's pickTask() test would pick it up instead of its own fixture. Remove what this file created.
afterAll(() => {
  for (const id of ["T-0101", "T-0102", "T-0103", "T-0201", "T-0202"]) rmSync(P("tasks", "inbox", `${id}.md`), { force: true });
});

test("young, normally cycling waits are left alone", () => {
  expect(classify(task({ id: "T-1", requires: "os:linux", wakes: "1" }), ctx())).toBeNull();
});

test("flags age, wake count and macOS checks that can never run on the Linux primary", () => {
  const a = classify(task({ id: "T-1", created: new Date(NOW - 5 * H).toISOString() }), ctx())!;
  expect(a.action).toBe("escalate");
  expect(a.reasons[0]).toContain("5 小时");
  expect(classify(task({ id: "T-2", wakes: "3" }), ctx())!.reasons).toContain("唤醒 3 次");
  expect(checkUnrunnable("swift /Users/jason/x/display.swift", "linux")).toBe(true);
  expect(checkUnrunnable("gh pr checks 1 -R o/r", "linux")).toBe(false);
  const m = classify(task({ id: "T-3", requires: "os:macos", wait_check: "test -f /Users/jason/a" }), ctx())!;
  expect(m.cause).toBe("platform:os:macos");
});

test("keep going first: retired host → reroute, answered card → resume, no waiting_on → requeue once", () => {
  const r = classify(task({ id: "T-1", requires: "host:omarchy-jason", claimed_by: "omarchy-jason" }), ctx())!;
  expect([r.action, r.requires]).toEqual(["reroute", ""]);
  const b = classify(task({ id: "T-2", decision: "D-1" }, "blocked"), ctx({ decision: () => "closed" }))!;
  expect(b.action).toBe("resume");
  expect(classify(task({ id: "T-3", decision: "D-1" }, "blocked"), ctx({ decision: () => "open" }))).toBeNull();
  expect(classify(task({ id: "T-4", waiting_on: "", wait_check: "" }), ctx())!.action).toBe("requeue");
  expect(classify(task({ id: "T-4", waiting_on: "", wait_check: "", supervisor_requeued: "yes" }), ctx())!.action).toBe("escalate");
  expect(classify(task({ id: "T-5", children: "T-6" }), ctx())).toBeNull(); // delegated parent
});

test("groups by cause: all macOS-desktop tasks share one card", () => {
  const vs = ["T-1", "T-2", "T-3"].map((id) => classify(task({ id, requires: "os:macos", wakes: "5", waiting_on: "Mac 桌面会话" }), ctx())!);
  vs.push(classify(task({ id: "T-9", requires: "os:linux", wakes: "4", claimed_by: "lb" }), ctx())!);
  vs.push(classify(task({ id: "T-8", requires: "os:linux", wakes: "4", claimed_by: "lb", waiting_on: "", wait_check: "" }, "blocked"), ctx())!);
  const g = groupByCause(vs);
  expect([...g.keys()].sort()).toEqual(["platform:os:macos", "slow:lb", "wait:ci"]);
  expect(g.get("platform:os:macos")!.map((v) => v.id)).toEqual(["T-1", "T-2", "T-3"]);
  const c = cardFor("platform:os:macos", g.get("platform:os:macos")!.map((v) => ({ id: v.id, title: v.id, reasons: v.reasons })));
  expect(c.options.length).toBeGreaterThanOrEqual(2);
  expect(c.recommendation).toBe("A");
  expect(c.question).toContain("macOS");
});

test("dedupe: tasks covered by an earlier card for the same cause (answered, skipped or open) are not asked again", () => {
  const cards: Record<string, string>[] = [{ supervisor_cause: "platform:os:macos", tasks: "T-1,T-2", answer: "忽略" }, { supervisor_cause: "no-wait", tasks: "T-3" }];
  expect(alreadyAsked("platform:os:macos", ["T-1", "T-2", "T-3"], cards)).toEqual(["T-3"]);
  expect(alreadyAsked("platform:os:macos", ["T-1"], cards)).toEqual([]);
});

test("supervise(): one card per cause, never twice; answering resumes every task without opening a gate", () => {
  mkdirSync(P("journal"), { recursive: true });
  for (const f of ["waiting", "blocked", "inbox"]) mkdirSync(P("tasks", f), { recursive: true });
  mkdirSync(P("decisions", "open"), { recursive: true }); mkdirSync(P("decisions", "closed"), { recursive: true });
  mkdirSync(P("fleet", "hosts"), { recursive: true });
  const seen = new Date().toISOString();
  writeFileSync(P("fleet", "hosts", "huacnlee-macbook.json"), JSON.stringify({ ...mac, seen }));
  writeFileSync(P("fleet", "hosts", "lb.json"), JSON.stringify({ ...lin, seen }));
  const t0 = new Date(Date.now() - 10 * H).toISOString();
  for (const id of ["T-0101", "T-0102"]) writeDoc(P("tasks", "waiting", `${id}.md`), { id, title: id, requires: "os:macos", created: t0, waiting_on: "Mac 桌面", wait_check: "swift /Users/j/d.swift", supervisor_requeued: "yes" }, "body");
  writeDoc(P("tasks", "waiting", "T-0103.md"), { id: "T-0103", title: "old", requires: "host:omarchy-jason", claimed_by: "omarchy-jason", created: t0, waiting_on: "x" }, "body");
  const cfg = { supervisor: { retired_hosts: ["omarchy-jason"] }, fleet: {} };
  const first = supervise(cfg, "lb");
  expect(first.reroute).toBe(1);
  expect(existsSync(P("tasks", "inbox", "T-0103.md"))).toBe(true);
  const open = list(P("decisions", "open")).map((p) => readDoc(p).meta).filter((m) => m.supervisor_cause === "platform:os:macos");
  expect(open.length).toBe(1);
  expect(open[0].tasks).toBe("T-0101,T-0102");
  expect(supervise(cfg, "lb").cards).toBe(0); // open card: not again
  ignoreDecision(open[0].id, "owner(chat)");
  for (const id of ["T-0101", "T-0102"]) {
    const m = readDoc(P("tasks", "inbox", `${id}.md`)).meta;
    expect(m.gate_override).toBeUndefined();
    // the agent waits again on the same Mac: still covered by the skipped card, so no new card
    writeDoc(P("tasks", "waiting", `${id}.md`), { ...m, wakes: "9" }, "b");
  }
  expect(supervise(cfg, "lb").cards).toBe(0);
  expect(readFileSync(P("journal", `${new Date().toLocaleDateString("sv-SE")}.md`), "utf8")).toContain("supervisor ran");
});

test("closeDecision on a supervisor card never sets gate_override", () => {
  writeDoc(P("decisions", "open", "D-9001.md"), { id: "D-9001", task: "T-0201", tasks: "T-0201,T-0202", supervisor_cause: "no-wait", question: "q" }, "c");
  for (const id of ["T-0201", "T-0202"]) writeDoc(P("tasks", "blocked", `${id}.md`), { id, title: id, decision: "D-9001" }, "b");
  closeDecision("D-9001", "A", "owner(chat)");
  for (const id of ["T-0201", "T-0202"]) {
    const m = readDoc(P("tasks", "inbox", `${id}.md`)).meta;
    expect(m.resumes).toBe("D-9001");
    expect(m.gate_override).toBeUndefined();
  }
});

test("dated follow-ups are exempt; a delegated parent on a retired host is re-pinned; young same-platform tasks join the card", () => {
  expect(classify(task({ id: "T-1", wakes: "9", wait_check: "test $(date +%Y%m%d) -lt 20261114" }), ctx())).toBeNull();
  const p = classify(task({ id: "T-2", children: "T-3", requires: "host:omarchy-jason" }), ctx())!;
  expect([p.action, p.requires]).toEqual(["repin", ""]);
  const young = task({ id: "T-4", requires: "os:macos", waiting_on: "Mac 解锁" });
  const stuck = classify(task({ id: "T-5", requires: "os:macos", wakes: "7", waiting_on: "Mac 解锁" }), ctx())!;
  expect(classify(young, ctx())).toBeNull();
  expect(sweepPlatform([young], [stuck]).map((v) => [v.id, v.cause])).toEqual([["T-4", "platform:os:macos"]]);
});

test("macOS host online + wait_check unrunnable on the primary: hand back to the Mac once, not a card", () => {
  const m = { id: "T-1", requires: "os:macos", created: new Date(NOW - 10 * H).toISOString(), waiting_on: "x", wait_check: "test -f /Users/j/done" };
  expect(classify(task(m), ctx())!.action).toBe("reroute");
  expect(classify(task({ ...m, supervisor_requeued: "yes" }), ctx())!.action).toBe("escalate");
});

// D-0013 (2026-11-10): four macOS tasks all waited on `review-account.ts check claude` (Claude quota cooling down) while
// the Mac primary was online, and the supervisor still sent a "macOS tasks not advancing" card.
const quota = (id: string, o: Record<string, string> = {}) => task({ id, requires: "os:macos", created: new Date(NOW - 4 * H).toISOString(),
  waiting_since: new Date(NOW - 4 * H).toISOString(), wakes: "2", wait_kind: "ci",
  waiting_on: "Claude 额度冷却至北京时间 19:22；恢复后继续跨模型 review", wait_check: "bun /Users/k/.agent-hub/work/noop/src/review-account.ts check claude", ...o });

test("D-0013: quota waits on a Mac primary are not a platform card; the daemon watches their check", () => {
  const mc = ctx({ primaryOs: "macos" });
  for (const id of ["T-0034", "T-0036", "T-0043", "T-0056"]) expect(classify(quota(id), mc)).toBeNull();
  expect(classify({ ...quota("T-0043"), folder: "blocked" }, mc)).toBeNull(); // parked after wakes: the daemon resumes it
  // a young quota task never joins a platform card either
  const stuck = classify(task({ id: "T-5", requires: "os:macos", wakes: "7", waiting_on: "Mac 解锁" }), mc)!;
  expect(stuck.cause).toBe("platform:os:macos");
  expect(sweepPlatform([quota("T-0056", { wakes: "0" })], [stuck], mc)).toEqual([]);
  // the check never passing for 4x the max age is a quota card, not a platform card
  const old = classify(quota("T-0034", { created: new Date(NOW - 13 * H).toISOString(), waiting_since: new Date(NOW - 13 * H).toISOString() }), mc)!;
  expect([old.cause, old.action]).toEqual(["quota", "escalate"]);
  expect(cardFor("quota", [{ id: "T-0034", title: "t", reasons: old.reasons }]).question).toContain("额度");
});

test("separates causes: CI and human waits on an online platform host are not platform cards", () => {
  const mc = ctx({ primaryOs: "macos" });
  const age = new Date(NOW - 5 * H).toISOString();
  const ci = classify(task({ id: "T-1", requires: "os:macos", created: age, waiting_on: "CI run 123", wait_check: "gh run view 123 --exit-status" }), mc)!;
  expect(ci.cause).toBe("wait:ci");
  const human = classify(task({ id: "T-2", requires: "os:macos", created: age, waiting_on: "owner 合并 PR", wait_kind: "human", wait_check: "gh pr view 1" }), mc)!;
  expect(human.cause).toBe("wait:human");
  // no macOS host online at all: that one is the platform
  const off = classify(task({ id: "T-3", requires: "os:macos", created: age, waiting_on: "CI run 123" }), ctx({ online: [lin] }))!;
  expect(off.cause).toBe("platform:os:macos");
});

test("supervise(): D-0013 quota tasks get no card; a quota pass resumes them and closes their supervisor card", async () => {
  const { checkWaits, resumeBlocked } = await import("../src/cli");
  const flag = `${tmpdir()}/noop-quota-${process.pid}`.replace(/\\/g, "/");
  rmSync(flag, { force: true });
  // stands in for `review-account.ts check claude`: exit 1 while cooling down, 0 once usable
  const check = `test -f ${flag} # review-account.ts check claude`;
  const t0 = new Date(Date.now() - 5 * H).toISOString();
  const ids = ["T-0301", "T-0302", "T-0303", "T-0304"];
  for (const id of ids) writeDoc(P("tasks", "waiting", `${id}.md`), { id, title: id, requires: "os:macos", created: t0, waiting_since: t0, wakes: "2",
    wait_kind: "ci", waiting_on: "Claude 额度冷却", wait_check: check, supervisor_requeued: "yes" }, "b");
  const before = list(P("decisions", "open")).length;
  supervise({ supervisor: {}, fleet: {} } as any, "lara0");
  expect(list(P("decisions", "open")).length).toBe(before);
  for (const id of ids) expect(existsSync(P("tasks", "waiting", `${id}.md`))).toBe(true);
  // The old supervisor already parked two of them under a platform card, and one was parked after too many wakes.
  writeDoc(P("decisions", "open", "D-9013.md"), { id: "D-9013", task: "T-0301", tasks: "T-0301,T-0302", supervisor_cause: "platform:os:macos", question: "macOS 任务推不动" }, "c");
  for (const id of ["T-0301", "T-0302"]) {
    const d = readDoc(P("tasks", "waiting", `${id}.md`));
    writeDoc(P("tasks", "blocked", `${id}.md`), { ...d.meta, status: "needs_decision", decision: "D-9013", wait_check_base: `1 ${check}` }, d.body);
    rmSync(P("tasks", "waiting", `${id}.md`));
  }
  const d3 = readDoc(P("tasks", "waiting", "T-0303.md"));
  writeDoc(P("tasks", "blocked", "T-0303.md"), { ...d3.meta, status: "blocked", wakes: "7" }, d3.body);
  rmSync(P("tasks", "waiting", "T-0303.md"));
  // A card an agent raised for the owner is not the daemon's to answer, even with a quota check.
  writeDoc(P("decisions", "open", "D-9014.md"), { id: "D-9014", task: "T-0305", question: "发布吗？" }, "c");
  writeDoc(P("tasks", "blocked", "T-0305.md"), { id: "T-0305", title: "x", status: "needs_decision", decision: "D-9014", waiting_on: "额度", wait_check: check }, "b");

  const t = Date.now();
  expect((await checkWaits(t, 1000)).size).toBe(0); // still cooling down
  resumeBlocked("lara0", new Set());
  await Bun.write(flag, "1"); // quota is back
  const ready = await checkWaits(t + 2000, 1000);
  expect([...ready].sort()).toEqual(["T-0301", "T-0302", "T-0303", "T-0304"]);
  resumeBlocked("lara0", ready);
  for (const id of ["T-0301", "T-0302", "T-0303"]) {
    const m = readDoc(P("tasks", "inbox", `${id}.md`)).meta;
    expect([m.decision, m.status, m.gate_override].filter(Boolean)).toEqual([]);
  }
  expect(existsSync(P("decisions", "open", "D-9013.md"))).toBe(false);
  const closed = readDoc(P("decisions", "closed", "D-9013.md")).meta;
  expect(closed.answered_by).toBe("system");
  expect(existsSync(P("tasks", "blocked", "T-0305.md"))).toBe(true); // the owner's card stands
  expect(existsSync(P("decisions", "open", "D-9014.md"))).toBe(true);
  rmSync(flag, { force: true });
  for (const id of [...ids, "T-0305"]) for (const f of ["inbox", "waiting", "blocked"]) rmSync(P("tasks", f, `${id}.md`), { force: true });
});
