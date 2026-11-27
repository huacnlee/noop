// Graduated autonomy. Start conservative ("onboarding"): self-generated work needs owner approval,
// the judge only shadows. Graduation is proposed by the architect from metrics, decided by the owner.
import { existsSync, unlinkSync } from "node:fs";
import { type Cfg, L, P, fileId, journal, list, nextId, now, readDoc, writeDoc } from "./core";
import { notify } from "./notify";

export type Level = "onboarding" | "assisted" | "autonomous";
/** Global level, optionally overridden per agent ([autonomy.agents] reviewer = "assisted") as trust is earned. */
export const level = (cfg: Cfg, agent?: string): Level =>
  (agent && cfg.autonomy?.agents?.[agent]) || cfg.autonomy?.level || "onboarding";

/** Should a task from this source wait for owner approval? Owner-created & approved work never does. */
export function needsApproval(cfg: Cfg, source: string): boolean {
  if (/^owner|^override|^approved|^decision/.test(source)) return false;
  const l = level(cfg);
  if (l === "autonomous") return false;
  if (l === "assisted") return /^followup/.test(source) && cfg.autonomy?.assisted_approve_followups === true;
  // read-only routines ([[routine]] readonly = true, or [autonomy] auto_routines) only observe; whatever they
  // want changed comes back as followups, which are still gated
  const rn = source.match(/^routine:(.+)$/)?.[1];
  if (rn && ((cfg.autonomy?.auto_routines ?? []).includes(rn) || (cfg.routine ?? []).some((r: any) => r.name === rn && r.readonly === true))) return false;
  // onboarding: everything self-generated, except the hub's own housekeeping
  return !/^idle|^routine:(evolve|triage-inbound|daily-report|learn)/.test(source);
}

const QUEUED = ["inbox", "active", "waiting", "blocked"];
const isRoutine = (m: Record<string, string>, name: string) => (m.source ?? "").replace(/^approved:/, "") === `routine:${name}`;

/** A copy parked by the work-limit checkpoint (src/cli.ts checkpointFallback): its pass is NOT finished — the daemon
 *  resumes it — so it must keep blocking a fresh copy, or the resumed run races one minted meanwhile. */
const isCheckpointWait = (m: Record<string, string>) =>
  m.wait_kind === "ci" && (m.waiting_on ?? "").startsWith("checkpoint saved after the work limit");

/** Id of a copy of this routine that is queued or running (so a new run would be redundant), else "".
 *  `host`: a per-machine routine (scheduler "each") only counts its own machine's copies. */
export function routineQueued(name: string, host?: string): string {
  for (const s of QUEUED) for (const p of list(P("tasks", s), /^T-.*\.md$/)) {
    const m = readDoc(p).meta;
    if (!isRoutine(m, name) || (host && m.host !== host)) continue;
    // a copy parked on something slow (CI, the owner clicking merge) has finished its pass: the next run must still
    // pick up new PRs/issues instead of the backlog piling up behind it. A work-limit checkpoint is the exception:
    // it resumes, so minting now gives the same routine two concurrent runs (T-2270 + T-2274, 2026-11-21).
    if ((s === "waiting" || s === "blocked") && !isCheckpointWait(m)) continue;
    return m.id;
  }
  return "";
}

/** Id of a copy of this routine parked on an unanswered decision, else "".
 *  Such a copy already asked the only question every later run would ask again: until the owner answers, a new run can
 *  only repeat the same report (routine `skip_while_decision_open = true`). Waits on CI or a merge do not count.
 *  `host`: a per-machine routine (scheduler "each") only counts its own machine's copies. */
export function routineParkedOnDecision(name: string, host?: string): string {
  const open = (id: string) => /^D-\d+$/.test(id) && existsSync(P("decisions", "open", `${id}.md`));
  for (const p of list(P("tasks", "waiting"), /^T-.*\.md$/)) {
    const m = readDoc(p).meta;
    if (!isRoutine(m, name) || (host && m.host !== host)) continue;
    if ((m.wait_kind ?? "human") !== "human") continue;
    // the card path, not a bare id: a wait on a PR that merely mentions "D-0004" must not silence the routine
    const id = (m.waiting_on ?? "").match(/decisions\/open\/(D-\d+)\.md/)?.[1];
    if (id && open(id)) return m.id;
  }
  // the standard path: a run that returns needs_decision is parked in tasks/blocked with meta.decision (src/cli.ts,
  // src/supervisor.ts). Most routine copies ask the owner this way, so waiting-only left the flag doing nothing for them.
  for (const p of list(P("tasks", "blocked"), /^T-.*\.md$/)) {
    const m = readDoc(p).meta;
    if (!isRoutine(m, name) || (host && m.host !== host)) continue;
    if (open(m.decision ?? "")) return m.id;
  }
  return "";
}

/** A routine skipped behind a copy no online host can run (parked in the inbox) for 30+ minutes: tell the owner once per copy.
 *  The skips only reach the journal and the stall supervisor only sees waiting/blocked tasks, so such a copy silences the routine. */
export function noteStuckRoutine(cfg: Cfg, name: string, id: string, state: Record<string, string>) {
  const key = `${name}#stuck`, f = P("tasks", "inbox", `${id}.md`);
  if (state[key] === id || !existsSync(f)) return; // running, waiting and card tasks are progress, not a stuck copy
  const m = readDoc(f).meta;
  const mins = Math.floor((Date.now() - Date.parse(m.parked ?? "")) / 60_000);
  if (!(mins >= 30)) return; // not parked (NaN), or parked only briefly
  state[key] = id;
  void notify(`例行任务 ${name} 已经 ${mins} 分钟没有新的一轮：上一次的 ${id} 在等一台满足 ${m.requires} 的在线主机，之后每轮都被跳过。`, cfg, { kind: "notice", ref: id });
}

/** Routines that fire on schedule but can only start once the owner approves a batch: their copies wait in
 *  tasks/proposed. In config.toml such a routine looks healthy and the scheduler really does mint a copy every
 *  period, so nothing anywhere says it never produced anything — an owner who does not answer cards gets a dead
 *  routine that reads as a working one (`weekly-report` / `workflow-coach` under onboarding, 2026-11-20). */
export function routinesAwaitingApproval(cfg: Cfg): { name: string; copies: string[]; since: string }[] {
  const out = new Map<string, { name: string; copies: string[]; since: number }>();
  for (const p of list(P("tasks", "proposed"), /^T-.*\.md$/)) {
    const m = readDoc(p).meta;
    const source = m.source ?? "";
    const name = source.match(/^routine:(.+)$/)?.[1];
    if (!name || !needsApproval(cfg, source)) continue; // runs without approval, or not a routine copy
    // The routine itself may have been removed from config.toml (its copies then sit in tasks/proposed for good).
    // Nothing will ever mint or approve it again, so it is a leftover, not a routine waiting on the owner.
    if (!(cfg.routine ?? []).some((r: any) => r.name === name)) continue;
    const created = Date.parse(m.created ?? "");
    const e = out.get(name) ?? { name, copies: [], since: Number.isNaN(created) ? Date.now() : created };
    e.copies.push(m.id);
    if (!Number.isNaN(created)) e.since = Math.min(e.since, created);
    out.set(name, e);
  }
  return [...out.values()]
    .map((e) => ({ name: e.name, copies: e.copies, since: new Date(e.since).toISOString() }))
    .sort((a, b) => a.since.localeCompare(b.since));
}

/** A copy waiting for approval whose own requirements no known host meets can never run: approving it only moves
 *  it into the inbox, where retireUnrunnableCopy discards it one tick later. After #288 the scheduler stops minting
 *  new copies of such a routine, so `supersedeProposed` never fires either and the copy sits in tasks/proposed for
 *  good — keeping `routines_starved` red (pr-review T-2264 since 2026-11-20) and able to surface in an approval
 *  batch as an option that cannot run. Retire it at the routine's next due tick, exactly like the inbox copy. */
export function retireUnrunnableProposed(name: string, missing: (reqs: string[]) => string): { id: string; why: string }[] {
  const out: { id: string; why: string }[] = [];
  for (const p of list(P("tasks", "proposed"), /^T-.*\.md$/)) {
    const { meta, body } = readDoc(p);
    if (!isRoutine(meta, name) || meta.id !== fileId(p)) continue;
    const pin = meta.host && meta.host !== "any" ? `host:${meta.host}` : "";
    const why = missing([...(meta.requires ?? "").split(","), pin].map((s) => s.trim()).filter(Boolean));
    if (!why) continue;
    writeDoc(P("tasks", "rejected", `${meta.id}.md`), { ...meta, approval: "superseded:unrunnable" }, body + `\n\n## Note\nno known host has ${why}\n`);
    unlinkSync(p);
    out.push({ id: meta.id, why });
  }
  return out;
}

/** A newer run of a routine replaces its older unapproved copies: move them to rejected with a note. */
export function supersedeProposed(name: string, newId: string, host?: string): string[] {
  const out: string[] = [];
  for (const p of list(P("tasks", "proposed"), /^T-.*\.md$/)) {
    const { meta, body } = readDoc(p);
    if (meta.id === newId || !isRoutine(meta, name) || (host && meta.host !== host)) continue;
    writeDoc(P("tasks", "rejected", `${meta.id}.md`), { ...meta, approval: `superseded:${newId}` }, body + `\n\n## Note\nsuperseded by ${newId}\n`);
    unlinkSync(p);
    out.push(meta.id);
  }
  return out;
}

/** A copy waiting in the inbox for a capability no known host has never starts, and while it waits every later run is
 *  skipped as "still queued", so editing the routine's `requires` never takes effect (own-prs-ci T-0406 asked for
 *  cli:git, which no host reports, and held the routine from 2026-11-10 on). Retires such a copy to tasks/rejected
 *  and returns the missing capability, else "". `missing` returns the first requirement no known host meets. */
export function retireUnrunnableCopy(id: string, missing: (reqs: string[]) => string): string {
  const f = P("tasks", "inbox", `${id}.md`);
  if (!existsSync(f)) return "";
  const { meta, body } = readDoc(f);
  const pin = meta.host && meta.host !== "any" ? `host:${meta.host}` : "";
  const why = missing([...(meta.requires ?? "").split(","), pin].map((s) => s.trim()).filter(Boolean));
  if (!why) return "";
  writeDoc(P("tasks", "rejected", `${id}.md`), { ...meta, approval: "superseded:unrunnable" }, body + `\n\n## Note\nno known host has ${why}\n`);
  unlinkSync(f);
  return why;
}

/** Judge may only auto-decide outside onboarding. */
export const judgeMayDecide = (cfg: Cfg, agent?: string) => level(cfg, agent) !== "onboarding";

/** Batch tasks/proposed into one numbered approval message. */
export async function proposeBatch(cfg: Cfg, host: string) {
  // only real task files: an agent appending a note to a task's old path leaves a stub without frontmatter,
  // which would show as "undefined（undefined）" and, never matching the batch, rebuild it on every tick
  const all = list(P("tasks", "proposed"), /^T-.*\.md$/).filter((p) => readDoc(p).meta.id === fileId(p));
  const openPath = list(P("decisions", "open")).find((p) => readDoc(p).meta.kind === "proposals");
  const listed = openPath ? (readDoc(openPath).meta.items ?? "").split(",").filter(Boolean) : [];
  // An unanswered batch must not hide later work: a proposal the owner has not been shown yet goes before one
  // he already saw and left unanswered, so a rebuild surfaces new tasks instead of re-offering the same nine
  // forever. Priority breaks ties, then path order, so the oldest of a group is still first.
  const offered = new Set(listed);
  const meta_ = new Map(all.map((p) => [p, readDoc(p).meta])); // one read per file, not one per comparator call
  const rank = (p: string): [number, number] => {
    const m = meta_.get(p)!;
    return [offered.has(m.id) ? 1 : 0, m.priority === "high" ? 0 : m.priority === "low" ? 2 : 1];
  };
  const items = [...all].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || a.localeCompare(b);
  }).slice(0, 9);
  const itemIds = items.map((p) => meta_.get(p)!.id);
  if (openPath) {
    // An unanswered batch must not block later work forever: rebuild it when it went stale
    // (its tasks left tasks/proposed) or new proposals arrived, but notify at most every few hours.
    const { meta } = readDoc(openPath);
    // judged against every proposed task, not against the nine above: once an unanswered batch is rebuilt
    // with newer items, an older one can drop out of the slice without having been acted on
    const proposed = new Set(all.map((p) => meta_.get(p)!.id));
    const stale = listed.some((t) => !proposed.has(t));
    // Only proposals that arrived after this batch went out make it fresh. Measuring against every proposed task
    // meant a backlog larger than nine rebuilt the menu on every renotify window forever (26 proposals → a new
    // menu every 3h, even when nothing arrived), which is the noise this batch is meant to remove.
    const since = Date.parse(meta.created ?? meta.notified ?? "");
    const arrived = all.some((p) => {
      const m = meta_.get(p)!;
      if (listed.includes(m.id)) return false;
      const created = Date.parse(m.created ?? "");
      return Number.isNaN(created) || Number.isNaN(since) || created >= since;
    });
    // Proposals older than the batch that never made the nine still get their turn, just daily rather than
    // every renotify window, so an ignored backlog rotates without re-notifying the owner all day.
    const unseen = [...proposed].some((t) => !listed.includes(t));
    if (!stale && !arrived && !unseen) return;
    const alive = listed.some((t) => proposed.has(t));
    const waitHours = stale || arrived ? (cfg.autonomy?.renotify_hours ?? 3) : (cfg.autonomy?.rotate_hours ?? 24);
    const age = Date.now() - Date.parse(meta.notified ?? meta.created);
    if (alive && age < waitHours * 3600_000) return;
    closeBatch(openPath, itemIds.length ? "superseded (rebuilt)" : "superseded (nothing left)");
    if (!itemIds.length) return;
  } else {
    if (!items.length) return;
    const oldest = Math.min(...items.map((p) => Date.parse(meta_.get(p)!.created)));
    const batchWait = (cfg.autonomy?.batch_minutes ?? 15) * 60_000;
    if (Date.now() - oldest < batchWait && items.length < 5) return; // let a few accumulate
  }
  const id = nextId("P", P("decisions"));
  const lines = items.map((p, i) => {
    const m = readDoc(p).meta;
    return `${i + 1}. ${m.title}（${m.agent}）`;
  });
  writeDoc(P("decisions", "open", `${id}.md`), {
    id, kind: "proposals", created: now(), notified: now(), host, items: itemIds.join(","),
    question: L("Which of these should go ahead?", "要做哪几项？"),
  }, L(`## To confirm\n${lines.join("\n")}\n`, `## 待确认\n${lines.join("\n")}\n`));
  await notify([L(`*${id}* would like to do the following, please confirm:`, `*${id}* 想做这几件事，请确认：`), ...lines,
    L(`Reply \`${id} 1,3\`, \`${id} all\` (do all) or \`${id} none\` (do none)`, `回复 \`${id} 1,3\`、\`${id} all\`（全做）或 \`${id} none\`（都不做）`)].join("\n"), cfg,
    { kind: "proposals", ref: id, options: ["all", "none", ...lines.map((_, i) => String(i + 1))] });
  journal(host, `${id} asked owner to approve ${items.length} proposed tasks`);
}

/** Close an unanswered proposals batch without touching its tasks (they stay in tasks/proposed). */
function closeBatch(path: string, answer: string) {
  const { meta, body } = readDoc(path);
  writeDoc(P("decisions", "closed", `${meta.id}.md`), { ...meta, answer, answered_by: "system", answered: now() }, body + `\n## Answer\n${answer}\n`);
  unlinkSync(path);
}

/** One-based selections in a batch reply. An empty set represents an explicit "none". */
export function proposalPicks(answer: string, items: string[]) {
  const a = answer.trim().toLowerCase();
  // words without a pick are not "none": keep the card open rather than reject every item.
  // numbers count only when nothing but a colon follows them: "1、不做 2、做" or "1 no 2 yes" are words, not a pick of 1
  if (!/^(all|none)\b|^\d[\d,\s，]*($|[:：])/.test(a)) return undefined;
  return new Set<number>(a.startsWith("all") ? items.map((_, i) => i + 1)
    : a.startsWith("none") ? [] : (a.match(/^[\d,\s，]+/)?.[0] ?? "").split(/[,，\s]+/).filter(Boolean).map(Number));
}

/** Owner's answer to a proposals batch: approve picked ones, reject the rest (rejections are a learning signal). */
export function resolveProposals(id: string, answer: string, by: string): boolean {
  const f = P("decisions", "open", `${id}.md`);
  if (!existsSync(f)) return false;
  const { meta, body } = readDoc(f);
  // keep empty slots: card line n is items[n-1], so dropping an empty id would shift every later pick by one
  const ids = (meta.items ?? "").split(",");
  const picked = proposalPicks(answer, ids);
  if (!picked) return false;
  const note = answer.replace(/^([\d,\s，]+|all|none)\s*[:：]?/i, "").trim(); // "1,3: 2 waits" picks 1 and 3, the rest is the note
  ids.forEach((tid, i) => {
    const p = P("tasks", "proposed", `${tid}.md`);
    if (!tid || !existsSync(p)) return;
    const { meta: tm, body: tb } = readDoc(p);
    const ok = picked.has(i + 1);
    writeDoc(P("tasks", ok ? "inbox" : "rejected", `${tid}.md`), { ...tm, source: ok ? `approved:${tm.source}` : tm.source, approval: ok ? id : `rejected:${id}` },
      tb + (note && ok ? `\n\n## Owner note (${id})\n${note}\n` : ""));
    unlinkSync(p);
  });
  writeDoc(P("decisions", "closed", `${id}.md`), { ...meta, answer, answered_by: by, answered: now() }, body + `\n## Answer\n${answer}\n`);
  unlinkSync(f);
  return true;
}

/** Shadow-judge accuracy: how often the judge's would-be answer matched the owner's. */
export function judgeAccuracy(agent?: string, closedCards = list(P("decisions", "closed")).map((p) => readDoc(p).meta)) {
  const rows = closedCards.filter((m) => m.shadow_verdict && /^owner/.test(m.answered_by ?? "") && (!agent || m.agent === agent));
  // every owner-answered decision the judge also answered counts (held ones too): shadow_agree is set by closeDecision
  const scored = rows.filter((m) => m.shadow_agree === "yes" || m.shadow_agree === "no");
  const agree = scored.filter((m) => m.shadow_agree === "yes");
  const decided = rows.filter((m) => m.shadow_verdict === "decided");
  return { samples: rows.length, would_decide: decided.length, scored: scored.length, agreed: agree.length,
    accuracy: scored.length ? +(agree.length / scored.length).toFixed(2) : null };
}
