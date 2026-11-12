// The owner's per-member CLI policy (settings › 成员 → clis.agents) must win over the planner's per-task suggestion.
// It did not: the planner wrote its choice into the task's `cli` field, allowedClis() read that first, so a member
// pinned to codex-only kept running Claude for every task the planner called "hard" (T-0032).
import { expect, test } from "bun:test";
import { allowedClis } from "../src/core";

const cfg = (agents?: Record<string, string[]>) => ({ clis: agents ? { agents } : {} }) as any;

test("the owner's per-member CLI wins over the planner's hint", () => {
  expect(allowedClis({ agent: "lead", cli: "auto", cli_hint: "claude" }, cfg({ lead: ["codex"] }))).toEqual(["codex"]);
});

test("a CLI pinned on the task itself still wins over the member config", () => {
  expect(allowedClis({ agent: "lead", cli: "claude" }, cfg({ lead: ["codex"] }))).toEqual(["claude"]);
});

test("without a member config the planner's hint decides", () => {
  expect(allowedClis({ agent: "lead", cli: "auto", cli_hint: "codex" }, cfg())).toEqual(["codex"]);
});

test("neither config nor hint: either CLI, Claude first", () => {
  expect(allowedClis({ agent: "lead", cli: "auto" }, cfg())).toEqual(["claude", "codex"]);
});

test("a member without its own config is unaffected by another member's", () => {
  expect(allowedClis({ agent: "reporter", cli: "auto", cli_hint: "codex" }, cfg({ lead: ["codex"] }))).toEqual(["codex"]);
});

test("an empty member list falls through instead of forbidding every CLI", () => {
  expect(allowedClis({ agent: "lead", cli: "auto", cli_hint: "codex" }, cfg({ lead: [] }))).toEqual(["codex"]);
});

test("a hint outside {claude, codex} is ignored rather than pinned", () => {
  expect(allowedClis({ agent: "lead", cli: "auto", cli_hint: "gpt" }, cfg())).toEqual(["claude", "codex"]);
});

test("a member's configured order is kept", () => {
  expect(allowedClis({ agent: "lead", cli: "auto", cli_hint: "claude" }, cfg({ lead: ["codex", "claude"] }))).toEqual(["codex", "claude"]);
});
