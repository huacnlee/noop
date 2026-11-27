import { hostname } from "node:os";

/** Picks the machine's own name. On macOS `os.hostname()` follows the network when HostName is unset: a DHCP server or
 *  reverse DNS renames the Mac (`tonydeMacBook-Pro` at the office, `tonydeMBP` at home), the daemon then heartbeats as
 *  a second, non-primary host, and primary-only routines wait until the network changes back. LocalHostName is the name
 *  the user set in System Settings and stays put. */
export function pickMachineName(platform: string, localHostName: string | undefined, osHostname: string): string {
  const local = platform === "darwin" ? localHostName?.trim() : "";
  return local || osHostname.split(".")[0];
}

let cached: string | undefined;

/** This machine's name, read once per process so a network change mid-run cannot rename the host either. */
export function machineName(): string {
  if (cached) return cached;
  let local: string | undefined;
  if (process.platform === "darwin") {
    try {
      const r = Bun.spawnSync(["/usr/sbin/scutil", "--get", "LocalHostName"], { stderr: "ignore" });
      if (r.exitCode === 0) local = r.stdout.toString();
    } catch {}
  }
  return (cached = pickMachineName(process.platform, local, hostname()));
}
