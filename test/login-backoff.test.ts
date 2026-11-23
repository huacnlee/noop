// A login command that exits before printing a link (e.g. BSD `script` failing under a pipe) used to be retried
// every 30 minutes forever, journaling and notifying the owner each time (L-0001…L-0019 in one night).
import { expect, test } from "bun:test";
import { loginBackoffMs } from "../src/accounts";

const m = 60_000;

test("first retry and link-expiry retries stay at 30 minutes", () => {
  expect(loginBackoffMs(0)).toBe(30 * m);
  expect(loginBackoffMs(1)).toBe(30 * m);
});

test("consecutive silent failures double the delay", () => {
  expect(loginBackoffMs(2)).toBe(60 * m);
  expect(loginBackoffMs(3)).toBe(120 * m);
  expect(loginBackoffMs(5)).toBe(480 * m);
});

test("the delay is capped at 12 hours", () => {
  expect(loginBackoffMs(6)).toBe(720 * m);
  expect(loginBackoffMs(50)).toBe(720 * m);
});
