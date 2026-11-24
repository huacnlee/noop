import { expect, test } from "bun:test";
import { classify, networkBlocked, quotaCooldownUntil } from "../src/accounts";
import { failureKind } from "../src/cli";

test("a gateway 5xx that says 'try again in a moment' is not a quota wall", () => {
  // What Claude Code prints when its API endpoint answers 502: no usage limit anywhere, only a vague retry hint.
  // Counted as quota it puts the account on a one-hour cooldown and moves all its work to the other CLI.
  const out = JSON.stringify({
    type: "result", is_error: true, api_error_status: 502,
    result: "API Error: 502 Bad response. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway.",
  });
  expect(classify(out)).toBeNull();
  expect(classify("Service hiccup, please try again in a few moments")).toBeNull();
  expect(classify("Something went wrong, try again in a bit")).toBeNull();
});

test("quota walls are still recognised, including reset hints that carry a time", () => {
  for (const msg of [
    "You've hit your usage limit. Try again at 3:05 PM.",
    "Rate limit reached, try again in 2h 13m",
    "Come back later: try again in 7 days",
    "Come back later: try again at 3pm",
    "5-hour limit reached ∙ resets 3pm",
    "429 Too Many Requests",
    "Your credit balance is too low to access the API",
    "The server is overloaded",
    // Command Code Plan's 402 wording (T-1953): credits exhausted, resets only on renewal — failover now
    "API Error: 402 Command Code Plan: You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
    // Codex on a workspace plan: the run dies with no result block, so without this it retried as a plain failure
    "ERROR: Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
  ]) expect(classify(msg)).toBe("quota");
});

test("login problems stay auth, and unrelated failures stay unclassified", () => {
  expect(classify("Not logged in · Please run /login")).toBe("auth");
  expect(classify("API Error: 401 unauthorized")).toBe("auth");
  expect(classify("tests failed: 3 of 40")).toBeNull();
});

test("Claude's expired OAuth session enters the auth failover path", () => {
  const message = "Failed to authenticate: OAuth session expired and could not be refreshed";
  expect(classify(message)).toBe("auth");
  expect(classify(JSON.stringify({ type: "result", is_error: true, result: message }))).toBe("auth");
  expect(classify("OAuth token has expired")).toBe("auth");
  expect(classify("OAuth session has expired")).toBe("auth");
  expect(classify("OAuth session created; tests failed: 3 of 40")).toBeNull();
});

test("Claude's login that reached its time limit enters the auth failover path", () => {
  // What `claude -p` prints once the subscription login has ended for good. Unclassified, the chat brain never fell
  // over to the next account (FallbackModel only falls over on a classified failure), so a working API account
  // behind it was never tried and every message ended as "the chat assistant is unavailable".
  const message = "Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs";
  expect(classify(message)).toBe("auth");
  expect(classify(`Error: ${message}`)).toBe("auth");
  expect(classify(JSON.stringify({ type: "result", is_error: true, result: message }))).toBe("auth");
  expect(classify("load test reached its time limit; 3 of 40 tests failed")).toBeNull();
});

test("the production gateway 503 is not exhausted API credit", () => {
  expect(classify("API Error: 503 No available accounts: no available accounts. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway.")).toBeNull();
});

test("concurrent quota failures retain one cooldown and notification key", () => {
  const until = new Date(Date.now() + 3600000).toISOString();
  expect(quotaCooldownUntil(until, "usage limit")).toBe(until);
  expect(quotaCooldownUntil(until, "try again in 2h")).toBe(until);
  expect(Date.parse(quotaCooldownUntil("2000-01-01", "usage limit"))).toBeGreaterThan(Date.now());
});

test("a network Anthropic refuses is neither a login nor a quota problem", () => {
  // Claude Code on a machine behind a VPN/proxy: the run dies with no result block, so without this the medic was
  // woken for every task (and answered with the same 403), while "signing in again won't change this" told the
  // owner that a login link is useless.
  const out = "API Error: Request blocked before it reached Anthropic's API (HTTP 403) · the network this request"
    + " came from isn't allowed: usually an unsupported region, or a VPN, proxy or hosting network · signing in again"
    + " won't change this · check your VPN or network and retry · supported regions: https://anthropic.com/supported-countries";
  expect(networkBlocked(out)).toBe(true);
  expect(classify(out)).toBeNull();
  // ordinary failures, and the quota/auth walls, stay out of it
  expect(networkBlocked("tests failed: 3 of 40")).toBe(false);
  expect(networkBlocked("API Error: 401 unauthorized")).toBe(false);
  expect(classify("API Error: 401 unauthorized")).toBe("auth");

  // the run died with no result block, so before this it went to the medic — 31 times in five days on one Mac
  expect(failureKind("agent returned no result block", out)).toBe("network");
  expect(failureKind("agent returned no result block", "Error: bun: command not found")).toBe("tooling");
  expect(failureKind("the branch does not build", "tsc: 4 errors")).toBe("task");
});
