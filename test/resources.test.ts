import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedParallel, busyShare, canRunHeavy, diskAlertDue, pressureOf, staleDerivedData } from "../src/resources";

test("busyShare measures the busy fraction of a CPU tick delta", () => {
  expect(busyShare(null, { idle: 100, total: 200 })).toBeNull(); // no baseline
  expect(busyShare({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBeNull(); // no time passed
  expect(busyShare({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBe(0.5);
  expect(busyShare({ idle: 100, total: 200 }, { idle: 200, total: 300 })).toBe(0);
  expect(busyShare({ idle: 100, total: 200 }, { idle: 100, total: 300 })).toBe(1);
  expect(busyShare({ idle: 100, total: 200 }, { idle: 50, total: 100 })).toBeNull(); // counters went backwards
});

test("pressureOf prefers measured CPU utilisation and falls back to load/cores", () => {
  const mac = { cores: 8, load1: 12.4, loadRatio: 1.55, memFreePct: 29, diskFreeGB: 179, diskFreePct: 36 };
  expect(pressureOf({ ...mac, cpuBusyPct: 33 })).toBe(0.33);
  expect(pressureOf({ ...mac, cpuBusyPct: null })).toBe(1.55);
  expect(pressureOf(mac)).toBe(1.55); // absent = unknown
});

// The regression the owner reported: this Mac is two thirds idle but loadavg counts every GUI thread, so
// loadRatio ~1.5-4 pinned the fleet to one agent while host.max_parallel was 4.
test("allowedParallel honours max_parallel when the CPU is idle even if loadavg says otherwise", () => {
  const idleMac = { cores: 8, load1: 12.4, loadRatio: 1.55, cpuBusyPct: 33, memFreePct: 29, diskFreeGB: 179, diskFreePct: 36 };
  const cfg = { host: { max_parallel: 4 } } as any;
  expect(allowedParallel(idleMac, cfg, 0)).toBe(4);
  expect(allowedParallel(idleMac, cfg, 3)).toBe(4);
  // the throttle must still bite when the CPU is genuinely saturated
  expect(allowedParallel({ ...idleMac, cpuBusyPct: 95 }, cfg, 0)).toBe(1);
  expect(allowedParallel({ ...idleMac, cpuBusyPct: 95 }, cfg, 3)).toBe(3);
  expect(allowedParallel({ ...idleMac, cpuBusyPct: 80 }, cfg, 0)).toBe(2);
});

test("allowedParallel still stops on low memory/disk and falls back to cores/3", () => {
  const s = { cores: 8, load1: 1, loadRatio: 0.12, cpuBusyPct: 20, memFreePct: 29, diskFreeGB: 179, diskFreePct: 36 };
  expect(allowedParallel({ ...s, memFreePct: 8 }, { host: { max_parallel: 4 } } as any, 0)).toBe(0);
  expect(allowedParallel({ ...s, diskFreeGB: 3 }, { host: { max_parallel: 4 } } as any, 2)).toBe(1);
  expect(allowedParallel(s, {} as any, 0)).toBe(2); // max(2, floor(8/3))
});

test("canRunHeavy reads the same pressure signal", () => {
  const s = { cores: 8, load1: 12, loadRatio: 1.5, cpuBusyPct: 33, memFreePct: 40, diskFreeGB: 100, diskFreePct: 30 };
  const cfg = { resources: { heavy_max_load: 0.5 } } as any;
  expect(canRunHeavy(s, cfg, 0)).toBe(true);
  expect(canRunHeavy({ ...s, cpuBusyPct: 70 }, cfg, 0)).toBe(false);
});

const plist = (date: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>LastAccessedDate</key><date>${date}</date>
<key>WorkspacePath</key><string>/x/App.xcworkspace</string></dict></plist>`;

test.skipIf(process.platform !== "darwin")("staleDerivedData picks idle and orphaned project folders only", async () => {
  const root = mkdtempSync(join(tmpdir(), "dd-"));
  const now = Date.parse("2026-11-06T00:00:00Z");
  const mk = (name: string, date?: string) => {
    mkdirSync(join(root, name));
    if (date) writeFileSync(join(root, name, "info.plist"), plist(date));
  };
  mk("App-active", "2026-11-05T00:00:00Z");
  mk("App-idle", "2026-10-20T00:00:00Z");
  mk("App-orphan");
  utimesSync(join(root, "App-orphan"), new Date(now - 3 * 86400e3), new Date(now - 3 * 86400e3));
  for (const shared of ["ModuleCache.noindex", "SDKExplicitPrecompiledModules", "Files-abc"]) mk(shared);
  try {
    const got = (await staleDerivedData(root, 7, now)).map((p) => p.slice(root.length + 1)).sort();
    expect(got).toEqual(["App-idle", "App-orphan"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("diskAlertDue alerts once, then only after 6h or another 5GB drop", () => {
  const at = 1_800_000_000_000;
  expect(diskAlertDue({ at: 0, freeGB: Infinity }, at, 51)).toBe(true); // never alerted
  expect(diskAlertDue({ at, freeGB: 51 }, at + 30 * 60_000, 51)).toBe(false); // the 30-min re-alert loop
  expect(diskAlertDue({ at, freeGB: 51 }, at + 5.9 * 3600_000, 50)).toBe(false);
  expect(diskAlertDue({ at, freeGB: 51 }, at + 30 * 60_000, 46)).toBe(true); // worse by 5GB
  expect(diskAlertDue({ at, freeGB: 51 }, at + 6 * 3600_000, 51)).toBe(true); // reminder after 6h
});
