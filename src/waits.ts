// Wait tiers, routine silence and merge cards: pure rules the daemon applies (kept here so they are unit-tested).

/** A wait on a person (owner clicks merge, answers a card, publishes by hand) vs. a wait on a machine (CI, a deploy). */
import { L } from "./core";

/** event: a days-long external event (a stable release, someone else merging upstream); wait_check wakes it, the clock is a daily fallback. */
export type WaitKind = "human" | "ci" | "event";

const HUMAN = /owner|老板|CEO|你(来|手动|点|合并|确认|发布)|手动|人工|manual|by hand|decision|决策|决定|approv|批准|确认后|answer|回复卡/i;

const EVENT = /正式版|下(一|个)+(个)?(正式)?(版本|版)|发版|release (is )?(out|published|tagged)|next (stable )?release|upstream (merge|release)|上游(合并|发布)|等.{0,12}(发布|上线)/i;
const MACHINE = /\bCI\b|workflow|actions\/runs|gh (pr|run) checks|构建|测试运行/i;

export function waitKind(res: { wait_kind?: string; waiting_on?: string }): WaitKind {
  if (res.wait_kind === "human" || res.wait_kind === "event") return res.wait_kind;
  const on = res.waiting_on ?? "";
  // agents label every non-human wait "ci"; a wait on a release days away must not wake like a CI run (T-10651)
  if (EVENT.test(on) && !MACHINE.test(on)) return "event";
  if (res.wait_kind === "ci") return "ci";
  return HUMAN.test(on) ? "human" : "ci";
}

/** Clock fallback for an event wait: the agent's expected date (wait_until) within 30 days, else 24 hours. */
export const EVENT_FALLBACK_MIN = 24 * 60;

/** Poll interval for a CI wait_check after `checks` earlier polls: 5 → 10 → 20 → 40 minutes, then stays at 40. */
export const backoffMinutes = (checks: number) => 5 * 2 ** Math.min(3, Math.max(0, checks));

/** A CI wait whose wait_check the daemon polls wakes its agent on the clock only after this long without a change. */
export const CHECKED_FALLBACK_MIN = 120;

/** Wake-ups after which a task stops cycling and is parked as blocked. */
export const MAX_WAKES = 6;
export const tooManyWakes = (wakes: number) => wakes > MAX_WAKES;

/** A human wait has no deadline: it wakes only on an event (its wait_check changes, the owner answers or writes). */
export function waitMeta(res: { wait_kind?: string; waiting_on?: string; wait_minutes?: number; wait_check?: string; wait_until?: string }, now = Date.now()) {
  const kind = waitKind(res);
  if (kind === "human") return { kind, wake_at: undefined as string | undefined, minutes: 0 };
  if (kind === "event") {
    const until = Date.parse(res.wait_until ?? "");
    const at = until > now + 60 * 60_000 && until < now + 30 * 86_400_000 ? until : now + EVENT_FALLBACK_MIN * 60_000;
    return { kind, wake_at: new Date(at).toISOString(), minutes: Math.round((at - now) / 60_000) };
  }
  const minutes = Math.min(120, Math.max(5, Number(res.wait_minutes) || 15));
  return { kind, wake_at: new Date(now + minutes * 60_000).toISOString(), minutes };
}

/** Merge cards are never answered by the judge: its answer cannot open the merge gate, so the owner clicks anyway. */
export function isMergeCard(meta: { question?: string; options?: string; kind?: string }): boolean {
  if (meta.kind === "menu") return false;
  return /合并|\bmerge\b/i.test(meta.question ?? "");
}

/** First line of a merge card: the PR link and what the owner has to do. */
export function mergeHeadline(text: string): string {
  const url = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
  return url ? L(`${url} needs you to merge`, `${url} 需要你点合并`) : L("needs you to merge", "需要你点合并");
}

/** A routine run that changed nothing: journal it, do not send it to the owner's channel. */
export const NO_CHANGE = /(本轮)?(没有|未|无)(做)?(任何)?(修改|改动|变化|推送|新)|无变化|nothing (new|changed|to do)|no changes?\b/i;
export const isNoChangeRoutine = (source: string | undefined, summary: string) =>
  /^routine:/.test(source ?? "") && NO_CHANGE.test(summary);

/** Re-parked on the same thing after a wake: nothing changed, so it is not news for the owner's channel. */
export const sameWaitAgain = (meta: { resumed?: string; waiting_on?: string; wakes?: string }, waitingOn: string | undefined) =>
  meta.resumed === "yes" && (meta.waiting_on ?? "").trim() !== "" && (meta.waiting_on ?? "").trim() === (waitingOn ?? "").trim();
