import { expect, test } from "bun:test";
import { awakeCommands, bridgeCommand, stayAwake } from "../src/awake";

test("macOS blocks idle, system and disk sleep for the daemon's lifetime", () => {
  expect(awakeCommands(42, "darwin")).toEqual([{ cmd: ["/usr/bin/caffeinate", "-ims", "-w", "42"], how: "caffeinate -ims" }]);
});

test("Linux takes a systemd inhibitor lock, falling back without the lid switch", () => {
  const cmds = awakeCommands(42, "linux", (p) => p === "/usr/bin/systemd-inhibit");
  expect(cmds.map((c) => c.how)).toEqual(["systemd-inhibit sleep:idle:handle-lid-switch", "systemd-inhibit sleep:idle"]);
  for (const { cmd } of cmds) {
    expect(cmd[0]).toBe("/usr/bin/systemd-inhibit");
    expect(cmd).toContain("--mode=block");
    expect(cmd.slice(-4)).toEqual(["tail", "--pid=42", "-f", "/dev/null"]); // ends with the daemon
  }
  expect(awakeCommands(42, "linux", () => false)).toEqual([]);
});

test.if(process.platform === "darwin")("the block is held while the watched process lives and released when it exits", async () => {
  const assertions = () => Bun.spawnSync(["pmset", "-g", "assertions"]).stdout.toString();
  const daemon = Bun.spawn(["sleep", "30"]);
  try {
    const got = await stayAwake(daemon.pid, 500);
    expect(got).toEqual({ how: "caffeinate -ims" });
    expect(await stayAwake(daemon.pid, 500)).toEqual(got); // idempotent: no second helper
    expect(assertions()).toContain(`on behalf of Process ID ${daemon.pid}\n`);
  } finally { daemon.kill(); await daemon.exited; }
  for (let i = 0; i < 20 && assertions().includes(`on behalf of Process ID ${daemon.pid}\n`); i++) await Bun.sleep(100);
  expect(assertions()).not.toContain(`on behalf of Process ID ${daemon.pid}\n`);
});

test("a restart is bridged by a timed block that outlives the service", () => {
  expect(bridgeCommand(120, "darwin")).toEqual(["/usr/bin/caffeinate", "-ims", "-t", "120"]);
  const linux = bridgeCommand(120, "linux", (p) => p.startsWith("/usr/bin/"))!;
  expect(linux.slice(0, 4)).toEqual(["/usr/bin/systemd-run", "--user", "--collect", "--quiet"]); // own unit, outside the daemon's cgroup
  expect(linux).toContain("--what=sleep:idle");
  expect(linux.slice(-2)).toEqual(["sleep", "120"]);
  expect(bridgeCommand(120, "linux", (p) => p === "/usr/bin/systemd-inhibit")![0]).toBe("/usr/bin/systemd-inhibit");
  expect(bridgeCommand(120, "linux", () => false)).toBeUndefined();
});
