// hub init / install / update — out-of-the-box setup and self-update.
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODE, DATA, HOME_DIR, P, isCloudDeployHost } from "./core";
import { machineName } from "./machine";

const STATE_DIRS = [
  "tasks/proposed", "tasks/rejected", "tasks/waiting", "tasks/inbox", "tasks/active", "tasks/blocked", "tasks/failed", "tasks/done",
  "decisions/open", "decisions/closed", "journal", "fleet/hosts", "reports/daily", "evolution", "reviews",
];

/** Copy template files that don't exist yet (never overwrite user-evolved agents/memory/policies). */
function seedTemplates() {
  const walk = (rel: string) => {
    for (const e of readdirSync(join(CODE, "templates", rel), { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) { mkdirSync(P(r), { recursive: true }); walk(r); }
      else if (!existsSync(P(r))) cpSync(join(CODE, "templates", r), P(r));
    }
  };
  walk("");
  for (const d of STATE_DIRS) { mkdirSync(P(d), { recursive: true }); if (!readdirSync(P(d)).length) writeFileSync(P(d, ".gitkeep"), ""); }
}

/** Worker host: owner email login → POST /api/host/join → this machine's token. */
async function joinViaLogin(url: string, host: string): Promise<string | null> {
  const post = async (path: string, body: unknown, auth?: string) => {
    const r = await fetch(url + path, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) } }).catch(() => null);
    return { ok: !!r?.ok, status: r?.status ?? 0, json: (await r?.json().catch(() => ({}))) as any };
  };
  const email = (prompt("owner email:") ?? "").trim();
  if (!email) return null;
  const s = await post("/api/auth/start", { email });
  if (!s.ok) { console.error(`login failed (${s.status}): ${s.json?.error ?? ""}`); return null; }
  const code = (prompt("code from the email:") ?? "").trim();
  const totp = (prompt("6-digit code from the authenticator app:") ?? "").replace(/\s/g, "");
  const v = await post("/api/auth/verify", { email, code, totp });
  if (!v.ok || !v.json?.session) { console.error(`verification failed (${v.status}): ${v.json?.error ?? ""}`); return null; }
  const j = await post("/api/host/join", { host }, v.json.session);
  await post("/api/auth/logout", {}, v.json.session); // the session was only needed to mint the machine token
  if (!j.ok || !j.json?.token) { console.error(`join failed (${j.status}): ${j.json?.error ?? ""}; or use: noop init ${url} --token <machine-token>`); return null; }
  return String(j.json.token);
}

/** `hub init [<hub-url>] [--token <machine-token>]` (the default): join an existing hub as a worker and mirror its data.
 *  `hub init --primary`: the fleet's one primary: deploy your own Worker, seed templates, push them.
 *  A host already set up as the primary (or already joined) keeps its role when init runs again. */
export async function init(opts: { worker?: string; token?: string; primary?: boolean } = {}) {
  const { commitPush, pull, loadConfig, hostName } = await import("./core");
  const { readHubToml, syncMode, writeHubToml } = await import("./sync");
  mkdirSync(DATA, { recursive: true });
  const me = machineName();
  const joined = readHubToml().cloud?.url;
  const primaryHere = existsSync(P("config.toml")) && new RegExp(`^\\s*primary\\s*=\\s*"${me}"`, "m").test(readFileSync(P("config.toml"), "utf8"));
  if (!opts.primary && !primaryHere) {
    const url = (opts.worker || joined || (prompt("your noop URL (e.g. https://noop.example.com; set up the first machine with --primary):") ?? "")).trim().replace(/\/$/, "");
    if (!url) { console.error("no noop URL: run init <noop-url>, or init --primary on the machine that hosts it"); process.exitCode = 1; return; }
    const token = opts.token ?? (url === joined ? readHubToml().server?.token : undefined) ?? await joinViaLogin(url, me);
    if (!token) { process.exitCode = 1; return; }
    writeHubToml({ cloud: { url }, server: { token } });
    if (!(await pull())) { console.error(`could not sync from ${url} (check the URL / token)`); process.exitCode = 1; return; }
    writeLocalConfig(me);
    console.log(`✔ joined ${url}; data mirrored to ${DATA}\n  next: hub install   (runs the daemon as a service)`);
    return;
  }
  if (await syncMode() === "remote") await pull(); // re-running init: start from what the Worker has
  seedTemplates();
  const cfgPath = P("config.toml");
  let cfg = readFileSync(cfgPath, "utf8");
  if (cfg.includes('primary = "__PRIMARY__"')) {
    cfg = cfg.replace('primary = "__PRIMARY__"', `primary = "${me}"`)
      .replace('# url = "__URL__"', `url = "http://${me}:8787"`);
    writeFileSync(cfgPath, cfg);
    console.log(`this host (${me}) is the fleet primary`);
  }
  // the machine token is the Worker's HUB_TOKEN; it stays machine-local (noop.toml), not in the shared data
  if (!readHubToml().server?.token && !loadConfig().server?.token) writeHubToml({ server: { token: crypto.randomUUID().replace(/-/g, "") } });
  writeLocalConfig(me);
  const c = loadConfig();
  if ((c.fleet?.primary ?? "") === hostName(c) && !c.cloud?.url && !process.env.HUB_SYNC && !process.env.HUB_SYNC_FAKE) {
    const { cloudDeploy } = await import("./cloud"); // the owner's own fixed endpoint on Cloudflare (free)
    await cloudDeploy(c);
    if (!readHubToml().cloud?.url) console.log("Worker not deployed yet; data stays local until you run: hub cloud deploy");
  }
  if (await syncMode() === "remote" && !(await commitPush(`[${me}] init`))) console.error("could not push the initial data; it will sync on the next daemon tick");
  console.log(`✔ data: ${DATA}\n  next: hub install   (runs the daemon as a service)`);
}

function writeLocalConfig(me: string) {
  if (!existsSync(P("config.local.toml")))
    writeFileSync(P("config.local.toml"), `# per-machine overrides & secrets (never synced)\n[host]\n# name = "${me}"\n# caps = []\n# max_parallel = 3\n\n[notify]\n# slack_bot_token = ""\n# discord_bot_token = ""\n`);
}

// ------------------------------------------------------------------ self-update
const REJECTED = () => join(HOME_DIR, "update-rejected"); // machine-local: a release this host already refused
const BLOCKED = () => join(HOME_DIR, "update-blocked"); // machine-local: the last reason an update could not be applied

/** A release whose tests failed here is not tried again until origin moves on — otherwise every check
 *  re-installs the same bad code and wakes the medic again. An explicit `hub update` still retries. */
export function updateRejected(up: string, file = REJECTED()): boolean {
  try { return readFileSync(file, "utf8").trim() === up; } catch { return false; }
}

/** Report a blocked update once per distinct state: an uncommitted file (the medic is told to keep its fix applied
 *  locally) used to freeze self-update for days without a journal line or a medic call. Returns the text when this
 *  state is new, null when it was already reported; the caller journals the returned line. */
export function updateBlocked(detail: string, file = BLOCKED()): string | null {
  try { if (readFileSync(file, "utf8").trim() === detail) return null; } catch {}
  try { mkdirSync(HOME_DIR, { recursive: true }); writeFileSync(file, detail); } catch {}
  return detail;
}

/** Paths from `git status --porcelain` v1 output. Parse line by line, never trim the whole blob first:
 *  an unstaged entry starts with a space (` M src/x.ts`), so trimming makes slice(3) drop the path's first char. */
export function dirtyPaths(porcelain: string): string[] {
  return porcelain.split("\n").filter((l) => l.length > 3).map((l) => l.replace(/^.. /, ""));
}

/** Fast-forward framework code if origin has new commits that pass tests. Returns true if updated. */
export async function selfUpdate(opts: { busy?: number; force?: boolean; deploy?: boolean } = {}): Promise<boolean> {
  // never swap code (and then restart) under running work: defer until this host is idle
  if ((opts.busy ?? 0) > 0 && !opts.force) return false;
  const g = (...a: string[]) => $`git ${a}`.cwd(CODE).quiet().nothrow();
  if (!existsSync(join(CODE, ".git"))) return false;
  await g("fetch", "-q", "origin");
  // The install must track main. A task that branched inside it (e.g. an evolve PR) leaves it following that
  // branch, which reads as "already current" forever. Go back to main once main has all of the branch's work.
  const branch = (await g("rev-parse", "--abbrev-ref", "HEAD")).stdout.toString().trim();
  if (branch && branch !== "main" && (await g("rev-parse", "--verify", "-q", "origin/main")).exitCode === 0) {
    const unmerged = (await g("cherry", "origin/main", "HEAD")).stdout.toString().split("\n").some((l) => l.startsWith("+"));
    const dirtyNow = dirtyPaths((await g("status", "--porcelain", "--untracked-files=no")).stdout.toString()).length > 0;
    if (unmerged || dirtyNow || (await g("checkout", "-q", "main")).exitCode !== 0) {
      if (updateBlocked(`on branch ${branch}`)) {
        try {
          const { loadConfig, hostName, journal } = await import("./core");
          journal(hostName(loadConfig()), `⏸ self-update blocked — the install is on branch ${branch} (unmerged work or local edits), not main.`);
        } catch {}
      }
      return false;
    }
  }
  const head =(await g("rev-parse", "HEAD")).stdout.toString().trim();
  const up = (await g("rev-parse", "@{u}")).stdout.toString().trim();
  if (!up || head === up) return false;
  if (!opts.force && updateRejected(up)) return false; // already failed its tests here; wait for the next release
  const reportBlocked = async (detail: string) => {
    if (!updateBlocked(detail)) return;
    try {
      const { loadConfig, hostName, journal } = await import("./core");
      journal(hostName(loadConfig()), `⏸ self-update blocked — ${detail}. Commit, revert or merge the change to resume.`);
    } catch {} // a CLI run without a hub still must not fail on the notice
  };
  const dirty = dirtyPaths((await g("status", "--porcelain", "--untracked-files=no")).stdout.toString());
  if (dirty.length) { // local edits → skip (they would be lost), but never silently
    await reportBlocked(`local edits: ${dirty.join(", ")} (HEAD ${head.slice(0, 7)}, origin ${up.slice(0, 7)})`);
    return false;
  }
  // upstream history may have been rewritten (e.g. scrubbed); with no local edits, follow it — tests below still guard the switch
  let applied;
  if ((await g("merge-base", "--is-ancestor", "HEAD", "@{u}")).exitCode !== 0) {
    // diverged: follow upstream only when it already has every local commit's change (a rewrite); unpushed work stays
    if ((await g("cherry", "@{u}", "HEAD")).stdout.toString().split("\n").some((l) => l.startsWith("+"))) return false;
    applied = await g("reset", "--hard", "-q", "@{u}");
  }
  else applied = await g("merge", "--ff-only", "-q", "@{u}");
  if (applied.exitCode !== 0) { // never test, report and restart on code that was not actually switched
    await reportBlocked(`git could not move to ${up.slice(0, 7)}: ${(applied.stderr.toString() || applied.stdout.toString()).trim().slice(-300)}`);
    return false;
  }
  const deps = await $`bun install --frozen-lockfile`.cwd(CODE).quiet().nothrow();
  // A sleeping Mac can exhaust test timeouts during maintenance wakes. Keep it awake only for validation
  // (-s also prevents system sleep on AC); caffeinate releases its assertions and preserves the test exit code.
  const testCmd = process.platform === "darwin" ? ["/usr/bin/caffeinate", "-is", "bun", "test"] : ["bun", "test"];
  const test = await $`${testCmd}`.cwd(CODE).quiet().nothrow();
  if (deps.exitCode !== 0 || test.exitCode !== 0) {
    await g("reset", "--hard", "-q", head); // roll back a bad release
    await $`bun install --frozen-lockfile`.cwd(CODE).quiet().nothrow();
    try { mkdirSync(HOME_DIR, { recursive: true }); writeFileSync(REJECTED(), up); } catch {}
    console.error(`self-update to ${up.slice(0, 7)} failed tests → rolled back to ${head.slice(0, 7)}`);
    const { medic } = await import("./medic");
    const { loadConfig } = await import("./core");
    void medic(`self-update ${head.slice(0, 7)} → ${up.slice(0, 7)} failed (deps exit ${deps.exitCode}, tests exit ${test.exitCode}); rolled back.\n${test.stdout.toString().slice(-3000)}${test.stderr.toString().slice(-3000)}`,
      loadConfig(), { auto: true, kind: "update" });
    return false;
  }
  seedTemplates(); // new template agents/policies appear; existing ones untouched
  { // designated deployment host keeps its own Cloudflare hub in step with the code (Worker or app changed)
    const { loadConfig } = await import("./core");
    const c = loadConfig();
    const changed = (await g("diff", "--name-only", head, up)).stdout.toString();
    if (c.cloud?.url && isCloudDeployHost(c) && (opts.deploy || /^(cloud|app)\//m.test(changed))) {
      const { cloudDeploy } = await import("./cloud");
      await cloudDeploy(c);
    }
  }
  try { unlinkSync(BLOCKED()); } catch {} // the next block is a new event, not a repeat of this one
  console.log(`self-updated ${head.slice(0, 7)} → ${up.slice(0, 7)}`);
  return true;
}

// ------------------------------------------------------------------ service install
/** Machines installed before the rename keep their service name. */
export const SERVICE = existsSync(join(homedir(), ".config/systemd/user/agent-hub.service")) || existsSync(join(homedir(), "Library/LaunchAgents/com.agent-hub.daemon.plist")) ? "agent-hub" : "noop";
const LABEL = SERVICE === "agent-hub" ? "com.agent-hub.daemon" : "dev.noop.daemon";
/** Write a launch agent without loading it; also supports fresh macOS accounts. */
export function writeMacAgent(home: string, data: string, bun: string, cli: string, path: string, label: string): string {
  const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const plist = join(home, `Library/LaunchAgents/${label}.plist`);
  mkdirSync(join(plist, ".."), { recursive: true });
  mkdirSync(join(data, "logs"), { recursive: true });
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>${xml(bun)}</string><string>${xml(cli)}</string><string>start</string><string>--foreground</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string><key>HUB_DATA</key><string>${xml(data)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>5400</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(data, "logs", "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(data, "logs", "daemon.log"))}</string>
</dict></plist>
`);
  return plist;
}

export async function install() {
  const bun = Bun.which("bun") ?? join(homedir(), ".bun/bin/bun");
  const cli = join(CODE, "src", "cli.ts");
  const path = [join(homedir(), ".bun/bin"), join(homedir(), ".local/bin"), join(homedir(), ".cargo/bin"), join(homedir(), "go/bin"), join(homedir(), ".local/share/mise/shims"),
    join(homedir(), ".local/share/mise/command-wrappers/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  if (process.platform === "linux") {
    const unit = join(homedir(), `.config/systemd/user/${SERVICE}.service`);
    mkdirSync(join(unit, ".."), { recursive: true });
    writeFileSync(unit, `[Unit]
Description=Noop fleet daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${bun} ${cli} start --foreground
Restart=always
RestartSec=10
# stopping lets running agents finish (the daemon drains), so a restart never throws work away.
# The stop timeout must outlast the longest agent run (clis.timeout_minutes, default 60), or systemd
# SIGKILLs the agents mid-run and the restarted daemon redoes them.
KillMode=mixed
TimeoutStopSec=90min
Environment=PATH=${path}
Environment=HUB_DATA=${DATA}
Nice=5
# the daemon itself holds a systemd-inhibit sleep lock while it runs (src/awake.ts)

[Install]
WantedBy=default.target
`);
    await $`systemctl --user daemon-reload`.nothrow();
    await $`systemctl --user enable --now ${SERVICE}.service`.nothrow();
    await $`loginctl enable-linger ${process.env.USER ?? ""}`.nothrow(); // run without a login session / monitor
    console.log(`✔ systemd user service installed: ${unit}
  logs:   journalctl --user -u ${SERVICE} -f
  24/7:   linger enabled (runs with no one logged in). To prevent sleep on this always-on box:
          sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`);
  } else if (process.platform === "darwin") {
    const plist = writeMacAgent(homedir(), DATA, bun, cli, path, LABEL);
    await $`launchctl bootout gui/${process.getuid!()} ${plist}`.quiet().nothrow();
    await $`launchctl bootstrap gui/${process.getuid!()} ${plist}`;
    console.log(`✔ launchd agent installed: ${plist} (starts at login; the daemon blocks idle and system sleep while it runs). Keep a primary Mac logged in and awake: sleep, logout or closing the lid pauses coordination until it returns.`);
  } else if (process.platform === "win32") {
    const cmd = `"${bun}" "${cli}" start --foreground`;
    await $`schtasks /Create /F /SC ONLOGON /RL LIMITED /TN ${SERVICE} /TR ${cmd}`.nothrow();
    await $`schtasks /Run /TN ${SERVICE}`.nothrow();
    console.log(`✔ Scheduled Task '${SERVICE}' installed (runs at logon, restarts with the daemon's own loop). Disable sleep: powercfg /change standby-timeout-ac 0`);
  }
}

// ------------------------------------------------------------------ service control (noop start / stop / status)
export type ServiceManager = "launchd" | "systemd" | "schtasks";
/** What the OS service manager says about Noop on this machine. */
export type ServiceState = { manager: ServiceManager | null; installed: boolean; running: boolean; pid?: number; since?: string; lastExit?: string; logs?: string };

/** `launchctl print gui/<uid>/<label>`: only the job's own (one-tab) lines; nested endpoints print their own `state`. */
export function parseLaunchctl(out: string): Pick<ServiceState, "running" | "pid" | "lastExit"> {
  const pid = Number(out.match(/^\tpid = (\d+)/m)?.[1]) || undefined;
  const lastExit = out.match(/^\tlast exit code = (.+)$/m)?.[1]?.trim();
  return { running: /^\tstate = running$/m.test(out), pid, lastExit };
}

/** `systemctl --user show <unit> -p LoadState,ActiveState,SubState,MainPID,ActiveEnterTimestamp`. */
export function parseSystemctl(out: string): Pick<ServiceState, "installed" | "running" | "pid" | "since"> {
  const v = Object.fromEntries(out.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
  return { installed: v.LoadState === "loaded", running: v.ActiveState === "active" || v.ActiveState === "deactivating",
    pid: Number(v.MainPID) || undefined, since: v.ActiveState === "active" && v.ActiveEnterTimestamp ? v.ActiveEnterTimestamp : undefined };
}

/** `schtasks /Query /TN <name> /FO LIST /V`: the Status line says Running / Ready / Disabled. */
export function parseSchtasks(out: string): Pick<ServiceState, "running" | "lastExit"> {
  return { running: /^Status:\s+Running/im.test(out), lastExit: out.match(/^Last Result:\s+(.+)$/im)?.[1]?.trim() };
}

const macPlist = () => join(homedir(), `Library/LaunchAgents/${LABEL}.plist`);
const macTarget = () => `gui/${process.getuid!()}/${LABEL}`;

export async function serviceState(): Promise<ServiceState> {
  if (process.platform === "darwin") {
    const installed = existsSync(macPlist()), logs = join(DATA, "logs", "daemon.log");
    if (!installed) return { manager: "launchd", installed, running: false, logs };
    const r = await $`launchctl print ${macTarget()}`.quiet().nothrow();
    return { manager: "launchd", installed, logs, ...(r.exitCode === 0 ? parseLaunchctl(r.stdout.toString()) : { running: false }) };
  }
  if (process.platform === "linux") {
    if (!Bun.which("systemctl")) return { manager: null, installed: false, running: false };
    const r = await $`systemctl --user show ${SERVICE}.service -p LoadState,ActiveState,SubState,MainPID,ActiveEnterTimestamp`.quiet().nothrow();
    return { manager: "systemd", logs: `journalctl --user -u ${SERVICE} -f`, ...parseSystemctl(r.stdout.toString()) };
  }
  if (process.platform === "win32") {
    const r = await $`schtasks /Query /TN ${SERVICE} /FO LIST /V`.quiet().nothrow();
    return { manager: "schtasks", installed: r.exitCode === 0, ...(r.exitCode === 0 ? parseSchtasks(r.stdout.toString()) : { running: false }) };
  }
  return { manager: null, installed: false, running: false };
}

/** `noop start`: install the service the first time, otherwise (re)start it. Returns false when it could not. */
export async function startService(): Promise<boolean> {
  const st = await serviceState();
  if (!st.manager) { console.log("No service manager here (systemd / launchd / Task Scheduler). Run it in this terminal instead: noop start --foreground"); return false; }
  if (!st.installed) { await install(); return (await serviceState()).running || process.platform === "win32"; }
  if (st.running) { console.log(`✓ noop is already running${st.pid ? ` (pid ${st.pid})` : ""}. To pick up new code: noop restart`); return true; }
  if (st.manager === "launchd") {
    const loaded = (await $`launchctl print ${macTarget()}`.quiet().nothrow()).exitCode === 0;
    const r = loaded ? await $`launchctl kickstart ${macTarget()}`.quiet().nothrow() : await $`launchctl bootstrap gui/${process.getuid!()} ${macPlist()}`.quiet().nothrow();
    if (r.exitCode !== 0) { console.log(`✗ launchctl failed: ${r.stderr.toString().trim()}`); return false; }
  } else if (st.manager === "systemd") {
    const r = await $`systemctl --user start ${SERVICE}.service`.quiet().nothrow();
    if (r.exitCode !== 0) { console.log(`✗ systemctl failed: ${r.stderr.toString().trim()}`); return false; }
  } else {
    const r = await $`schtasks /Run /TN ${SERVICE}`.quiet().nothrow();
    if (r.exitCode !== 0) { console.log(`✗ schtasks failed: ${r.stderr.toString().trim()}`); return false; }
  }
  const now = await serviceState();
  console.log(now.running || st.manager === "schtasks" ? `✓ noop started${now.pid ? ` (pid ${now.pid})` : ""}` : `✗ noop did not stay up; see ${st.logs ?? "the service logs"}`);
  return now.running || st.manager === "schtasks";
}

/** `noop stop`: stop the service until the next `noop start` (or login/boot). Running tasks finish first. */
export async function stopService(): Promise<boolean> {
  const st = await serviceState();
  if (!st.installed) { console.log("noop is not installed as a service; nothing to stop"); return true; }
  if (!st.running) { console.log("✓ noop is not running"); return true; }
  console.log("stopping noop: running tasks finish first, this can take a while…");
  // launchd and systemd send SIGTERM, which the daemon answers by draining (ExitTimeOut / TimeoutStopSec allow 90 min)
  const r = st.manager === "launchd" ? await $`launchctl bootout ${macTarget()}`.quiet().nothrow()
    : st.manager === "systemd" ? await $`systemctl --user stop ${SERVICE}.service`.quiet().nothrow()
    : await $`schtasks /End /TN ${SERVICE}`.quiet().nothrow();
  if (r.exitCode !== 0) { console.log(`✗ could not stop noop: ${r.stderr.toString().trim()}`); return false; }
  console.log("✓ noop stopped. Start it again with: noop start");
  return true;
}
