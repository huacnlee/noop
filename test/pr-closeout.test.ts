import { expect, test } from "bun:test";
import { type PR, type Evidence, discover, plan, green, cleanReview, order, enqueueCards } from "../src/pr-closeout";
const sha = "abcdef0123456789abcdef0123456789abcdef01";
const make = (number = 1, overrides: Partial<PR> = {}): PR => ({
  number, repo: "owner/app", title: `change ${number}`, url: `https://github.com/owner/app/pull/${number}`,
  state: "OPEN", isDraft: true, headRefName: `agent/pr-${number}`, headRefOid: sha,
  baseRefName: "main", baseRefOid: "1111111111111111111111111111111111111111", defaultBranch: "main", commitCount: 2,
  checks: { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
  ] } }, ...overrides,
});
const review = (text = "", head = sha.slice(0, 7)): Evidence => ({ task: "T-0001", report: "/hub/reports/T-0001-second-review.md",
  text: `# Log\n\n## Round 1 — codex reviews claude (2026-11-10)\n\nRepo: \`app\` · scope: base origin/main · HEAD \`${head}\`\n\nVERDICT: CLEAN\n${text}` });
const ev = (prs: PR[]) => Object.fromEntries(prs.map((p) => [p.url, [review()]]));

test("one card per repo, parents first, ready parent included, owner approval required", () => {
  const parent = make(1, { isDraft: false });
  const child = make(2, { baseRefName: parent.headRefName });
  const { cards } = plan([child, parent], ev([child, parent]), []);
  expect(cards).toHaveLength(1);
  expect(cards[0].prs.map((p) => p.number)).toEqual([1, 2]);
  expect(cards[0].result.status).toBe("needs_decision");
  expect(cards[0].result.question).toContain("合并");
  expect(cards[0].body).toContain("explicit OWNER");
  expect(cards[0].body).toContain("owner option B or an ignored/skipped decision: return done");
});

test("CI fails closed for absent, pending, failed, skipped, neutral, cancelled and truncated checks", () => {
  expect(green(make())).toBe(true);
  expect(green(make(1, { checks: null }))).toBe(false);
  for (const conclusion of ["FAILURE", "SKIPPED", "NEUTRAL", "CANCELLED", "TIMED_OUT", null]) {
    const p = make(); p.checks!.contexts.nodes[0].conclusion = conclusion;
    expect(plan([p], ev([p]), []).cards).toHaveLength(0);
  }
  for (const state of ["PENDING", "FAILURE", "ERROR"]) { const p = make(); p.checks!.state = state; expect(green(p)).toBe(false); }
  const pending = make(); pending.checks!.contexts.nodes[0].status = "IN_PROGRESS"; expect(green(pending)).toBe(false);
  const truncated = make(); truncated.checks!.contexts.pageInfo.hasNextPage = true; expect(green(truncated)).toBe(false);
  const absent = make(); absent.checks!.contexts.nodes = []; expect(green(absent)).toBe(false);
});

test("latest cross-model full-PR review must be clean at this head, no unresolved findings", () => {
  expect(cleanReview(make(), [review()])).toBeDefined();
  for (const e of [review("", "1234567"), review("\n## Attempt failed — reason: quota\n"), review("\n## Round 2 — codex reviews claude (now)\nVERDICT: FINDINGS 1\n"), review("- Not fixed: issue\n")]) {
    expect(cleanReview(make(), [e])).toBeUndefined();
  }
  for (const [from, to] of [["codex reviews claude", "codex reviews codex"], ["scope: base origin/main", "scope: uncommitted "], ["scope: base origin/main", `scope: commit ${sha}`]]) {
    const e = review(); e.text = e.text.replace(from, to); expect(cleanReview(make(), [e])).toBeUndefined();
  }
  const one = review(); one.text = one.text.replace("base origin/main", `commit ${sha}`);
  expect(cleanReview(make(1, { commitCount: 1 }), [one])).toBeDefined();
});

test("missing/cyclic dependencies or one bad PR block the whole repository", () => {
  expect(order([make(1, { baseRefName: "missing" })])).toBeUndefined();
  const p = make(1, { baseRefName: "agent/pr-2" }), q = make(2, { baseRefName: "agent/pr-1" });
  expect(order([p, q])).toBeUndefined();
  const a = make(), b = make(2, { checks: null });
  expect(plan([a, b], ev([a, b]), []).cards).toHaveLength(0);
});

test("dedupe pending releases by repo, exact prior snapshot by key; changed head is a new card", () => {
  const p = make(); const c = plan([p], ev([p]), []).cards[0];
  expect(plan([p], ev([p]), [{ meta: { closeout_key: c.key }, body: "" }]).cards).toHaveLength(0);
  expect(plan([p], ev([p]), [{ meta: { closeout_active: "yes", title: "app：合并并发版" }, body: "" }]).cards).toHaveLength(0);
  expect(plan([p], ev([p]), [{ meta: { closeout_active: "yes", title: "merge", closeout_repo: p.repo }, body: "" }]).cards).toHaveLength(0);
  const changed = make(1, { headRefOid: "1234567890abcdef1234567890abcdef12345678" });
  const evidence = { [changed.url]: [review("", changed.headRefOid)] };
  expect(plan([changed], evidence, [{ meta: { closeout_key: c.key }, body: "" }]).cards).toHaveLength(1);
});

test("discovery uses exactly one search and one GraphQL query, rejects partial responses", () => {
  const calls: string[][] = [];
  const p = make();
  const run = (args: string[]) => {
    calls.push(args);
    return calls.length === 1 ? [{ number: 1, isDraft: true, repository: { nameWithOwner: "owner/app" } }] : {
      data: { p0: { defaultBranchRef: { name: "main" }, pullRequest: { ...p,
        commits: { totalCount: 2, nodes: [{ commit: { statusCheckRollup: p.checks } }] } } } },
    };
  };
  expect(discover("owner", run)).toHaveLength(1);
  expect(calls.map((a) => a.slice(0, 2))).toEqual([["search", "prs"], ["api", "graphql"]]);
  expect(() => discover("bad/owner", run)).toThrow();
  let count = 0;
  expect(() => discover("owner", (a) => ++count === 1 ? [{ number: 1, isDraft: true, repository: { nameWithOwner: "owner/app" } }] : { errors: ["failed"] })).toThrow();
});


test("enqueue creates native owner cards and blocked tasks; rejecting/ignoring cannot grant approval", () => {
  const p = make(); const c = plan([p], ev([p]), []).cards[0];
  const cfg = { owner: { github: "owner" }, routine: [{ name: "pr-closeout", kind: "pr-closeout", readonly: true }] };
  expect(() => enqueueCards([c], {})).toThrow();
  const { P, writeDoc, readDoc } = require("../src/core");
  const { existsSync, unlinkSync } = require("node:fs");
  const { isMergeCard } = require("../src/waits");
  const { ignoreDecision } = require("../src/decisions");
  writeDoc(P("policies", "pr-closeout.md"), {}, "policy");
  const [pair] = enqueueCards([c], cfg);
  const d = readDoc(P("decisions", "open", `${pair.decision}.md`));
  expect(isMergeCard(d.meta)).toBe(true);
  expect(existsSync(P("tasks", "blocked", `${pair.task}.md`))).toBe(true);
  expect(readDoc(P("tasks", "blocked", `${pair.task}.md`)).meta.gate_override).toBeUndefined();
  ignoreDecision(pair.decision, "owner(chat)");
  expect(existsSync(P("tasks", "inbox", `${pair.task}.md`))).toBe(false);
  const finished = readDoc(P("tasks", "done", `${pair.task}.md`));
  expect(finished.meta.gate_override).toBeUndefined();
  expect(finished.meta.finished).toBeDefined();
  expect(finished.meta.closeout_key).toBe(c.key);
  expect(plan([p], ev([p]), [{ ...finished, meta: { ...finished.meta, closeout_active: "no" } }]).cards).toHaveLength(0);
  // Cleanup only this test's own artifacts; core's test data is shared across files.
  unlinkSync(P("tasks", "done", `${pair.task}.md`));
  unlinkSync(P("decisions", "closed", `${pair.decision}.md`));
  unlinkSync(P("policies", "pr-closeout.md"));
});


test("English closeout cards and skip reasons follow the fleet language and keep the merge guard", () => {
  const { P } = require("../src/core");
  const { existsSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
  const config = P("config.local.toml");
  const before = existsSync(config) ? readFileSync(config) : undefined;
  try {
    writeFileSync(config, '[owner]\nlanguage = "en"\n');
    const p = make();
    const card = plan([p], ev([p]), []).cards[0];
    expect(card.result.summary).toContain("merge in order");
    expect(card.result.question).toContain("merge");
    expect(card.result.options[0]).toContain("Merge and patch");
    expect(card.result.options[1]).toContain("Defer");
    expect(plan([make(1, { checks: null })], {}, []).skipped[0].reason).toContain("CI is missing");
    const { isMergeCard } = require("../src/waits");
    expect(isMergeCard({ question: card.result.question })).toBe(true);
  } finally {
    if (before) writeFileSync(config, before); else rmSync(config, { force: true });
  }
});
