import { expect, test } from "bun:test";
import { join } from "node:path";
import { ackInbound, answerFromChat, pendingInbound } from "../src/server";

test("a chat answer taken just before a restart is still there for the next daemon", () => {
  // the old daemon takes the owner's answer, then exits (self-update) before its next tick could handle it
  const old = Bun.spawnSync([process.execPath, "-e", 'const s = await import("./src/server"); await s.handleOwnerMessage("D-0001 A"); process.exit(0);'],
    { cwd: join(import.meta.dir, ".."), env: process.env, stderr: "pipe" });
  expect(old.stderr.toString()).toBe("");
  expect(old.exitCode).toBe(0);
  // the new daemon's first tick sees it
  expect(pendingInbound()).toEqual([{ id: "D-0001", answer: "A", source: "chat" }]);
  // an answer arriving while the tick handles the first one is kept when the first is acked
  answerFromChat("D-0002", "B", false);
  ackInbound(1);
  expect(pendingInbound()).toEqual([{ id: "D-0002", answer: "B", source: "chat" }]);
  ackInbound(1);
  expect(pendingInbound()).toEqual([]);
});
