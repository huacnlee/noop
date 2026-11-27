import { expect, test } from "bun:test";
import { machineName, pickMachineName } from "../src/machine";

test("macOS keeps its LocalHostName when the network renames the host", () => {
  // At home the router hands out tonydeMBP, at the office the Mac reports tonydeMacBook-Pro.local: one machine, one name.
  expect(pickMachineName("darwin", "tonydeMacBook-Pro\n", "tonydeMBP")).toBe("tonydeMacBook-Pro");
  expect(pickMachineName("darwin", "tonydeMacBook-Pro\n", "tonydeMacBook-Pro.local")).toBe("tonydeMacBook-Pro");
});

test("falls back to the short os hostname when LocalHostName is missing or not macOS", () => {
  expect(pickMachineName("darwin", undefined, "mac.local")).toBe("mac");
  expect(pickMachineName("darwin", "  ", "mac.local")).toBe("mac");
  expect(pickMachineName("linux", "ignored", "box.lan")).toBe("box");
});

test("machineName is stable within a process", () => {
  const first = machineName();
  expect(first.length).toBeGreaterThan(0);
  expect(first).not.toContain(".");
  expect(machineName()).toBe(first);
});
