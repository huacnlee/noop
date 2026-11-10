// Optional, read-only PR closeout discovery. Only creates owner-decision tasks, never changes GitHub or git.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { openDecision } from "./decisions";
import { type Cfg, L, P, list, newTask, readDoc, writeDoc, hostName } from "./core";

export type PR = {
  number: number; title: string; url: string; repo: string; isDraft: boolean; isCrossRepository: boolean; state: string;
  headRefName: string; headRefOid: string; baseRefName: string; baseRefOid: string; defaultBranch: string;
  checks: { state: string; contexts: { nodes: any[]; pageInfo: { hasNextPage: boolean } } } | null;
  commitCount: number;
};
export type Evidence = { task: string; report: string; text: string };
export type Record = { meta: { [key: string]: string }; body: string };
export type Card = { repo: string; key: string; prs: (PR & { review: string })[]; result: any; body: string };
const slug = /^[\w.-]+\/[\w.-]+$/;
const gh = (args: string[]) => {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: 5_000, maxBuffer: 16 << 20 });
  if (r.error || r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (${(r.error as NodeJS.ErrnoException)?.code === "ETIMEDOUT" ? "timeout after 5 seconds" : r.status ?? r.error?.message})`);
  return JSON.parse(r.stdout);
};

export function discover(owner: string, run = gh): PR[] {
  if (!/^[\w-]+$/.test(owner)) throw new Error("configure owner.github before enabling pr-closeout");
  // One listing for the whole owner, then ONE batched GraphQL query. No per-PR REST loop.
  const found = run(["search", "prs", "--owner", owner, "--state", "open", "--limit", "100",
    "--json", "number,repository,url,isDraft"]);
  if (!Array.isArray(found) || found.length >= 100) throw new Error("PR search invalid or reached the 100-result safety cap; refusing partial cards");
  const repos = new Set(found.filter((p: any) => p.isDraft).map((p: any) => p.repository.nameWithOwner));
  const candidates = found.filter((p: any) => repos.has(p.repository.nameWithOwner));
  if (!candidates.length) return [];
  const fields = candidates.map((p: any, i: number) => {
    const repo = p.repository.nameWithOwner;
    if (!slug.test(repo) || repo.split("/")[0].toLowerCase() !== owner.toLowerCase() || !Number.isInteger(p.number)) throw new Error("invalid PR identity");
    const [o, n] = repo.split("/");
    return `p${i}:repository(owner:${JSON.stringify(o)},name:${JSON.stringify(n)}){defaultBranchRef{name} pullRequest(number:${p.number}){
      number title url isDraft isCrossRepository state headRefName headRefOid baseRefName baseRefOid commits(last:1){totalCount nodes{commit{statusCheckRollup{
        state contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{status conclusion} ... on StatusContext{state}}}
      }}}}}}`;
  });
  const batch = run(["api", "graphql", "-f", `query=query{${fields.join("\n")}}`]);
  if (batch.errors?.length) throw new Error("GraphQL returned errors; refusing partial cards");
  return candidates.map((_: any, i: number) => {
    const r = batch.data?.[`p${i}`], p = r?.pullRequest;
    if (!p) throw new Error("PR disappeared from GraphQL; retry next scan");
    return { ...p, repo: candidates[i].repository.nameWithOwner, defaultBranch: r.defaultBranchRef?.name,
      checks: p.commits.nodes[0]?.commit.statusCheckRollup ?? null, commitCount: p.commits.totalCount };
  });
}

export function green(p: PR): boolean {
  const c = p.checks?.contexts;
  return p.checks?.state === "SUCCESS" && !!c?.nodes.length && !c.pageInfo.hasNextPage && c.nodes.every((n: any) =>
    n.__typename === "CheckRun" ? n.status === "COMPLETED" && n.conclusion === "SUCCESS" : n.__typename === "StatusContext" && n.state === "SUCCESS");
}

export function cleanReview(p: PR, evidence: Evidence[]): string | undefined {
  for (const e of evidence) {
    const sections = e.text.split(/^## /m).slice(1);
    const last = sections.at(-1) ?? "";
    if (!/^Round \d+ — (codex reviews claude|claude reviews codex) \(/.test(last)) continue;
    const verdicts = [...last.matchAll(/^VERDICT: (CLEAN|FINDINGS\s+\d+)\s*$/gm)];
    const head = last.match(/· HEAD `([a-f0-9]{7,40})`/)?.[1];
    const scope = last.match(/· scope: (base|commit|uncommitted) ([^\n]*?) · HEAD/);
    if (verdicts.length !== 1 || verdicts[0][1] !== "CLEAN" || !head || !p.headRefOid.startsWith(head)) continue;
    if (scope?.[1] !== "base" && !(scope?.[1] === "commit" && p.commitCount === 1 && p.headRefOid.startsWith(scope[2].trim()))) continue;
    // Matching the head alone is insufficient: an incremental fix-only review is not a full-PR review.
    if (scope?.[1] === "base" && ![p.baseRefName, `origin/${p.baseRefName}`, p.baseRefOid].includes(scope[2].trim())) continue;
    // A documented unresolved finding is not a clean hand-off, even when the reviewer printed CLEAN.
    if (/^- Not fixed:/m.test(e.text)) continue;
    return e.report;
  }
}

export function order(prs: PR[]): PR[] | undefined {
  const result: PR[] = [], visiting = new Set<PR>();
  const visit = (p: PR): boolean => {
    if (result.includes(p)) return true;
    if (visiting.has(p)) return false;
    visiting.add(p);
    if (p.baseRefName !== p.defaultBranch) {
      const parents = prs.filter((q) => q.repo === p.repo && !q.isCrossRepository && q.headRefName === p.baseRefName);
      if (parents.length !== 1 || !visit(parents[0])) return false;
    }
    visiting.delete(p); result.push(p); return true;
  };
  return prs.every(visit) ? result : undefined;
}

export function plan(prs: PR[], evidence: { [url: string]: Evidence[] }, records: Record[]) {
  const cards: Card[] = [], skipped: { repo: string; reason: string }[] = [];
  for (const repo of [...new Set(prs.filter((p) => p.isDraft && p.state === "OPEN").map((p) => p.repo))].sort()) {
    let group = prs.filter((p) => p.repo === repo && p.isDraft && p.state === "OPEN");
    // Include an already-ready parent when a Draft is stacked on it.
    for (let i = 0; i < group.length; i++) {
      const p = group[i];
      if (p.baseRefName !== p.defaultBranch) {
        const parent = prs.find((q) => q.repo === repo && q.state === "OPEN" && !q.isCrossRepository && q.headRefName === p.baseRefName);
        if (parent && !group.includes(parent)) group.push(parent);
      }
    }
    const ordered = order(group);
    const key = createHash("sha256").update(JSON.stringify(group.map((p) => [p.url, p.headRefOid, p.baseRefName]).sort())).digest("hex");
    let reason = !ordered ? L("Missing or cyclic dependencies", "依赖缺失或循环") : group.some((p) => !green(p)) ? L("CI is missing, incomplete or not all successful", "CI 缺失、未完成或未全部成功") : "";
    const reviews = new Map(group.map((p) => [p.url, cleanReview(p, evidence[p.url] ?? [])]));
    if (!reason && group.some((p) => !reviews.get(p.url))) reason = L("Missing a clean full-PR cross-model review at the current HEAD", "缺少当前 HEAD 的完整 clean 二次 review");
    const busy = records.some((r) => r.meta.closeout_key === key ||
      (r.meta.closeout_active === "yes" && (r.meta.closeout_repo === repo ||
        (/(合并|merge|发版|发布|release|收尾)/i.test(r.meta.title ?? "") && (group.some((p) => hasURL(r.body, p.url)) || (r.meta.title ?? "").includes(repo.split("/")[1]))))));
    if (!reason && busy) reason = L("This repository has pending closeout work or this snapshot was already handled/deferred", "已有同仓库收尾任务或本批次已处理/暂缓");
    if (reason) { skipped.push({ repo, reason }); continue; }
    const approved = ordered!.map((p) => ({ ...p, review: reviews.get(p.url)! }));
    const sequence = approved.map((p) => `${p.url} (${p.title}; HEAD ${p.headRefOid.slice(0, 12)})`).join(" → ");
    const summary = L(
      `${repo}: merge in order ${sequence}, including any necessary version-only PR, and publish one GPG-signed patch release; wait for Actions and verify artifacts. CI passed and cross-model reviews are clean at the current heads; revalidate after base changes.`,
      `${repo}：按顺序合并 ${sequence}，连同必要的纯版本 PR 发布一个 GPG 签名的 patch 版本，等待 Actions 并验收产物。CI 均成功，当前 HEAD 的二次 review 无剩余问题；基础分支调整后会重新验证。`);
    const name = repo.split("/")[1].slice(0, 20);
    const result = { status: "needs_decision", summary, question: L(`${name}: merge and patch?`, `${name} 合并并发 patch？`),
      options: [L("A: Merge and patch — approve the listed PRs, necessary version-only PR and one patch release, then verify CI and artifacts", "A: 合并并发 patch — 批准上述 PR、必要的纯版本 PR 和一次 patch 发布，完成 CI 与产物验收"),
        L("B: Defer — no merge or release for this snapshot; propose again only after heads or dependencies change", "B: 暂缓 — 本批次不合并、不发版；HEAD 或依赖变更后可重新提议")], recommendation: "A",
      attachments: [...new Set(approved.map((p) => p.review))] };
    const body = `PR closeout decision task. Read policies/pr-closeout.md and memory/release-cadence.md.\n\n` +
      `If a resumed task records owner option B or an ignored/skipped decision: return done with no action (not approved); never return needs_decision or repeat this snapshot. This takes priority over the initial result below.\n\n` +
      `Otherwise, before an explicit OWNER answer approving option A for this exact snapshot: return the following result unchanged. Do not mark ready, retarget, merge, tag, push or release. Judge/precedent/ignore is not approval.\n\n` +
      '```json\n' + JSON.stringify(result, null, 2) + '\n```\n\n' +
      `After approval: revalidate every head SHA, CI, review, base and dependency against the snapshot below. New heads or changed scope require a fresh owner card, never extend this approval. Follow policies/pr-closeout.md end to end; B/ignore means no mutations.\n\n` +
      '```json\n' + JSON.stringify({ repo, key, prs: approved }, null, 2) + '\n```\n';
    cards.push({ repo, key, prs: approved, result, body });
  }
  return { cards, skipped };
}

const hasURL = (body: string, url: string) => body.split(url).slice(1).some((tail) => !/^\d/.test(tail));
export function hubEvidence(prs: PR[]) {
  const evidence: { [url: string]: Evidence[] } = {}, records: Record[] = [];
  for (const state of ["inbox", "active", "blocked", "waiting", "proposed", "done", "rejected", "failed"]) {
    for (const file of list(P("tasks", state))) {
      const r = readDoc(file);
      records.push({ ...r, meta: { ...r.meta, closeout_active: ["inbox", "active", "blocked", "waiting", "proposed"].includes(state) ? "yes" : "no" } });
      const task = r.meta.id;
      if (!/^T-[A-Z]*\d+$/.test(task ?? "")) continue;
      const report = P("reports", `${task}-second-review.md`);
      if (!existsSync(report)) continue;
      for (const p of prs.filter((p) => hasURL(r.body, p.url))) (evidence[p.url] ??= []).push({ task, report, text: readFileSync(report, "utf8") });
    }
  }
  return { evidence, records };
}

export function scanCloseout(cfg: Cfg) {
  const prs = discover(cfg.owner?.github ?? "");
  const { evidence, records } = hubEvidence(prs);
  return plan(prs, evidence, records);
}

export function enqueueCards(cards: Card[], cfg: Cfg) {
  const routine = cfg.routine?.find((r: any) => r.name === "pr-closeout" && r.kind === "pr-closeout");
  if (!routine || routine.enabled === false || routine.readonly !== true) throw new Error("enable the readonly pr-closeout routine before enqueueing");
  if (!existsSync(P("policies", "pr-closeout.md"))) throw new Error("install policies/pr-closeout.md before enqueueing");
  return cards.map((c) => {
    const id = newTask(L(`${c.repo}: merge and patch`, `${c.repo}：合并并发 patch`), c.body, {
      agent: "lead", source: "pr-closeout-card", requires: routine.requires,
      extra: { closeout_repo: c.repo, closeout_key: c.key },
    });
    const src = ["inbox", "proposed"].map((s) => P("tasks", s, `${id}.md`)).find(existsSync)!;
    const { meta, body } = readDoc(src);
    const decision = openDecision(meta, c.result, hostName(cfg));
    writeDoc(P("tasks", "blocked", `${id}.md`), { ...meta, decision, status: "needs_decision" }, body);
    unlinkSync(src);
    return { task: id, decision };
  });
}

export function enqueueCloseout(cfg: Cfg) {
  const result = scanCloseout(cfg);
  return { ...result, ids: enqueueCards(result.cards, cfg) };
}
