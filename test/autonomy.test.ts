// Approval batches, routine dedupe, read-only routines, id minting: run against a throwaway data dir.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

const sent: string[] = [];
const realNotify = await import("../src/notify");
mock.module("../src/notify", () => ({ ...realNotify, openDecisionIds: () => new Set<string>(), pollReplies: async () => [], notify: async (t: string) => { sent.push(t); return []; } }));
const core = await import("../src/core");
const A = await import("../src/autonomy");
const { P, readDoc, writeDoc, nextId, setIdTag, idTagFor } = core;
// test/preload.ts points DATA at a temp dir; refuse to run against anything else (e.g. a live ~/.agent-hub)
if (!core.DATA.startsWith(tmpdir())) throw new Error(`refusing to run: DATA=${core.DATA} is not a temp dir`);

afterAll(() => rmSync(core.DATA, { recursive: true, force: true }));
beforeEach(() => { rmSync(core.DATA, { recursive: true, force: true }); mkdirSync(P("journal"), { recursive: true }); sent.length = 0; setIdTag(""); });

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const task = (state: string, id: string, source: string, created = ago(60)) =>
  writeDoc(P("tasks", state, `${id}.md`), { id, title: `t ${id}`, agent: "lead", source, created }, "body");
const files = (...p: string[]) => existsSync(P(...p)) ? readdirSync(P(...p)).sort() : [];
const cfg = { autonomy: { level: "onboarding" }, routine: [{ name: "uptime-watch", readonly: true }, { name: "pr-review" }] };

test("open batch with stale tasks is closed and rebuilt (no deadlock)", async () => {
  task("proposed", "T-0001", "routine:pr-review");
  task("proposed", "T-0002", "routine:pr-review");
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "open")).toEqual(["P-0001.md"]);
  expect(sent[0]).toContain("请确认");
  expect(sent[0]).not.toMatch(/Which|fleet/);

  // unchanged → nothing happens
  await A.proposeBatch(cfg, "pc");
  expect(sent.length).toBe(1);

  // T-0001 moved away, T-0003 is new; but the batch was just sent → throttled
  rmSync(P("tasks", "proposed", "T-0001.md"));
  task("proposed", "T-0003", "followup:T-0002");
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "open")).toEqual(["P-0001.md"]);

  // hours later → closed and replaced by a fresh batch
  const f = P("decisions", "open", "P-0001.md");
  const { meta, body } = readDoc(f);
  writeDoc(f, { ...meta, created: ago(300), notified: ago(300) }, body);
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "closed")).toEqual(["P-0001.md"]);
  expect(files("decisions", "open")).toEqual(["P-0002.md"]);
  // the task the owner never saw (T-0003) comes first: a rebuild must surface it, not bury it behind T-0002
  expect(readDoc(P("decisions", "open", "P-0002.md")).meta.items).toBe("T-0003,T-0002");
  expect(sent.length).toBe(2);
});

test("an unanswered batch stopped at nine never hides proposals that arrived later", async () => {
  // the owner ignores the menu: nine proposals go out and stay unanswered
  for (let i = 1; i <= 9; i++) task("proposed", `T-000${i}`, "followup:T-0000");
  await A.proposeBatch(cfg, "pc");
  expect(readDoc(P("decisions", "open", "P-0001.md")).meta.items).toBe("T-0001,T-0002,T-0003,T-0004,T-0005,T-0006,T-0007,T-0008,T-0009");
  // later work keeps arriving outside those nine (created after the batch went out)
  task("proposed", "T-0010", "routine:pr-review", new Date().toISOString());
  task("proposed", "T-0011", "followup:T-0001", new Date().toISOString());
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "closed")).toEqual([]); // still inside renotify_hours

  // once the throttle expires, the rebuild offers the unseen tasks instead of repeating the same nine
  const f = P("decisions", "open", "P-0001.md");
  const { meta, body } = readDoc(f);
  writeDoc(f, { ...meta, created: ago(300), notified: ago(300) }, body);
  await A.proposeBatch(cfg, "pc");
  const rebuilt = readDoc(P("decisions", "open", "P-0002.md")).meta.items.split(",");
  expect(rebuilt.slice(0, 2)).toEqual(["T-0010", "T-0011"]);
  expect(rebuilt.length).toBe(9);
  expect(rebuilt).toContain("T-0001"); // the unanswered ones stay offered as filler, not dropped
});

test("an ignored backlog larger than nine is rotated daily, not re-notified every renotify window", async () => {
  // 12 proposals, the owner answers none: the batch holds nine and three never made the slice
  for (let i = 1; i <= 12; i++) task("proposed", `T-01${String(i).padStart(2, "0")}`, "followup:T-0000", ago(600));
  await A.proposeBatch(cfg, "pc");
  expect(sent.length).toBe(1);
  const f = P("decisions", "open", "P-0001.md");
  const rewind = (min: number) => {
    const { meta, body } = readDoc(f);
    writeDoc(f, { ...meta, created: ago(min), notified: ago(min) }, body);
  };

  // five hours later nothing new arrived: rotate_hours (24h) has not passed, so the owner is not pinged again
  rewind(300);
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "closed")).toEqual([]);
  expect(sent.length).toBe(1);

  // a day later the three unseen proposals get their turn
  rewind(25 * 60);
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "closed")).toEqual(["P-0001.md"]);
  expect(readDoc(P("decisions", "open", "P-0002.md")).meta.items.split(",").length).toBe(9);
  expect(sent.length).toBe(2);
});

test("a high-priority proposal is not queued behind nine normal ones", async () => {
  for (let i = 1; i <= 9; i++) task("proposed", `T-000${i}`, "followup:T-0000");
  writeDoc(P("tasks", "proposed", "T-0020.md"), { id: "T-0020", title: "urgent", agent: "lead", source: "followup:T-0000", created: ago(5), priority: "high" }, "body");
  await A.proposeBatch(cfg, "pc");
  expect(readDoc(P("decisions", "open", "P-0001.md")).meta.items.split(",")[0]).toBe("T-0020");
});

test("open batch whose tasks are all gone is closed right away", async () => {
  writeDoc(P("decisions", "open", "P-0001.md"), { id: "P-0001", kind: "proposals", created: ago(1), items: "T-0009" }, "x");
  task("proposed", "T-0010", "routine:pr-review", ago(1));
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "closed")).toEqual(["P-0001.md"]);
  expect(files("decisions", "open")).toEqual(["P-0002.md"]);
});

test("a stub without frontmatter in tasks/proposed is not proposed and does not rebuild the batch", async () => {
  // an agent appended a note to the old path of an already-approved task
  await Bun.write(P("tasks", "proposed", "T-0001.md"), "\n\n## Note\nfollow-up for whoever picks this up\n");
  task("proposed", "T-0002", "followup:T-0000");
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "open")).toEqual(["P-0001.md"]);
  expect(readDoc(P("decisions", "open", "P-0001.md")).meta.items).toBe("T-0002");
  expect(sent[0]).not.toContain("undefined");
  await A.proposeBatch(cfg, "pc");
  expect(files("decisions", "open")).toEqual(["P-0001.md"]);
  expect(files("decisions", "closed")).toEqual([]);
  expect(sent.length).toBe(1);
});

test("answer numbers follow the card lines even when a batch has an empty slot", () => {
  // a batch built before stubs were skipped: line 1 was an empty item, line 2 the real task
  writeDoc(P("decisions", "open", "P-0001.md"), { id: "P-0001", kind: "proposals", created: ago(1), items: ",T-0002" }, "x");
  task("proposed", "T-0002", "followup:T-0000");
  expect(A.resolveProposals("P-0001", "2", "owner(chat)")).toBe(true);
  expect(readDoc(P("tasks", "inbox", "T-0002.md")).meta.approval).toBe("P-0001");
  expect(files("tasks", "rejected")).toEqual([]);
});

test("an answer in words picks nothing: the card stays open instead of rejecting every item", () => {
  writeDoc(P("decisions", "open", "P-0001.md"), { id: "P-0001", kind: "proposals", created: ago(1), items: "T-0002,T-0003" }, "x");
  task("proposed", "T-0002", "followup:T-0000");
  task("proposed", "T-0003", "followup:T-0000");
  expect(A.resolveProposals("P-0001", "只做文档那项，另一个先不做", "owner(chat)")).toBe(false);
  expect(files("decisions", "open")).toEqual(["P-0001.md"]);
  expect(files("tasks", "proposed")).toEqual(["T-0002.md", "T-0003.md"]);
  // the brain turns the words into a pick and keeps them as the owner's note
  expect(A.resolveProposals("P-0001", "1: 2 先不做，只做文档那项", "owner(chat)")).toBe(true);
  expect(readFileSync(P("tasks", "inbox", "T-0002.md"), "utf8")).toContain("## Owner note (P-0001)\n2 先不做，只做文档那项");
  expect(files("tasks", "rejected")).toEqual(["T-0003.md"]);
});

test("numbers followed by words, or a word that only starts like all/none, keep the card open", () => {
  writeDoc(P("decisions", "open", "P-0001.md"), { id: "P-0001", kind: "proposals", created: ago(1), items: "T-0002,T-0003" }, "x");
  task("proposed", "T-0002", "followup:T-0000");
  task("proposed", "T-0003", "followup:T-0000");
  // a Slack/Discord/CLI reply skips the chat brain: "1、不做 2、做" means do 2, not a pick of 1
  for (const words of ["1、不做 2、做", "1 no 2 yes", "allow 2", "nonetheless 1"])
    expect(A.resolveProposals("P-0001", words, "owner(slack)")).toBe(false);
  expect(files("decisions", "open")).toEqual(["P-0001.md"]);
  expect(files("tasks", "proposed")).toEqual(["T-0002.md", "T-0003.md"]);
  expect(A.resolveProposals("P-0001", "1, 2", "owner(slack)")).toBe(true);
  expect(files("tasks", "rejected")).toEqual([]);
});

test("precedents are the latest answers, whatever the id", () => {
  const card = (id: string, answered: string) => writeDoc(P("decisions", "closed", `${id}.md`), { id, question: `q ${id}`, answer: "A", answered }, "x");
  card("D-0009", "2026-11-12T10:00:00Z");
  card("D-C0001", "2026-11-10T10:00:00Z");
  card("P-0005", "2026-11-11T10:00:00Z");
  expect([...core.precedents(2).matchAll(/^- (\S+)/gm)].map((m) => m[1])).toEqual(["P-0005", "D-0009"]);
});

test("routine dedupe: newer run supersedes proposed copy, queued copy blocks", () => {
  task("proposed", "T-0001", "routine:pr-review");
  task("proposed", "T-0002", "routine:other");
  expect(A.routineQueued("pr-review")).toBe("");
  task("proposed", "T-0003", "routine:pr-review");
  expect(A.supersedeProposed("pr-review", "T-0003")).toEqual(["T-0001"]);
  expect(files("tasks", "proposed")).toEqual(["T-0002.md", "T-0003.md"]);
  expect(readFileSync(P("tasks", "rejected", "T-0001.md"), "utf8")).toContain("superseded by T-0003");

  task("active", "T-0004", "approved:routine:pr-review");
  expect(A.routineQueued("pr-review")).toBe("T-0004");
  expect(A.routineQueued("other")).toBe("");
});

test("routine dedupe: parked (waiting/blocked) copies never block the next run", () => {
  const park = (dir: string, id: string, hours: number) =>
    writeDoc(P("tasks", dir, `${id}.md`), { id, source: "routine:parked", created: new Date(Date.now() - hours * 3600_000).toISOString() }, "");
  park("waiting", "T-0101", 7);
  park("blocked", "T-0102", 7);
  expect(A.routineQueued("parked")).toBe("");
  park("active", "T-0103", 7);
  expect(A.routineQueued("parked")).toBe("T-0103");
  unlinkSync(P("tasks", "active", "T-0103.md"));
  park("waiting", "T-0104", 1);
  expect(A.routineQueued("parked")).toBe("");
});

test("routine dedupe: a checkpointed copy that will resume still blocks the next run", () => {
  // the work-limit checkpoint parks the copy in tasks/waiting, but its pass is not finished: the daemon resumes it,
  // so a copy minted in the meantime runs the same routine twice (T-2270 + T-2274, 2026-11-21)
  writeDoc(P("tasks", "waiting", "T-0111.md"), {
    id: "T-0111", source: "routine:triage-inbound", wait_kind: "ci", wait_minutes: "5",
    waiting_on: "checkpoint saved after the work limit; resume T-0111 from /tmp/T-0111.log",
  }, "");
  expect(A.routineQueued("triage-inbound")).toBe("T-0111");
  // an ordinary wait on CI has finished its pass and must not hold the next run back
  writeDoc(P("tasks", "waiting", "T-0112.md"), { id: "T-0112", source: "routine:own-prs-ci", wait_kind: "ci", waiting_on: "CI run 123" }, "");
  expect(A.routineQueued("own-prs-ci")).toBe("");
});

test("a queued copy no known host can run is retired, so the routine runs on its current config", () => {
  // own-prs-ci T-0406 asked for cli:git (no host reports it) and held the routine from 2026-11-10 on
  const missing = (reqs: string[]) => reqs.find((r) => !["os:macos", "cli:gh"].includes(r)) ?? "";
  writeDoc(P("tasks", "inbox", "T-0121.md"), { id: "T-0121", source: "routine:own-prs-ci", requires: "cli:gh,cli:git", host: "any" }, "body");
  expect(A.retireUnrunnableCopy("T-0121", missing)).toBe("cli:git");
  expect(files("tasks", "inbox")).toEqual([]);
  expect(readDoc(P("tasks", "rejected", "T-0121.md")).meta.approval).toBe("superseded:unrunnable");
  writeDoc(P("tasks", "inbox", "T-0122.md"), { id: "T-0122", source: "routine:own-prs-ci", requires: "cli:gh" }, "body");
  expect(A.retireUnrunnableCopy("T-0122", missing)).toBe(""); // a runnable copy stays queued
  expect(A.routineQueued("own-prs-ci")).toBe("T-0122");
});

test("a copy parked on an unanswered decision is found only while that decision is open", () => {
  writeDoc(P("decisions", "open", "D-0004.md"), { id: "D-0004", question: "告警源？" }, "x");
  writeDoc(P("tasks", "waiting", "T-0201.md"), {
    id: "T-0201", source: "routine:uptime-watch", wait_kind: "human", waiting_on: "等待主人答复 decisions/open/D-0004.md",
  }, "");
  expect(A.routineParkedOnDecision("uptime-watch")).toBe("T-0201");
  expect(A.routineParkedOnDecision("other")).toBe("");
  expect(A.routineParkedOnDecision("uptime-watch", "linux")).toBe(""); // not this machine's copy
  expect(A.routineQueued("uptime-watch")).toBe(""); // parked copies still never block a run on their own
  unlinkSync(P("decisions", "open", "D-0004.md"));
  expect(A.routineParkedOnDecision("uptime-watch")).toBe(""); // answered or closed → the routine continues
});

test("a copy parked in tasks/blocked by needs_decision counts while its decision is open", () => {
  // the standard path most routine copies take: returning needs_decision parks the task in tasks/blocked with
  // meta.decision, not a waiting_on string. Missing it made skip_while_decision_open a no-op for those copies.
  writeDoc(P("decisions", "open", "D-0009.md"), { id: "D-0009", question: "q" }, "x");
  writeDoc(P("tasks", "blocked", "T-0211.md"), { id: "T-0211", source: "routine:pr-review", status: "needs_decision", decision: "D-0009" }, "");
  expect(A.routineParkedOnDecision("pr-review")).toBe("T-0211");
  expect(A.routineParkedOnDecision("pr-review", "linux")).toBe(""); // per-machine routine: another host's copy
  unlinkSync(P("decisions", "open", "D-0009.md"));
  expect(A.routineParkedOnDecision("pr-review")).toBe(""); // answered or closed → the routine continues
  // a blocked copy whose decision file is gone (or an id that is not a card) must not silence the routine
  writeDoc(P("tasks", "blocked", "T-0212.md"), { id: "T-0212", source: "routine:pr-review", status: "needs_decision", decision: "D-9999" }, "");
  expect(A.routineParkedOnDecision("pr-review")).toBe("");
});

test("waiting on CI or on a merge is not waiting on a decision", () => {
  writeDoc(P("decisions", "open", "D-0004.md"), { id: "D-0004", question: "q" }, "x");
  writeDoc(P("tasks", "waiting", "T-0202.md"), {
    id: "T-0202", source: "routine:uptime-watch", wait_kind: "ci", waiting_on: "CI run https://github.com/o/r/actions/runs/1",
  }, "");
  writeDoc(P("tasks", "waiting", "T-0203.md"), {
    id: "T-0203", source: "routine:own-prs-ci", wait_kind: "human", waiting_on: "PR https://github.com/o/r/pull/1 merged? then re-read D-0004",
  }, "");
  expect(A.routineParkedOnDecision("uptime-watch")).toBe("");
  // a bare or incidental id mention is not a wait on the card: only the decisions/open path counts
  expect(A.routineParkedOnDecision("own-prs-ci")).toBe("");
});

test("a routine stuck behind a copy no host can run for 30+ minutes notifies the owner once per copy", async () => {
  const st: Record<string, string> = {};
  const parked = (id: string, min: number) =>
    writeDoc(P("tasks", "inbox", `${id}.md`), { id, source: "routine:uptime-watch", created: ago(min + 1), requires: "cli:aws", parked: ago(min) }, "");
  parked("T-0901", 9);
  A.noteStuckRoutine(cfg, "uptime-watch", "T-0901", st);
  expect(sent).toEqual([]); // parked only briefly: skipping it is normal
  // healthy or deliberate: queued for a free slot, running, waiting on CI or the owner, asking a card
  task("inbox", "T-0903", "routine:uptime-watch", ago(120));
  for (const [dir, id] of [["active", "T-0904"], ["waiting", "T-0905"], ["blocked", "T-0906"]]) task(dir, id, "routine:uptime-watch", ago(120));
  for (const id of ["T-0903", "T-0904", "T-0905", "T-0906"]) A.noteStuckRoutine(cfg, "uptime-watch", id, st);
  await Bun.sleep(0);
  expect(sent).toEqual([]);
  parked("T-0901", 44);
  A.noteStuckRoutine(cfg, "uptime-watch", "T-0901", st);
  A.noteStuckRoutine(cfg, "uptime-watch", "T-0901", st);
  await Bun.sleep(0);
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain("uptime-watch");
  expect(sent[0]).toContain("cli:aws");
  parked("T-0902", 40); // a different stuck copy is news again
  A.noteStuckRoutine(cfg, "uptime-watch", "T-0902", st);
  await Bun.sleep(0);
  expect(sent.length).toBe(2);
});

test("read-only routines skip approval at onboarding; others and followups stay gated", () => {
  expect(A.needsApproval(cfg, "routine:uptime-watch")).toBe(false);
  expect(A.needsApproval(cfg, "routine:pr-review")).toBe(true);
  expect(A.needsApproval(cfg, "followup:T-0001")).toBe(true);
  expect(A.needsApproval({ ...cfg, autonomy: { level: "onboarding", auto_routines: ["pr-review"] } }, "routine:pr-review")).toBe(false);
  expect(A.needsApproval(cfg, "routine:daily-report")).toBe(false); // housekeeping unchanged
});

test("ids: non-primary hosts are tagged, primary skips ids taken in any state", () => {
  expect(idTagFor({ fleet: { primary: "pc" } }, "pc")).toBe("");
  expect(idTagFor({ fleet: { primary: "pc" } }, "mac")).toBe("M");
  expect(idTagFor({ fleet: { primary: "pc" }, host: { id_tag: "x" } }, "mac")).toBe("X");

  task("inbox", "T-0068", "owner");
  expect(nextId("T", P("tasks"))).toBe("T-0069");
  setIdTag("M");
  task("done", "T-M0003", "owner");
  expect(nextId("T", P("tasks"))).toBe("T-M0004");
  expect(nextId("D", P("decisions"))).toBe("D-M0001");
});

test("primary: named in the config, else only while no other host has a heartbeat", () => {
  rmSync(P("fleet", "hosts"), { recursive: true, force: true });
  expect(core.isPrimary({ fleet: { primary: "pc" } }, "mac")).toBe(false);
  expect(core.isPrimary({}, "mac")).toBe(true); // alone: a fresh first machine
  core.heartbeat({ host: { name: "pc" } }, 0);
  expect(core.isPrimary({}, "mac")).toBe(false); // another host is here: a worker, never a second primary
  expect(idTagFor({}, "mac")).toBe("M");
  expect(core.isPrimary({}, "pc")).toBe(true); // its own heartbeat does not count
  expect(core.isPrimary({ fleet: { primary: "mac" } }, "mac")).toBe(true);
});

test("per-machine routine (scheduler each): copies on other machines neither block nor get superseded", () => {
  const t = (dir: string, id: string, host: string) => writeDoc(P("tasks", dir, `${id}.md`), { id, host, source: "routine:security-check", created: new Date().toISOString() }, "");
  t("active", "T-0201", "mac");
  t("proposed", "T-0202", "mac");
  expect(A.routineQueued("security-check", "linux")).toBe("");
  expect(A.routineQueued("security-check", "mac")).toBe("T-0201");
  t("proposed", "T-0203", "linux");
  expect(A.supersedeProposed("security-check", "T-0203", "linux")).toEqual([]);
  expect(existsSync(P("tasks", "proposed", "T-0202.md"))).toBe(true);
});

test("built-in routines: every config has security-check (read-only, each machine); config.toml can replace it", async () => {
  const { writeFileSync } = await import("node:fs");
  mkdirSync(P(), { recursive: true });
  writeFileSync(P("config.toml"), "");
  let r = core.loadConfig().routine.find((x: any) => x.name === "security-check");
  expect(r).toMatchObject({ builtin: true, readonly: true, scheduler: "each", every: "weekly MON 09:00" });
  expect(A.needsApproval(core.loadConfig(), "routine:security-check")).toBe(false);
  writeFileSync(P("config.toml"), '[[routine]]\nname = "security-check"\nevery = "daily 08:00"\nagent = "lead"\nprompt = "x"\n');
  r = core.loadConfig().routine.filter((x: any) => x.name === "security-check");
  expect(r).toHaveLength(1);
  expect(r[0].every).toBe("daily 08:00");
  expect(r[0].builtin).toBeUndefined();
  rmSync(P("config.toml"));
});

test("a routine whose copies wait for approval is reported, not silently dead", () => {
  // onboarding lets evolve/daily-report/learn/idle copy run; anything else is batched for the owner
  const first = ago(600);
  task("proposed", "T-0031", "routine:weekly-report", first);
  task("proposed", "T-0032", "routine:weekly-report", ago(120));
  task("proposed", "T-0033", "routine:evolve");      // allowed → not waiting on the owner
  task("proposed", "T-0034", "followup");            // not a routine copy
  const out = A.routinesAwaitingApproval(cfg);
  expect(out.map((r) => r.name)).toEqual(["weekly-report"]);
  expect(out[0].copies).toEqual(["T-0031", "T-0032"]);
  expect(out[0].since).toBe(first); // oldest copy, so the owner sees how long it has been dead
});

test("a read-only or auto routine is never reported as waiting for approval", () => {
  task("proposed", "T-0041", "routine:uptime-watch"); // readonly = true in cfg
  task("proposed", "T-0042", "routine:uptime-watch");
  expect(A.routinesAwaitingApproval(cfg)).toEqual([]);
  const auto = { autonomy: { level: "onboarding", auto_routines: ["uptime-watch"] }, routine: cfg.routine };
  expect(A.routinesAwaitingApproval(auto)).toEqual([]);
});
