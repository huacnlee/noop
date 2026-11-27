// Fleet metrics → fleet/metrics.json; the architect uses them to evolve prompts, rules and memory.
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CODE, P, list, loadConfig, readDoc } from "./core";
import { judgeAccuracy, proposalPicks, routinesAwaitingApproval } from "./autonomy";

// Which code produced these numbers. Twice now a host reported a healthy fleet while the daemon was still running a
// checkout pinned 20+ commits back by local edits, so every fix merged upstream was inert there and every figure below
// was computed by the old formula. `behind_origin` compares against the last fetched `origin/main` (no network here).
export function codeState(root = CODE) {
  // 3 s killed plain `git rev-parse` on a loaded host (load 30+) and the empty output was reported as "no checkout"/unknown
  // drift — it also failed the provenance test well inside its 120 s guard. Leave git room; a missing repo still fails fast.
  const git = (...a: string[]) => {
    try { return Bun.spawnSync(["git", "-C", root, ...a], { stdout: "pipe", stderr: "ignore", timeout: 20_000 }).stdout.toString().trim(); }
    catch { return ""; }
  };
  const commit = git("rev-parse", "--short", "HEAD");
  if (!commit) return null; // no git checkout (source tarball, container image with .git stripped)
  const behind = git("rev-list", "--count", "HEAD..origin/main");
  const dirty = git("status", "--porcelain", "--untracked-files=no").split("\n").filter(Boolean).length;
  return { commit, behind_origin: /^\d+$/.test(behind) ? Number(behind) : null, dirty_files: dirty, origin_fetched_minutes: refAgeMinutes(root) };
}

/** Minutes since this checkout last fetched from origin. `behind_origin` is measured against the local `origin/main`
 *  ref, so on a host that has not fetched for days it reports a six-day-old checkout as current: on 2026-11-23 this
 *  host ran 4c2a3d2 (11-17) with behind_origin 0 while main had moved 52 commits, including the fix that stops a
 *  replaced menu task from being resumed. Without this number "0 commits behind" cannot be told apart from "never
 *  looked". null when the checkout has no fetch record at all (source tarball, shallow clone). */
export function refAgeMinutes(root = CODE): number | null {
  for (const rel of [".git/FETCH_HEAD", ".git/refs/remotes/origin/main"]) {
    try { return Math.max(0, Math.round((Date.now() - statSync(join(root, rel)).mtimeMs) / 60_000)); } catch {}
  }
  return null;
}

function rejectedTaskReason(task: Record<string, string>, batches: Map<string, Record<string, string>>) {
  if (task.cancelled) return "cancelled";
  if (task.approval === "superseded:unrunnable") return "system_unrunnable";
  if (/^superseded:[TD]-[^\s/]+$/.test(task.approval ?? "")) return "system_superseded";
  const batchId = task.approval?.match(/^rejected:(P-[^\s/]+)$/)?.[1];
  const batch = batchId && batches.get(batchId);
  if (!batch || !/^owner(?:\([^)]+\))?$/.test(batch.answered_by ?? "")) return "unclassified";

  const items = (batch.items ?? "").split(",");
  const position = items.indexOf(task.id) + 1;
  const picks = proposalPicks(batch.answer ?? "", items);
  if (!task.id || !position || !picks || picks.has(position)) return "unclassified";
  if (!picks.size) return "owner_batch_none";
  // A reply that refers to a missing slot gives no reliable selection to attribute to the owner.
  for (const pick of picks) if (!items[pick - 1]) return "unclassified";
  return "owner_batch_unselected";
}

export function computeMetrics(days = 7) {
  const since = Date.now() - days * 86400e3;
  const closedCards = list(P("decisions", "closed")).map((p) => readDoc(p).meta);
  const menuReplacements = new Map(closedCards
    .filter((card) => card.kind === "menu" && card.answered_by === "system" && card.superseded_by)
    .map((card) => [card.id, card.superseded_by]));
  const per: Record<string, { done: number; failed: number; blocked: number; minutes: number[] }> = {};
  for (const folder of ["done", "failed", "blocked"] as const)
    for (const p of list(P("tasks", folder), /^T-.*\.md$/)) {
      const { meta: m, body } = readDoc(p);
      if (Date.parse(m.finished ?? m.created) < since) continue;
      // Older refreshes filed the parked menu in done/ and stamped its finish time when the replacement arrived.
      // Check the final note too: a later run can finish real work on a task with the old decision in its history.
      const replacement = menuReplacements.get(m.decision);
      if (folder === "done" && replacement && body.trimEnd().endsWith(`: menu ${m.decision} superseded by ${replacement}; closed without running.`)) continue;
      const a = (per[m.agent || "generalist"] ??= { done: 0, failed: 0, blocked: 0, minutes: [] });
      a[folder]++;
      if (m.started && m.finished) a.minutes.push((Date.parse(m.finished) - Date.parse(m.started)) / 60e3);
    }
  const decisions = closedCards.filter((m) => Date.parse(m.answered ?? "") > since);
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
  const approvals = closedCards.filter((m) => m.kind === "proposals");
  const batches = new Map(approvals.map((m) => [m.id, m]));
  const rejected = list(P("tasks", "rejected"), /^T-.*\.md$/);
  const reasons = { scope: "all_retained_records", system_superseded: 0, system_unrunnable: 0, cancelled: 0,
    owner_batch_none: 0, owner_batch_unselected: 0, unclassified: 0 };
  for (const path of rejected) reasons[rejectedTaskReason(readDoc(path).meta, batches)]++;
  // Shadow scores are cumulative. Keep installed agents visible when their last task ages out of the window.
  const shadowAgents = new Set(Object.keys(per));
  for (const dir of list(P("agents"), /.*/)) {
    if (existsSync(join(dir, "profile.md"))) shadowAgents.add(basename(dir));
  }
  const out = {
    shadow_judge: judgeAccuracy(undefined, closedCards),
    shadow_judge_by_agent: Object.fromEntries(Array.from(shadowAgents, (a) => [a, judgeAccuracy(a, closedCards)])),
    proposal_batches: approvals.length, proposals_rejected_total: rejected.length, rejected_task_reasons: reasons,
    // A routine that fires on schedule but whose copies wait for approval produces nothing; nothing else reports it.
    routines_starved: routinesAwaitingApproval(loadConfig()),
    window_days: days, generated: new Date().toISOString(), code: codeState(), agents,
    decisions: { total: decisions.length, open: openCards.length,
      oldest_open_days: openAges.length ? Math.round((Date.now() - Math.min(...openAges)) / 86400e3) : 0, by_judge: byWho(/^judge/), by_owner: byWho(/^owner\(/), owner_overrides_of_judge: byWho(/override/),
      owner_accepted_recommendation: rubberStamp },
  };
  mkdirSync(P("fleet"), { recursive: true });
  writeFileSync(P("fleet", "metrics.json"), JSON.stringify(out, null, 2));
  return out;
}
