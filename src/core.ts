import "./test-isolation";
// noop core — shared files as the world (stigmergy; synced via the owner's Worker, src/sync.ts), task queue, agent runner, journal, memory.
import { OFFLINE_AFTER_MINUTES } from "../cloud/src/budget";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { machineName } from "./machine";
import { basename, dirname, join, relative, resolve } from "node:path";
import * as sync from "./sync";
import { recoverMemory, snapshotMemory } from "./integrity";
import { BUILTIN_ROUTINES } from "./builtin-routines";

/** Framework code (this repo, self-updating). */
export const CODE = resolve(import.meta.dir, "..");
/** Machine-local home: $NOOP_HOME, else ~/.noop if it exists, else ~/.noop (older installs) if it exists, else ~/.noop. */
export function homeDir(): string {
  if (process.env.NOOP_HOME) return resolve(process.env.NOOP_HOME.replace(/^~/, homedir()));
  for (const d of [".noop", ".agent-hub"]) if (existsSync(join(homedir(), d))) return join(homedir(), d);
  return join(homedir(), ".noop");
}
export const HOME_DIR = homeDir();
/** Fleet state: local mirror of the files shared by all machines through the owner's Worker (tasks, journal, decisions, agents, memory, config). */
export const DATA = resolve((process.env.HUB_DATA || join(HOME_DIR, "data")).replace(/^~/, homedir()));
export const ROOT = DATA;
export const P = (...p: string[]) => join(DATA, ...p);
// sync state (noop.toml, sync.json) lives in HOME_DIR; a custom HUB_DATA (tests, extra mirrors) keeps its own next to it
sync.setSyncData(DATA, process.env.HUB_DATA && !process.env.NOOP_HOME ? dirname(DATA) : HOME_DIR);

// ------------------------------------------------------------------ config
export type Cfg = Record<string, any>;

function merge(a: any, b: any): any {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {}))
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" ? merge(out[k], v) : v;
  return out;
}

/** Owner-facing text in the fleet's language: `[owner] language = "en"` in config.toml gives English, otherwise Simplified Chinese. */
export const isEnglish = (): boolean => /^en/i.test(String(loadConfig().owner?.language ?? ""));
export const L = (en: string, zh: string): string => (isEnglish() ? en : zh);

export function loadConfig(): Cfg {
  const read = (f: string) => (existsSync(P(f)) ? Bun.TOML.parse(readFileSync(P(f), "utf8")) : {});
  // noop.toml = machine-local bootstrap (Worker url + machine token), outside DATA because DATA itself comes from the Worker
  // settings.json = changes made from the UI (shared via the data repo), applied over config.toml; config.local.toml wins last
  const ui = existsSync(P("settings.json")) ? JSON.parse(readFileSync(P("settings.json"), "utf8")) : {};
  const cfg: Cfg = merge(merge(merge(sync.readHubToml(), read("config.toml")), ui), read("config.local.toml"));
  // built-in routines (src/builtin-routines.ts) unless config.toml defines one of the same name
  cfg.routine = Array.isArray(cfg.routine) ? cfg.routine : [];
  for (const b of BUILTIN_ROUTINES) if (!cfg.routine.some((r: any) => r.name === b.name)) {
    const r: Record<string, unknown> = { ...b, builtin: true };
    if (r.agent && !existsSync(P("agents", String(r.agent)))) r.agent = "lead"; // a fleet without that member
    cfg.routine.push(r);
  }
  // routine tweaks from the UI: { routines: { <name>: { enabled, every } } }
  for (const r of cfg.routine ?? []) Object.assign(r, ui.routines?.[r.name] ?? {});
  cfg.notify ??= {};
  // the owner's own Cloudflare hub (hub cloud deploy) is the fixed address for clients and workers
  if (cfg.cloud?.url) { cfg.server ??= {}; cfg.server.url ??= cfg.cloud.url; cfg.server.public_url ??= cfg.cloud.url; }
  // public hub URL published by the primary's tunnel (fleet/hub.json) → workers and push links use it unless pinned locally
  if (existsSync(P("fleet", "hub.json"))) try {
    const { url } = JSON.parse(readFileSync(P("fleet", "hub.json"), "utf8"));
    cfg.server ??= {};
    if (url && !cfg.server.url) cfg.server.url = url;
    if (url && !cfg.server.public_url) cfg.server.public_url = url;
  } catch {}
  const envMap: Record<string, string> = {
    slack_bot_token: "HUB_SLACK_BOT_TOKEN", slack_channel: "HUB_SLACK_CHANNEL", slack_webhook: "HUB_SLACK_WEBHOOK",
    discord_bot_token: "HUB_DISCORD_BOT_TOKEN", discord_channel: "HUB_DISCORD_CHANNEL", discord_webhook: "HUB_DISCORD_WEBHOOK",
  };
  for (const [k, env] of Object.entries(envMap)) if (process.env[env]) cfg.notify[k] = process.env[env];
  return cfg;
}

export const hostName = (cfg: Cfg): string =>
  process.env.HUB_HOST || cfg.host?.name || machineName();

export const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
export const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD local
export const hhmm = () => new Date().toLocaleTimeString("sv-SE").slice(0, 5);

// ------------------------------------------------------------------ data sync (src/sync.ts)
// All data mutations are serialized so parallel workers in one daemon never race on the mirror.
let chain: Promise<unknown> = Promise.resolve();
export function locked<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

export const hasRemote = async () => (await sync.syncMode()) === "remote";

export const pull = (opts?: Parameters<typeof sync.pull>[0]) => locked(() => _pull(opts));
/** Apply remote changes to DATA (remote wins on paths edited on both sides, except mergeable appends). */
export const _pull = (opts?: Parameters<typeof sync.pull>[0]): Promise<boolean> => sync.pull(opts);

/** Commit every local change via the Worker's compare-and-swap; false if we lost a race (or are offline). */
export const commitPush = (msg: string, opts?: { force?: boolean }) => locked(() => _commitPush(msg, opts));
export const _commitPush = (msg: string, opts?: { force?: boolean }): Promise<boolean> => sync.commitPush(msg, opts);

/** Discard local edits and re-pull. */
export const resetToUpstream = () => sync.resetToUpstream();

// ------------------------------------------------------------------ markdown docs w/ front-matter
export type Doc = { meta: Record<string, string>; body: string };

export function readDoc(path: string): Doc {
  const text = readFileSync(path, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

/** Model output is untrusted: a field the spec says is a string can arrive as a number, object or nothing at all.
 *  Coerce at the door so one malformed field cannot abort a whole run (it used to take the daemon down). */
export const asText = (v: unknown): string =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);

export function writeDoc(path: string, meta: Record<string, string | undefined>, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  const head = Object.entries(meta).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ")}`).join("\n");
  writeFileSync(path, `---\n${head}\n---\n${asText(body).trimEnd()}\n`);
}

export const list = (dir: string, re = /\.md$/) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f)) : [];

/** "…/decisions/open/D-0001.md" → "D-0001". Always use this (not split("/")): on Windows list() returns
 *  backslash paths, so splitting on "/" yields the whole path — that silently broke every chat reply to a card. */
export const fileId = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/, "");

/** Non-primary hosts mint IDs with a host letter (T-M0001) so two machines never create the same ID. */
let idTag = "";
export const setIdTag = (tag: string) => { idTag = tag; };

export function nextId(prefix: string, dir: string): string {
  let max = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      const m = e.name.match(new RegExp(`^${prefix}-${idTag}(\\d+)`));
      if (m) max = Math.max(max, +m[1]);
    }
  };
  if (existsSync(dir)) walk(dir);
  // the local mirror can lag other hosts: never hand out an id whose file already exists in any state folder
  const taken = (id: string) => existsSync(dir) && readdirSync(dir, { withFileTypes: true })
    .some((e) => e.isDirectory() ? existsSync(join(dir, e.name, `${id}.md`)) : e.name === `${id}.md`);
  let n = max + 1;
  while (taken(`${prefix}-${idTag}${String(n).padStart(4, "0")}`)) n++;
  return `${prefix}-${idTag}${String(n).padStart(4, "0")}`;
}

/**
 * Whether `host` is the fleet's primary (runs routines, the judge, the server, mints untagged ids). Named by
 * [fleet] primary; with none named, a host is the primary only while it is alone: once another host's heartbeat
 * is in the data, it is a worker, so a machine that joined before its config synced never takes over.
 */
export function isPrimary(cfg: Cfg, host = hostName(cfg)): boolean {
  if (cfg.fleet?.primary) return cfg.fleet.primary === host;
  return !list(P("fleet", "hosts"), /\.json$/).some((p) => basename(p, ".json") !== host);
}

/** Automatic cloud deployment can run on a credentialed host without moving fleet coordination. */
export function isCloudDeployHost(cfg: Cfg, host = hostName(cfg)): boolean {
  const deployHost = String(cfg.cloud?.deploy_host ?? "").trim();
  return deployHost ? deployHost === host : isPrimary(cfg, host);
}

/** Id tag for a host: "" on the primary, else [host].id_tag or the host name's first letter, upper-cased. */
export function idTagFor(cfg: Cfg, host: string): string {
  if (isPrimary(cfg, host)) return "";
  return String(cfg.host?.id_tag ?? (host.replace(/[^a-z]/gi, "").charAt(0) || "W")).toUpperCase();
}

// ------------------------------------------------------------------ tasks
export type TaskOpts = {
  agent?: string; cli?: string; host?: string; requires?: string; prefer?: string; weight?: string; repo?: string; priority?: string; source?: string;
  extra?: Record<string, string>;
};

/** Capabilities of this machine: os:<linux|macos|windows>, host:<name>, plus config [host].caps (e.g. gpu, docker, home). */
export function hostCaps(cfg: Cfg): string[] {
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
  const clis = ["claude", "codex", "gh", "cargo", "bun", "node"].filter((c) => Bun.which(c)).map((c) => `cli:${c}`);
  return [`os:${os}`, `host:${hostName(cfg)}`, `arch:${process.arch}`, ...clis, ...(cfg.host?.caps ?? [])];
}

/** One requirement; "a|b" means either cap will do (e.g. cli:bun|cli:node). */
export const capOk = (req: string, caps: string[]) => req.split("|").some((r) => caps.includes(r.trim()));

/** Toolchain a repo needs, read from its manifest files. Empty when the repo dir is not on this machine. */
export function repoRequires(repo?: string): string[] {
  if (!repo) return [];
  const dir = resolve(repo.replace(/^~/, homedir()));
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  if (existsSync(join(dir, "Cargo.toml"))) out.push("cli:cargo");
  if (existsSync(join(dir, "package.json"))) out.push("cli:bun|cli:node");
  return out;
}

/** A task matches if every comma-separated requirement is in the host's caps (plus what its local repo needs). */
export function matches(meta: Record<string, string>, caps: string[]): boolean {
  const reqs = [meta.requires, meta.host && meta.host !== "any" ? `host:${meta.host}` : "", ...repoRequires(meta.repo)]
    .join(",").split(",").map((s) => s.trim()).filter(Boolean);
  return reqs.every((r) => capOk(r, caps));
}

/** Hook set by the CLI so core stays free of policy imports. */
export let approvalGate: (source: string) => boolean = () => false;
export const setApprovalGate = (fn: (source: string) => boolean) => { approvalGate = fn; };

/** Like asText, for the option fields of a task made from model output: absent stays absent, and a list (an agent
 *  told "leave requires empty" sent `[]`) joins into the comma-separated form the card stores. */
const optText = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : Array.isArray(v) ? v.map(asText).join(",") : asText(v);

export function newTask(title: string, body = "", o: TaskOpts = {}): string {
  title = asText(title);
  body = asText(body);
  // followups are model-written JSON, so any of these can arrive as a list or a number instead of a string
  const requires = optText(o.requires), repo = optText(o.repo);
  const id = nextId("T", P("tasks"));
  // work the owner asked for (directly or via a delegated parent) never needs re-approval
  const folder = o.extra?.origin !== "owner" && approvalGate(o.source ?? "owner") ? "proposed" : "inbox";
  writeDoc(P("tasks", folder, `${id}.md`), {
    id, title, agent: optText(o.agent) ?? "lead", cli: o.cli ?? "auto", host: optText(o.host) ?? "any",
    // stored at creation so hosts without the repo checked out still know what it needs
    requires: [...new Set([...(requires ?? "").split(","), ...repoRequires(repo)].map((x) => x.trim()).filter(Boolean))].join(","), prefer: o.prefer ?? "", weight: o.weight ?? "normal", repo: repo ?? "", priority: optText(o.priority) ?? "normal", source: o.source ?? "owner",
    created: now(), ...(o.extra ?? {}),
  }, body || title);
  return id;
}

export const which = (bin: string) => Bun.which(bin) !== null;

/** Which CLI runs a task, strongest first:
 *  1. a CLI pinned on the task itself (`noop add --cli …`, a routine's `cli`): the owner naming one for this task;
 *  2. the owner's per-member config (Settings → Members → `clis.agents`): policy for that agent, not a suggestion;
 *  3. `cli_hint`, what the planner (an AI call, see planInbox) suggested for this task — a hint, so it may not
 *     override policy. It used to be written into `cli`, which made every planned task look owner-pinned;
 *  4. otherwise either CLI, Claude first.
 *  The per-member config is checked before the hint on purpose: an owner who sets a member to codex-only in the app
 *  must not have that silently undone by the planner picking Claude for a task it calls "hard". */
export function allowedClis(meta: Record<string, string>, cfg: Cfg): string[] {
  if (meta.cli && meta.cli !== "auto") return [meta.cli];
  const per = cfg.clis?.agents?.[meta.agent || "lead"];
  if (Array.isArray(per) && per.length) return per;
  if (meta.cli_hint === "claude" || meta.cli_hint === "codex") return [meta.cli_hint];
  return ["claude", "codex"];
}

/** What the planner may write back about the CLI: only a `cli_hint`, and only when the task is not pinned and its
 *  agent has no per-member policy — either of those would overrule the suggestion anyway.
 *  `available` is the set of CLIs installed on some online host (see fleetClis): a hint naming a CLI no machine has
 *  would narrow allowedClis to a CLI nobody can run, and the task would sit in the inbox forever. */
export function cliHintPatch(meta: Record<string, string>, per: unknown, suggestion: unknown, available: string[]): Record<string, string> {
  const pinned = meta.cli && meta.cli !== "auto";
  const hint = suggestion === "claude" || suggestion === "codex" ? suggestion : "";
  if (pinned || (Array.isArray(per) && per.length) || !hint || !available.includes(hint)) return {};
  return { cli_hint: hint };
}

/** The agent CLIs (claude, codex) installed on at least one of these hosts, read from their `cli:*` caps. */
export function fleetClis(caps: string[][]): string[] {
  return ["claude", "codex"].filter((c) => caps.some((cs) => cs.includes(`cli:${c}`)));
}

export function chooseCli(meta: Record<string, string>, cfg: Cfg): string | null {
  return allowedClis(meta, cfg).find(which) ?? null;
}

// ------------------------------------------------------------------ fleet presence (heartbeats)
export type HostBeat = { host: string; caps: string[]; seen: string; busy: number; version: string; stats?: any;
  /** The noop code this host runs: its commit and that commit's page. */ rev?: string; rev_url?: string;
  /** Its private IPv4 address on the local network; absent when none can be found. */ lan?: string;
  /** How this host is doing with the owner's latest "update every machine". */ update?: UpdateState;
  /** Per running task: when its agent last showed a sign of life and what it was doing. */ activity?: Record<string, Activity> };

/** A running agent's latest sign of life: any output; for Claude also the step it took ("Bash · gh pr checks 814"). */
export type Activity = { at: string; step?: string; steps: number;
  /** The model actually answering (Claude reports it in its stream; Codex: the one it was started with). */ model?: string };
/** This process's running agents (written by runAgent, published in the heartbeat). */
export const agentActivity = new Map<string, Activity>();

/** One host's progress on an update request (`at` names the request), shown per machine in Settings › 版本. */
export type UpdateState = {
  at: string; ts: string;
  state: "updating" | "waiting" | "restarting" | "deploying" | "done" | "current" | "failed";
  detail?: string;
  /** The commit it ran when the update started (a restart onto another commit means it updated). */ from?: string;
};
const STARTED = Date.now();
const UPDATE_STATE = () => join(HOME_DIR, "update-state.json"); // machine-local: survives the restart it reports on
export function setUpdateState(u: Omit<UpdateState, "ts">) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(UPDATE_STATE(), JSON.stringify({ ...u, ts: now() }, null, 2));
}
/** This host's update progress; a restart that finished turns "restarting" into "done" (or "failed" on the same commit). */
export function updateState(): UpdateState | undefined {
  let u: UpdateState;
  try { u = JSON.parse(readFileSync(UPDATE_STATE(), "utf8")); } catch { return undefined; }
  // written by the process before this one: the restart it waited for has happened
  if ((u.state === "restarting" || u.state === "waiting") && Date.parse(u.ts) < STARTED) {
    const rev = runningRev().rev;
    if (rev && rev !== u.from) setUpdateState({ at: u.at, state: "done", detail: rev.slice(0, 7), from: u.from });
    else setUpdateState({ at: u.at, state: "failed", detail: L("Still on the old code after restart", "重启后仍是旧代码"), from: u.from });
    return updateState();
  }
  return u;
}

/** The commit of the code this process runs (read once: an update restarts the daemon) and its GitHub page. */
let codeRev: { rev?: string; rev_url?: string } | undefined;
export function runningRev(): { rev?: string; rev_url?: string } {
  if (codeRev) return codeRev;
  const git = (...a: string[]) => { try { return Bun.spawnSync(["git", "-C", CODE, ...a], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim(); } catch { return ""; } };
  const rev = git("rev-parse", "HEAD") || undefined;
  const repo = git("remote", "get-url", "origin").match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/)?.[1];
  return (codeRev = { rev, rev_url: rev && repo ? `https://github.com/${repo}/commit/${rev}` : undefined });
}

/** The owner's "update every machine" (fleet/update.json, synced): each host updates once per request. */
export const UPDATE_REQUEST = () => P("fleet", "update.json");

type Iface = { address: string; family: string | number; internal: boolean };
/** Virtual adapters whose private addresses are not the machine's LAN address (VPN, proxy TUN, containers, VMs). */
const VIRTUAL_IFACE = /^(utun|tun|tap|wg|tailscale|zt|docker|br-|veth|virbr|vmnet|vboxnet|bridge|llw|awdl|anpi|ap\d|lo|vEthernet)/i;
const isPrivateV4 = (a: string) => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
/** The machine's private IPv4 on its local network: ignores loopback, link-local, VPN/proxy tunnels (198.18.x, 100.64.x)
 *  and container/VM bridges; prefers wired/Wi-Fi adapters (en*, eth*, wl*). Undefined when nothing qualifies. */
export function lanAddress(ifaces: Record<string, Iface[] | undefined> = networkInterfaces()): string | undefined {
  const found = Object.entries(ifaces).flatMap(([name, list]) =>
    VIRTUAL_IFACE.test(name) ? [] : (list ?? []).filter((i) => (i.family === "IPv4" || i.family === 4) && !i.internal && isPrivateV4(i.address))
      .map((i) => ({ name, address: i.address })));
  const physical = (n: string) => /^(en|eth|wl|Ethernet|Wi-?Fi)/i.test(n) ? 0 : 1;
  return found.sort((a, b) => physical(a.name) - physical(b.name) || a.name.localeCompare(b.name, "en", { numeric: true }))[0]?.address;
}

export function heartbeat(cfg: Cfg, busy: number, stats?: unknown) {
  const host = hostName(cfg);
  const f = P("fleet", "hosts", `${host}.json`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ host, caps: hostCaps(cfg), seen: now(), busy, version: "1", stats, ...runningRev(), lan: lanAddress(), update: updateState(), activity: agentActivity.size ? Object.fromEntries(agentActivity) : undefined } satisfies HostBeat, null, 2));
}

/** Caps of every machine that has ever written a heartbeat. Offline hosts stay listed, so a routine pinned to a
 *  capability only they have (a Linux build host that is asleep) is not mistaken for one nobody can satisfy. */
export function knownHostCaps(): string[][] {
  return list(P("fleet", "hosts"), /\.json$/).map((p) => (JSON.parse(readFileSync(p, "utf8")) as HostBeat).caps ?? []);
}

export function onlineHosts(cfg: Cfg): HostBeat[] {
  // heartbeats go up lazily (LAZY_PUSH_MS), so a shorter window would flap machines offline
  const staleMs = Math.max(cfg.fleet?.offline_after_minutes ?? 0, OFFLINE_AFTER_MINUTES) * 60_000;
  return list(P("fleet", "hosts"), /\.json$/).map((p) => JSON.parse(readFileSync(p, "utf8")) as HostBeat)
    .filter((h) => Date.now() - Date.parse(h.seen) < staleMs);
}

const reqList = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Should this host leave the task for a preferred, currently-online host? */
function yieldToPreferred(meta: Record<string, string>, caps: string[], cfg: Cfg): boolean {
  const prefer = reqList(meta.prefer);
  if (!prefer.length || prefer.every((r) => caps.includes(r))) return false;
  const waitMs = (cfg.fleet?.prefer_wait_minutes ?? 10) * 60_000;
  if (Date.now() - Date.parse(meta.created) > waitMs) return false; // waited long enough
  return onlineHosts(cfg).some((h) => h.host !== hostName(cfg) && prefer.every((r) => h.caps.includes(r)));
}

/** The owner's machine priority (`fleet.host_priority`, e.g. { "omarchy-lb": 10, "macbook": -5 }; settable from settings.json).
 *  Higher goes first; unlisted machines are 0. It only orders machines that can all run a task: `requires` / `host:` pins
 *  and the task's own `prefer` still win. */
export const hostPriority = (cfg: Cfg, host: string): number => Number(cfg.fleet?.host_priority?.[host] ?? 0) || 0;

/** Device condition: an online machine counts as free for more work only with CPU and memory headroom. */
export const hostHasRoom = (h: HostBeat): boolean => {
  const s = h.stats;
  if (!s) return h.busy === 0;
  return heartPressure(s) < 0.75 && (s.memFreePct == null || s.memFreePct >= 15) && (s.diskFreeGB == null || s.diskFreeGB >= 5);
};

/** Leave the task for a higher-priority online machine that can run it and has room. Like `prefer`, the wait lapses after
 *  `prefer_wait_minutes`, so a busy or broken preferred machine never holds the queue. */
function yieldToPriority(meta: Record<string, string>, cfg: Cfg): boolean {
  const table = cfg.fleet?.host_priority;
  if (!table || !Object.keys(table).length) return false;
  const waitMs = (cfg.fleet?.prefer_wait_minutes ?? 10) * 60_000;
  const since = Date.parse(meta.planned || meta.created);
  if (!Number.isNaN(since) && Date.now() - since > waitMs) return false;
  const me = hostName(cfg), mine = hostPriority(cfg, me), prefer = reqList(meta.prefer);
  return onlineHosts(cfg).some((h) => h.host !== me && hostPriority(cfg, h.host) > mine && matches(meta, h.caps)
    && prefer.every((r) => h.caps.includes(r)) && hostHasRoom(h));
}

/** A host's CPU pressure as its heartbeat reports it (0-1): measured utilisation when known, else load/cores. */
const heartPressure = (s: any): number => (s?.cpuBusyPct == null ? (s?.loadRatio ?? 0) : s.cpuBusyPct / 100);

/** Heavy work goes to the least-loaded capable online host. When no host has heavy headroom the copy waits forever
 *  and nothing says so: evolve-deep T-0032 sat 9h behind the 25% free-memory gate on the only online host, which sat
 *  at 17% of 24 GB. Like yieldToPreferred, that gate lapses after `heavy_wait_minutes` — memory only: the CPU side
 *  still holds, and allowedParallel already refuses to dispatch anything below the hard memory floor. */
function yieldHeavy(meta: Record<string, string>, cfg: Cfg, myLoad: number, heavyOk: boolean): boolean {
  if (meta.weight !== "heavy") return false;
  if (!heavyOk) {
    const created = Date.parse(meta.created ?? "");
    if (Number.isNaN(created) || Date.now() - created < (cfg.resources?.heavy_wait_minutes ?? 60) * 60_000) return true;
    return myLoad >= (cfg.resources?.heavy_max_load ?? 0.5); // never start heavy work on a saturated host
  }
  const me = hostName(cfg);
  return onlineHosts(cfg).some((h) => h.host !== me && matches(meta, h.caps) && h.stats
    && heartPressure(h.stats) + 0.2 < myLoad && h.busy === 0);
}

export function pickTask(cfg: Cfg, myLoad = 0, heavyOk = true): string | null {
  const caps = hostCaps(cfg);
  const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  const cands = list(P("tasks", "inbox"), /^T-.*\.md$/)
    .map((p) => ({ p, m: readDoc(p).meta }))
    // the planner decides where a task runs first; unplanned tasks wait for it (at most plan_wait_minutes)
    .filter(({ m }) => (m.planned || Date.now() - Date.parse(m.created ?? "") > (cfg.fleet?.plan_wait_minutes ?? 3) * 60_000) && matches(m, caps) && chooseCli(m, cfg) && !yieldToPreferred(m, caps, cfg) && !yieldToPriority(m, cfg) && !yieldHeavy(m, cfg, myLoad, heavyOk))
    .sort((a, b) => (rank[a.m.priority] ?? 2) - (rank[b.m.priority] ?? 2) || a.p.localeCompare(b.p));
  return cands[0]?.p ?? null;
}

/** Move inbox → active and push. The Worker's compare-and-swap commit is the distributed lock between machines. */
export const claim = (path: string, host: string) => locked(() => _claim(path, host));
async function _claim(path: string, host: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path);
  const { meta, body } = readDoc(path);
  const dest = P("tasks", "active", `${meta.id}.md`);
  writeDoc(dest, { ...meta, claimed_by: host, started: now(), host_caps: hostCaps(loadConfig()).join(",") }, body);
  unlinkSync(path);
  if (await _commitPush(`[${host}] claim ${meta.id}: ${meta.title}`)) return dest;
  // undo only our claim (other pending local results stay queued); after a lost race the pull already applied the winner
  sync.revertLocal([relative(DATA, dest), relative(DATA, path)]);
  // A claim of ours restored from the sync base is a stale copy: its delete never reached the Worker, so the base still
  // holds it. Keeping it makes the reaper fire on every tick and rewrite the requeued copy from it, resetting the
  // attempt and stall counters. A lost race restores the winner's claim instead, which names another host (one daemon
  // per host: a claim naming this host that no run owns is stale by definition).
  const back = existsSync(dest) ? readDoc(dest).meta : null;
  if (back?.claimed_by === host) rmSync(dest, { force: true });
  // a task queued here and not pushed yet has no synced copy to revert to: put it back rather than delete it
  if (!readdirSync(P("tasks")).some((d) => existsSync(P("tasks", d, `${meta.id}.md`)))) writeFileSync(path, raw);
  return null;
}

// ------------------------------------------------------------------ journal & memory
export function journal(host: string, line: string) {
  const f = P("journal", `${today()}.md`);
  if (!existsSync(f)) writeFileSync(f, `# Journal ${today()}\n\n`);
  appendFileSync(f, `- ${hhmm()} \`${host}\` ${line}\n`);
}

/** Torn-write protection (src/integrity.ts). A crash can leave a file at full length but zero-filled; sync refuses to push such
 *  a file. Here: memory files in that state are restored from the last good copy (sync-base, then the daily snapshots) and the
 *  restore is journaled; any other damaged file sync skipped is journaled once; one snapshot of the memory files per day goes to
 *  <home>/memory-snapshots (outside the data folder, never synced). `full` checks every memory file (daemon start); otherwise only
 *  the files sync reported since the last call. Never throws: this must not take the daemon down. Call it inside `locked`. */
export function guardMemory(host: string, opts: { full?: boolean } = {}) {
  try {
    const alerts = sync.takeDamageAlerts();
    const only = opts.full ? undefined : [...new Set(alerts.map((a) => a.path))];
    const { restored, unrecovered } = recoverMemory(DATA, sync.syncBaseDir(), sync.snapshotDir(), only);
    for (const r of restored) journal(host, L(`🩹 ${r.path} was zero-filled by a crash; restored ${r.bytes} bytes from ${r.from} (edits after that copy are lost)`, `🩹 ${r.path} 被崩溃写成全零；已从 ${r.from} 恢复 ${r.bytes} 字节（该副本之后的改动已丢失）`));
    for (const u of unrecovered) journal(host, L(`⚠️ ${u.path} is damaged (${u.nul} of ${u.bytes} bytes are NUL) and no good copy exists; it is not synced`, `⚠️ ${u.path} 已损坏（${u.bytes} 字节里有 ${u.nul} 个 NUL）且没有可用的好副本；不会同步它`));
    const handled = new Set([...restored.map((r) => r.path), ...unrecovered.map((u) => u.path)]);
    for (const a of alerts) {
      if (handled.has(a.path)) continue;
      journal(host, a.side === "remote"
        ? L(`⚠️ the cloud copy of ${a.path} is damaged (${a.nul} of ${a.bytes} bytes are NUL); the local copy replaces it on the next sync`, `⚠️ 云端的 ${a.path} 已损坏（${a.bytes} 字节里有 ${a.nul} 个 NUL）；下次同步用本机副本覆盖它`)
        : L(`⚠️ ${a.path} is damaged (${a.nul} of ${a.bytes} bytes are NUL); it is not synced`, `⚠️ ${a.path} 已损坏（${a.bytes} 字节里有 ${a.nul} 个 NUL）；不会同步它`));
    }
    const snap = snapshotMemory(DATA, sync.snapshotDir(), today());
    if (snap.skipped.length) journal(host, L(`⚠️ memory snapshot skipped damaged files: ${snap.skipped.join(", ")}`, `⚠️ 记忆快照跳过了损坏的文件：${snap.skipped.join("、")}`));
  } catch (e) { console.error("memory guard failed", e); }
}

export function remember(agent: string, lessons: string[] | undefined, source: string) {
  // a single lesson the model sent as a bare string (not the array the spec asks for) is still a lesson
  const list = (Array.isArray(lessons) ? lessons : typeof lessons === "string" ? [lessons] : [])
    .map(asText).map((l) => l.trim()).filter(Boolean);
  if (!list.length) return;
  const f = P("agents", agent, "memory.md");
  if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `# ${agent} memory\n\n`); }
  appendFileSync(f, list.map((l) => `- ${l} _(${source}, ${today()})_\n`).join(""));
}

export const readIf = (p: string, tail = 12000) => (existsSync(p) ? readFileSync(p, "utf8").slice(-tail) : "");

/** The last `tail` characters of a file, for a prompt. A cut start is announced: the opening of a file is usually where
 *  its standing rules sit, and dropping it silently leaves the reader with no idea there is more to read. */
export function readTail(p: string, tail = 12000): string {
  if (!existsSync(p)) return "";
  const s = readFileSync(p, "utf8");
  if (s.length <= tail) return s;
  return `[… the first ${s.length - tail} of ${s.length} characters are cut; read ${p} for them]\n${s.slice(-tail)}`;
}

/** Every .md of a folder, joined, last `tail` characters. The files that fall into the cut part are named, so a folder
 *  that outgrows its budget does not lose whole files (the alphabetically first ones) without a trace. */
export function readAll(dir: string, tail = 12000): string {
  const parts = list(dir).map((p) => ({ name: basename(p), text: `### ${p.split("/").pop()}\n${readFileSync(p, "utf8").trim()}` }));
  const joined = parts.map((x) => x.text).join("\n\n");
  if (joined.length <= tail) return joined;
  const cut = joined.length - tail;
  const gone: string[] = [];
  let partly = "";
  let at = 0;
  for (const x of parts) {
    const end = at + x.text.length;
    if (end <= cut) gone.push(x.name);
    else if (at < cut) partly = x.name;
    at = end + 2; // the blank line between two files
  }
  const note = `[… cut to the last ${tail} of ${joined.length} characters; not shown: ${gone.join(", ") || "none"}${partly ? `; partly shown: ${partly}` : ""}; read them in ${dir}]`;
  return `${note}\n${joined.slice(-tail)}`;
}

/** The hub's daily journal files; agents may leave other notes in journal/ that sort after them by name. */
export const JOURNAL_DAY = /^\d{4}-\d{2}-\d{2}\.md$/;
export const recentJournal = (days = 2) =>
  list(P("journal"), JOURNAL_DAY).slice(-days).map((p) => readFileSync(p, "utf8").slice(-4000)).join("\n");

export function precedents(n = 30): string {
  // the latest answers, not the last file names: by name every P-… batch and D-C… card sorts after every D-0… card
  const at = (m: Record<string, string>) => m.answered ?? m.created ?? "";
  return list(P("decisions", "closed")).map((p) => readDoc(p).meta)
    .filter((m) => !m.superseded_by && m.answered_by !== "system")
    .sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0)).slice(-n)
    .map((meta) => `- ${meta.id} [${meta.agent}] Q: ${meta.question}\n  → **${meta.answer}** (by ${meta.answered_by})`).join("\n");
}

/** The GitHub login `templates/config.toml` ships with. It is a real account, so signing "@your-github" pings a stranger
 *  on every comment an instance posts before its owner edits [owner] github. */
const TEMPLATE_GITHUB = "your-github";

export function signature(agent: string, host: string, cfg: Cfg) {
  const gh = (cfg.owner?.github ?? "").trim().replace(/^@/, "");
  const who = gh && gh !== TEMPLATE_GITHUB ? `@${gh}` : "its owner"; // no login → no mention at all
  return `🤖 [Noop](https://huacnlee.github.io/noop) (${agent}) · AI agent acting for ${who}`;
}

export function agentName(agent: string): string {
  const p = P("agents", agent, "profile.md");
  const m = existsSync(p) ? readFileSync(p, "utf8").match(/^Name:\s*(.+)$/m) : null;
  return m ? m[1].trim() : agent;
}
