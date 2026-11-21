// Fleet metrics → fleet/metrics.json; the architect uses them to evolve prompts, rules and memory.
import { mkdirSync, writeFileSync } from "node:fs";
import { CODE, P, list, readDoc } from "./core";
import { judgeAccuracy } from "./autonomy";

// Which code produced these numbers. Twice now a host reported a healthy fleet while the daemon was still running a
// checkout pinned 20+ commits back by local edits, so every fix merged upstream was inert there and every figure below
// was computed by the old formula. `behind_origin` compares against the last fetched `origin/main` (no network here).
export function codeState(root = CODE) {
  const git = (...a: string[]) => {
    try { return Bun.spawnSync(["git", "-C", root, ...a], { stdout: "pipe", stderr: "ignore", timeout: 3000 }).stdout.toString().trim(); }
    catch { return ""; }
  };
  const commit = git("rev-parse", "--short", "HEAD");
  if (!commit) return null; // no git checkout (source tarball, container image with .git stripped)
  const behind = git("rev-list", "--count", "HEAD..origin/main");
  const dirty = git("status", "--porcelain", "--untracked-files=no").split("\n").filter(Boolean).length;
  return { commit, behind_origin: /^\d+$/.test(behind) ? Number(behind) : null, dirty_files: dirty };
}

export function computeMetrics(days = 7) {
  const since = Date.now() - days * 86400e3;
  const per: Record<string, { done: number; failed: number; blocked: number; minutes: number[] }> = {};
  for (const folder of ["done", "failed", "blocked"] as const)
    for (const p of list(P("tasks", folder), /^T-.*\.md$/)) {
      const m = readDoc(p).meta;
      if (Date.parse(m.finished ?? m.created) < since) continue;
      const a = (per[m.agent || "generalist"] ??= { done: 0, failed: 0, blocked: 0, minutes: [] });
      a[folder]++;
      if (m.started && m.finished) a.minutes.push((Date.parse(m.finished) - Date.parse(m.started)) / 60e3);
    }
  const decisions = list(P("decisions", "closed")).map((p) => readDoc(p).meta).filter((m) => Date.parse(m.answered ?? "") > since);
  // Cards still waiting on the owner are this fleet's main failure mode, and counting only decisions/closed made them
  // invisible: 14 open cards and 0 answers reported as decisions.total = 0, i.e. as nothing at all.
  const openCards = list(P("decisions", "open"), /^D-.*\.md$/).map((p) => readDoc(p).meta);
  const openAges = openCards.map((m) => Date.parse(m.created ?? "")).filter((t) => !Number.isNaN(t));
  const byWho = (re: RegExp) => decisions.filter((m) => re.test(m.answered_by ?? "")).length;
  // owner answering the same agent's questions with the recommended option → candidate for auto-approval
  const rubberStamp: Record<string, number> = {};
  for (const m of decisions) if (/^owner/.test(m.answered_by) && m.recommendation && m.answer?.trim().startsWith(m.recommendation.trim()))
    rubberStamp[m.agent] = (rubberStamp[m.agent] ?? 0) + 1;
  const agents = Object.fromEntries(Object.entries(per).map(([k, v]) => {
    const n = v.done + v.failed + v.blocked;
    const med = v.minutes.sort((a, b) => a - b)[Math.floor(v.minutes.length / 2)] ?? 0;
    // blocked/ holds tasks parked on the owner's decision (needs_decision), not agent failures: a menu that ends in a
    // question is doing its job, so counting those as failures reads as 0.00 success for the agents that ask the most.
    const judged = v.done + v.failed;
    return [k, { runs: n, success: judged ? +(v.done / judged).toFixed(2) : null, failed: v.failed, blocked: v.blocked, median_minutes: Math.round(med) }];
  }));
  const approvals = list(P("decisions", "closed")).map((p) => readDoc(p).meta).filter((m) => m.kind === "proposals");
  const rejected = list(P("tasks", "rejected"), /^T-.*\.md$/).length;
  const out = {
    shadow_judge: judgeAccuracy(),
    shadow_judge_by_agent: Object.fromEntries(Object.keys(per).map((a) => [a, judgeAccuracy(a)])), proposal_batches: approvals.length, proposals_rejected_total: rejected,
    window_days: days, generated: new Date().toISOString(), code: codeState(), agents,
    decisions: { total: decisions.length, open: openCards.length,
      oldest_open_days: openAges.length ? Math.round((Date.now() - Math.min(...openAges)) / 86400e3) : 0, by_judge: byWho(/^judge/), by_owner: byWho(/^owner\(/), owner_overrides_of_judge: byWho(/override/),
      owner_accepted_recommendation: rubberStamp },
  };
  mkdirSync(P("fleet"), { recursive: true });
  writeFileSync(P("fleet", "metrics.json"), JSON.stringify(out, null, 2));
  return out;
}
