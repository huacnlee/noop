import { describe, expect, test } from "bun:test";
import { unrunnableReason } from "../src/cli";

// pr-review requires os:linux while this fleet is macOS-only, so every interval minted a copy no host could claim
// (510 rejected tasks, all superseded; reviewer never ran). The guard only skips what no known machine can run.
const mac = ["os:macos", "host:Yangs-MacBook-Pro-2", "cli:claude", "cli:gh"];

describe("unrunnableReason", () => {
  test("reports a capability no known host has", () => {
    expect(unrunnableReason(["os:linux"], [mac])).toBe("os:linux");
  });
  test("an alternative cap in one requirement satisfies it", () => {
    expect(unrunnableReason(["os:linux|os:macos"], [mac])).toBe("");
  });
  test("a machine that is merely offline still counts: its heartbeat file stays", () => {
    expect(unrunnableReason(["os:linux"], [mac, ["os:linux", "cli:cargo"]])).toBe("");
  });
  test("with no heartbeats the fleet cannot judge, so the scheduler parks it as before", () => {
    expect(unrunnableReason(["os:linux"], [])).toBe("");
  });
  test("a routine with no requirements always runs", () => {
    expect(unrunnableReason([], [mac])).toBe("");
  });
});
