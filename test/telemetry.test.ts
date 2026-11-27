import { expect, test } from "bun:test";
import { heartbeatBody, telemetryEnabled } from "../src/telemetry";

test("telemetry is on by default and every opt-out turns it off", () => {
  expect(telemetryEnabled({}, {})).toBe(true);
  expect(telemetryEnabled({ telemetry: { enabled: false } }, {})).toBe(false);
  expect(telemetryEnabled({}, { NOOP_TELEMETRY: "0" })).toBe(false);
  expect(telemetryEnabled({}, { NOOP_TELEMETRY: "off" })).toBe(false);
  expect(telemetryEnabled({}, { DO_NOT_TRACK: "1" })).toBe(false);
});

test("the heartbeat is one NsMetry event with the build date, the OS family and the install id only", () => {
  const b = heartbeatBody("2026-11-26", "0b5f1c9e-3f0a-4a57-9d55-6c1f3a2b7e10", 1_795_000_000_000);
  expect(b.site).toBe("noop");
  expect(b.events).toHaveLength(1);
  const [e] = b.events;
  expect(Object.keys(e!).sort()).toEqual(["app_version", "name", "ts", "ua", "url", "user_id"]);
  expect(e).toMatchObject({ name: "heartbeat", url: "/daemon", ts: 1_795_000_000, user_id: "0b5f1c9e-3f0a-4a57-9d55-6c1f3a2b7e10", app_version: "2026-11-26" });
  expect(e!.ua).toMatch(/^Noop\/2026-11-26 \((macOS|Windows NT 10\.0|Linux|Other)\)$/);
});
