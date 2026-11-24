// `noop tasks` lists the open decision cards; with ten unread cards the useful number is how long each has waited.
import { expect, test } from "bun:test";
import { cardAge } from "../src/cli";

const now = Date.parse("2026-11-23T00:00:00Z");

test("a card younger than a day shows no age; older ones show whole days", () => {
  expect(cardAge({ created: "2026-11-22T23:00:00Z" }, now)).toBe("");
  expect(cardAge({ created: "2026-11-11T00:00:00Z" }, now)).toBe(" · 12d");
});

test("a missing or unparseable date is not shown as an age", () => {
  expect(cardAge({}, now)).toBe("");
  expect(cardAge({ created: "not a date" }, now)).toBe("");
});

test("notified is the fallback when created is absent", () => {
  expect(cardAge({ notified: "2026-11-13T00:00:00Z" }, now)).toBe(" · 10d");
});
