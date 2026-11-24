import { existsSync } from "node:fs";

/**
 * Worker hosts must never sleep while the daemon runs: a sleeping host stops claiming work, stops syncing and drops out
 * of the fleet. The launchd wrapper (`caffeinate -i`) only covered idle sleep and only when the daemon was started by
 * that exact plist, so the daemon holds its own block, whatever started it. The helper process watches the daemon's
 * pid and releases the block by itself when the daemon exits, even on SIGKILL, so nothing stays awake after Noop stops.
 */
export type Awake = { how: string } | { error: string };

/** Candidate commands, strongest first; the next one is tried when a stronger block is refused (e.g. by polkit). */
export function awakeCommands(pid: number, platform: string = process.platform, has: (p: string) => boolean = existsSync): { cmd: string[]; how: string }[] {
  if (platform === "darwin") {
    // -i idle sleep, -s system sleep on AC power (also a closed lid on AC), -m disk idle sleep. The display may still sleep.
    return [{ cmd: ["/usr/bin/caffeinate", "-ims", "-w", String(pid)], how: "caffeinate -ims" }];
  }
  if (platform === "linux") {
    const inhibit = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"].find(has);
    if (!inhibit) return [];
    // `tail --pid` ends when the daemon ends, which ends the inhibitor lock
    const hold = ["tail", `--pid=${pid}`, "-f", "/dev/null"];
    const lock = (what: string) => ({ cmd: [inhibit, `--what=${what}`, "--who=Noop", "--why=Noop worker must stay awake", "--mode=block", ...hold], how: `systemd-inhibit ${what}` });
    return [lock("sleep:idle:handle-lid-switch"), lock("sleep:idle")];
  }
  return [];
}

let holder: { proc: Bun.Subprocess; how: string } | undefined;

/** Hold a sleep block for this process; idempotent, so the daemon loop can call it every tick to restore a killed helper. */
export async function stayAwake(pid = process.pid, settleMs = 1500): Promise<Awake> {
  if (holder && holder.proc.exitCode === null && !holder.proc.killed) return { how: holder.how };
  holder = undefined;
  const cmds = awakeCommands(pid);
  if (!cmds.length) return { error: process.platform === "linux" ? "systemd-inhibit not found" : `no sleep block on ${process.platform}` };
  let last = "";
  for (const { cmd, how } of cmds) {
    let proc: Bun.Subprocess<"ignore", "ignore", "pipe">;
    try { proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" }); }
    catch (e) { last = String(e); continue; }
    // a refused lock exits at once; one that is still running after the settle time holds the block
    const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(settleMs).then(() => false)]);
    if (!done) {
      proc.unref();
      holder = { proc, how };
      return { how };
    }
    last = `${cmd[0].replace(/^.*\//, "")} exited ${proc.exitCode}: ${(await new Response(proc.stderr).text()).trim().slice(0, 200)}`;
  }
  return { error: last };
}

/**
 * A voluntary restart (self-update, `hub restart`) leaves the host with no sleep block between this process exiting and
 * the service manager starting the next one (launchd throttles KeepAlive by 10s, systemd waits RestartSec). An idle host
 * sleeps in that gap: jason-macmini-lb did at 2026-11-24 18:15, 5s after a self-update exit. The bridge is a timed block
 * started outside the service (its own session on macOS, its own transient unit on Linux, so neither launchd nor the
 * unit's cgroup kill takes it down) that covers the gap and expires by itself.
 */
export function bridgeCommand(seconds: number, platform: string = process.platform, has: (p: string) => boolean = existsSync): string[] | undefined {
  if (platform === "darwin") return ["/usr/bin/caffeinate", "-ims", "-t", String(seconds)];
  if (platform === "linux") {
    const inhibit = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"].find(has);
    const run = ["/usr/bin/systemd-run", "/bin/systemd-run"].find(has);
    if (!inhibit) return undefined;
    const lock = [inhibit, "--what=sleep:idle", "--who=Noop", "--why=Noop daemon is restarting", "--mode=block", "sleep", String(seconds)];
    return run ? [run, "--user", "--collect", "--quiet", ...lock] : lock;
  }
  return undefined;
}

/** Start the restart bridge; call right before a voluntary exit. Never throws: a missing bridge must not block the exit. */
export function bridgeRestart(seconds = 120): string | undefined {
  const cmd = bridgeCommand(seconds);
  if (!cmd) return undefined;
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    proc.unref();
    return cmd.join(" ");
  } catch { return undefined; }
}
