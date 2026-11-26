import { expect, test } from "bun:test";
import { heartbeatBody, telemetryEnabled } from "../src/telemetry";

test("telemetry is on by default and every opt-out turns it off", () => {
  expect(telemetryEnabled({}, {})).toBe(true);
  expect(telemetryEnabled({ telemetry: { enabled: false } }, {})).toBe(false);
  expect(telemetryEnabled({}, { NOOP_TELEMETRY: "0" })).toBe(false);
  expect(telemetryEnabled({}, { NOOP_TELEMETRY: "off" })).toBe(false);
  expect(telemetryEnabled({}, { DO_NOT_TRACK: "1" })).toBe(false);
});

test("the heartbeat carries only the build date", () => {
  const b = heartbeatBody("2026-11-26");
  expect(b).toEqual({ n: "heartbeat", d: "noop.agent", u: "https://noop.agent/daemon/v/2026-11-26", r: "", w: 0 });
});
