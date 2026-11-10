// Wait tiers, routine silence and merge cards: pure rules the daemon applies (kept here so they are unit-tested).

/** A wait on a person (owner clicks merge, answers a card, publishes by hand) vs. a wait on a machine (CI, a deploy). */
import { L } from "./core";

export type WaitKind = "human" | "ci";

const HUMAN = /owner|老板|CEO|你(来|手动|点|合并|确认|发布)|手动|人工|manual|by hand|decision|决策|决定|approv|批准|确认后|answer|回复卡/i;

export function waitKind(res: { wait_kind?: string; waiting_on?: string }): WaitKind {
  if (res.wait_kind === "human" || res.wait_kind === "ci") return res.wait_kind;
  return HUMAN.test(res.waiting_on ?? "") ? "human" : "ci";
}

/** What a wait is really about, read from what the agent recorded (T-0064): an account's quota cooling down is not a
 * platform problem, a CI run or a person. Quota comes first because those waits often mention the PR they will review. */
export type WaitCause = "quota" | WaitKind;
const QUOTA = /review-account\.ts\s+check\b|额度|配额|限额|\bquota\b|rate[ -]?limit|usage limit|cool(ing)?[ -]?down|冷却/i;
export function waitCause(m: { wait_kind?: string; waiting_on?: string; wait_check?: string }): WaitCause {
  if (QUOTA.test(`${m.wait_check ?? ""}\n${m.waiting_on ?? ""}`)) return "quota";
  return waitKind(m);
}

/** Is the wait over? A quota check exits 0 once the account is usable again, whatever it returned before; other checks
 * are over when their exit code differs from the first one seen. */
export const waitOver = (cause: WaitCause, code: number, base: number | undefined) =>
  cause === "quota" ? code === 0 : base !== undefined && code !== base;

/** A blocked task the daemon may put back in the queue by itself once its quota check passes: parked after too many
 * wakes (no card) or under a supervisor card. A card the agent raised for the owner still needs the owner's answer. */
export function autoResumable(m: Record<string, string | undefined>, card?: { open: boolean; supervisor_cause?: string }): boolean {
  if (!m.wait_check || waitCause(m) !== "quota") return false;
  if (!m.decision) return true;
  return !!card && (!card.open || !!card.supervisor_cause);
}

/** Poll interval for a CI wait_check after `checks` earlier polls: 5 → 10 → 20 → 40 minutes, then stays at 40. */
export const backoffMinutes = (checks: number) => 5 * 2 ** Math.min(3, Math.max(0, checks));

/** A CI wait whose wait_check the daemon polls wakes its agent on the clock only after this long without a change. */
export const CHECKED_FALLBACK_MIN = 120;

/** Wake-ups after which a task stops cycling and is parked as blocked. */
export const MAX_WAKES = 6;
export const tooManyWakes = (wakes: number) => wakes > MAX_WAKES;

/** A human wait has no deadline: it wakes only on an event (its wait_check changes, the owner answers or writes). */
export function waitMeta(res: { wait_kind?: string; waiting_on?: string; wait_minutes?: number; wait_check?: string }, now = Date.now()) {
  const kind = waitKind(res);
  if (kind === "human") return { kind, wake_at: undefined as string | undefined, minutes: 0 };
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
