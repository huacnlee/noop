import { expect, test } from "bun:test";
import { startModel } from "../src/runner";

test("startModel reads the explicit flag, else Codex's config default", () => {
  expect(startModel("claude", ["claude", "-p", "--model", "claude-opus-5-5"])).toBe("claude-opus-5-5");
  expect(startModel("codex", ["codex", "exec", "-m", "gpt-x", "-"])).toBe("gpt-x");
  expect(startModel("codex", ["codex", "exec", "-"], "/tmp/t0897cx")).toBe("gpt-6");
  expect(startModel("claude", ["claude", "-p"])).toBeUndefined();
});
