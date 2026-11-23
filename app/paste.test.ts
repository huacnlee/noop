import { expect, test } from "nsh/test";
import { insertText, pasteAsFile } from "./hub";

test("a long paste becomes a Markdown file; a short one goes in at the caret", () => {
  expect(pasteAsFile("short text")).toBe(false);
  expect(pasteAsFile("x".repeat(4001))).toBe(true);
  expect(pasteAsFile(Array(81).fill("a").join("\n"))).toBe(true);
  expect(pasteAsFile(Array(80).fill("a").join("\n"))).toBe(false);
  expect(insertText("hello world", "big ", { start: 6, end: 6 })).toEqual({ value: "hello big world", at: 10 });
  expect(insertText("hello world", "there", { start: 6, end: 11 })).toEqual({ value: "hello there", at: 11 });
  expect(insertText("ab", "c", null)).toEqual({ value: "abc", at: 3 });
});
