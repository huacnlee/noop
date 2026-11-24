// `noop status` reports the service itself, read from the OS service manager; these parse what each one prints.
import { expect, test } from "bun:test";
import { parseLaunchctl, parseSchtasks, parseSystemctl } from "../src/setup";
import { ago } from "../src/cli";

test("launchd: the job's own state and pid, not its nested endpoints'", () => {
  const out = "gui/501/dev.noop.daemon = {\n\tactive count = 1\n\tstate = running\n\truns = 13\n\tpid = 94085\n\tlast exit code = 0\n\tendpoints = {\n\t\tstate = active\n\t}\n}";
  expect(parseLaunchctl(out)).toEqual({ running: true, pid: 94085, lastExit: "0" });
  expect(parseLaunchctl("gui/501/dev.noop.daemon = {\n\tstate = not running\n\tlast exit code = 1\n\tendpoints = {\n\t\tstate = running\n\t}\n}"))
    .toEqual({ running: false, pid: undefined, lastExit: "1" });
});

test("systemd: loaded/active with its main pid and start time", () => {
  expect(parseSystemctl("LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=812\nActiveEnterTimestamp=Mon 2026-11-23 09:00:00 UTC\n"))
    .toEqual({ installed: true, running: true, pid: 812, since: "Mon 2026-11-23 09:00:00 UTC" });
  expect(parseSystemctl("LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nActiveEnterTimestamp=\n"))
    .toEqual({ installed: false, running: false, pid: undefined, since: undefined });
});

test("Task Scheduler: Running vs Ready", () => {
  expect(parseSchtasks("TaskName:      \\noop\nStatus:        Running\nLast Result:   267009\n")).toEqual({ running: true, lastExit: "267009" });
  expect(parseSchtasks("TaskName:      \\noop\nStatus:        Ready\nLast Result:   0\n").running).toBe(false);
});

test("ago() rounds to the largest useful unit", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  expect(ago("2026-11-24T11:59:48Z", now)).toBe("12s ago");
  expect(ago("2026-11-24T11:55:00Z", now)).toBe("5m ago");
  expect(ago("2026-11-24T09:00:00Z", now)).toBe("3h ago");
  expect(ago("2026-11-22T12:00:00Z", now)).toBe("2d ago");
  expect(ago(undefined, now)).toBe("never");
});
