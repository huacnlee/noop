import { expect, test } from "nsh/test";
import { insertText, pasteAsFile, textDocName } from "./hub";

test("a long paste becomes a Markdown file; a short one goes in at the caret", () => {
  expect(pasteAsFile("short text")).toBe(false);
  expect(pasteAsFile("x".repeat(4001))).toBe(true);
  expect(pasteAsFile(Array(81).fill("a").join("\n"))).toBe(true);
  expect(pasteAsFile(Array(80).fill("a").join("\n"))).toBe(false);
  expect(insertText("hello world", "big ", { start: 6, end: 6 })).toEqual({ value: "hello big world", at: 10 });
  expect(insertText("hello world", "there", { start: 6, end: 11 })).toEqual({ value: "hello there", at: 11 });
  expect(insertText("ab", "c", null)).toEqual({ value: "abc", at: 3 });
});

test("pasted or dropped Markdown and text files go as Markdown documents", () => {
  expect(textDocName(undefined, "notes.md")).toBe("notes.md");
  expect(textDocName("", "README.markdown")).toBe("README.md");
  expect(textDocName(undefined, "log.txt")).toBe("log.md");
  expect(textDocName("text/plain", "clip")).toBe("clip.md");
  expect(textDocName("text/markdown; charset=utf-8", "a.weird")).toBe("a.md");
  expect(textDocName("image/png", "shot.png")).toBeNull();
  expect(textDocName(undefined, "data.pdf")).toBeNull();
});
