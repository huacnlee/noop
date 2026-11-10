// Multi-account rotation for Claude Code / Codex + remote-assisted login via Slack/Discord.
// Accounts are per machine (credentials never enter the shared data repo):
//   ~/.noop/accounts/<cli>-<name>/   → CLAUDE_CONFIG_DIR or CODEX_HOME for that account
//   ~/.noop/accounts/state.json      → cooldowns, auth status, pending logins
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Cfg, L, hostName, journal, HOME_DIR } from "./core";
import { notify } from "./notify";
import { quotaRecovery, type Recovery } from "./quota";

const HOME = join(HOME_DIR, "accounts");
const STATE = join(HOME, "state.json");

export type Account = { cli: string; name: string; dir: string; default?: boolean };
type AState = { cooldown_until?: string; needs_login?: boolean; last_error?: string; login_id?: string; token?: string; cred?: number; told?: string };
type State = { accounts: Record<string, AState>; seq: number; alerted?: Record<string, string> };

const load = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { accounts: {}, seq: 0 });
/** Serialize local writers and publish complete JSON, so the bridge cannot clobber daemon updates. */
function updateState<T>(change: (state: State) => T): T {
  mkdirSync(HOME, { recursive: true });
  // SQLite's local OS lock is released even if a writer crashes; no PID/lease stealing race.
  // This database stores no account data. JSON stays readable by existing tools.
  const lock = new Database(join(HOME, "state-lock.sqlite"));
  lock.exec("PRAGMA busy_timeout = 5000");
  const temp = join(HOME, `state.${process.pid}.tmp`);
  try {
    lock.exec("BEGIN IMMEDIATE");
    const state = load();
    const result = change(state);
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temp, STATE);
    lock.exec("COMMIT");
    return result;
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    lock.close();
  }
}
const key = (a: Account) => `${a.cli}-${a.name}`;

/** Configured accounts; a CLI with none configured uses its normal default login. */
export function accounts(cfg: Cfg, cli: string): Account[] {
  const list: Account[] = (cfg.accounts ?? []).filter((a: Account) => a.cli === cli)
    .map((a: Account) => ({ ...a, dir: (a.dir ?? join(HOME, `${a.cli}-${a.name}`)).replace(/^~/, homedir()) }));
  return list.length ? list : [{ cli, name: "default", dir: "", default: true }];
}

/** When the CLI's login was last written: a new login (another account) changes it. */
function credStamp(a: Account): number {
  const dir = a.default ? join(homedir(), a.cli === "claude" ? ".claude" : ".codex") : a.dir;
  const f = join(dir, a.cli === "claude" ? ".credentials.json" : "auth.json");
  try { return statSync(f).mtimeMs; } catch { return 0; }
}

export function usable(a: Account): boolean {
  const all = load();
  const s = all.accounts[key(a)] ?? {};
  if ((s.needs_login || s.cooldown_until) && s.cred && credStamp(a) > s.cred) {
    // the owner logged in again (maybe another account): try it right away instead of waiting out the old limit
    updateState(state => {
      const current = state.accounts[key(a)] ?? {};
      if (current.cred && credStamp(a) > current.cred)
        state.accounts[key(a)] = { ...current, needs_login: false, cooldown_until: undefined, cred: undefined, told: undefined };
    });
    return true;
  }
  if (s.needs_login) return false;
  return !s.cooldown_until || Date.parse(s.cooldown_until) < Date.now();
}

/** Pick an available (cli, account) honoring preference order. */
export function pickAccount(cfg: Cfg, clis: string[]): Account | null {
  for (const cli of clis) for (const a of accounts(cfg, cli)) if (usable(a)) return a;
  return null;
}

const OTHER_CLI: Record<string, string> = { claude: "codex", codex: "claude" };

/** After `failed` hit a quota/login wall (or nothing in `wanted` is usable when failed is null):
 *  another usable account of the same CLI first, else the other CLI (codex <-> claude) — for any agent. */
export function failoverAccount(cfg: Cfg, failed: Account | null, wanted: string[], installed: (cli: string) => boolean = (c) => !!Bun.which(c)): Account | null {
  const same = failed ? [failed.cli] : wanted;
  const first = same.filter(installed);
  for (const cli of first) for (const a of accounts(cfg, cli)) if (usable(a) && !(failed && key(a) === key(failed))) return a;
  const others = [...new Set(same.map((c) => OTHER_CLI[c]).filter((c) => c && !first.includes(c) && installed(c)))];
  return pickAccount(cfg, others);
}

export function accountEnv(a: Account): Record<string, string> {
  const env: Record<string, string> = {};
  if (a.default) return env;
  mkdirSync(a.dir, { recursive: true });
  if (a.cli === "claude") {
    env.CLAUDE_CONFIG_DIR = a.dir;
    const tok = load().accounts[key(a)]?.token;
    if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
  }
  if (a.cli === "codex") env.CODEX_HOME = a.dir;
  return env;
}

// ------------------------------------------------------------------ failure classification
const QUOTA = /usage limit|rate[ -]?limit|limit reached|quota|credit balance is too low|too many requests|\b429\b|overloaded|hit your .*limit|try again (at|in)/i;
const AUTH = /not logged in|please run \/login|invalid api key|authentication[_ ]error|\b401\b|oauth token (has )?expired|login required|unauthorized|codex login/i;

export type Failure = "quota" | "auth" | null;

export function classify(output: string): Failure {
  const tail = output.slice(-4000);
  if (AUTH.test(tail)) return "auth";
  if (QUOTA.test(tail)) return "quota";
  return null;
}

/** Shared by the daemon and second-review; only this machine's account state is written. */
export function recordQuota(a: Account, output: string, now = Date.now()): Recovery {
  const recovery = quotaRecovery(output, now);
  updateState(s => { s.accounts[key(a)] = { ...s.accounts[key(a)], cooldown_until: recovery.until, cred: credStamp(a) }; });
  return recovery;
}

/** Read-only check for wait_check commands. A newer login invalidates the old cooldown. */
export function accountRecovery(a: Account): { available: boolean; until?: string; reason?: string } {
  const st = load().accounts[key(a)] ?? {};
  if (st.cred && credStamp(a) > st.cred) return { available: true };
  if (st.needs_login) return { available: false, reason: "auth" };
  if (st.cooldown_until && Date.parse(st.cooldown_until) > Date.now())
    return { available: false, reason: "quota", until: st.cooldown_until };
  return { available: true };
}

export async function reportFailure(a: Account, kind: Failure, output: string, cfg: Cfg) {
  if (!kind) return;
  if (kind === "quota") recordQuota(a, output);
  const host = hostName(cfg);
  const { st, tell } = updateState(s => {
    const st = (s.accounts[key(a)] ??= {});
    st.last_error = output.slice(-300);
    st.cred = credStamp(a);
    const tell = kind === "quota" && st.told !== st.cooldown_until;
    if (tell) st.told = st.cooldown_until;
    if (kind === "auth") st.needs_login = true;
    return { st: { ...st }, tell };
  });
  if (kind === "quota") {
    journal(host, `${key(a)} hit usage limit → cooldown until ${st.cooldown_until!.slice(11, 16)}Z`);
    if (tell) {
      const others = (cfg.clis?.preference ?? ["claude", "codex"]).filter((c: string) => c !== a.cli && Bun.which(c) && accounts(cfg, c).some(usable));
      const at = new Date(st.cooldown_until!).toLocaleTimeString(L("en-US", "zh-CN"), { hour: "2-digit", minute: "2-digit" });
      void notify([L(`${a.cli === "claude" ? "Claude" : "Codex"} (${host}) is out of quota, back around ${at}.`, `${a.cli === "claude" ? "Claude" : "Codex"}（${host}）额度用完了，约 ${at} 恢复。`),
        others.length ? L(`Until then tasks go to ${others.join(", ")}.`, `这期间任务先交给 ${others.join("、")} 做。`) : L("No AI is available until then, tasks will queue.", "这期间没有可用的 AI，任务会排队等着。"),
        L(`To recover now: run ${a.cli === "claude" ? "claude /login" : "codex login"} on this machine to switch account; it is picked up automatically.`, `想马上恢复：在这台机器上运行 ${a.cli === "claude" ? "claude /login" : "codex login"} 换个账号，登录后会自动接着用，不用等。`)].join("\n"),
        cfg, { kind: "notice" });
    }
  } else journal(host, `🔑 ${key(a)} needs login`);
  if (kind === "auth") await startLogin(a, cfg);
  await alertIfAllExhausted(cfg);
}

async function alertIfAllExhausted(cfg: Cfg) {
  const clis: string[] = cfg.clis?.preference ?? ["claude", "codex"];
  const installed = clis.filter((c) => Bun.which(c));
  if (pickAccount(cfg, installed)) return;
  const tell = updateState(s => {
    const last = s.alerted?.all ? Date.parse(s.alerted.all) : 0;
    if (Date.now() - last < 3 * 3600_000) return false;
    (s.alerted ??= {}).all = new Date().toISOString();
    return true;
  });
  if (!tell) return;
  const lines = installed.flatMap((c) => accounts(cfg, c)).map((a) => {
    const st = load().accounts[key(a)] ?? {};
    return L(`• ${key(a)}: ${st.needs_login ? "needs login" : st.cooldown_until ? `out of quota, back around ${new Date(st.cooldown_until).toLocaleTimeString()}` : "?"}`, `• ${key(a)}：${st.needs_login ? "需要登录" : st.cooldown_until ? `额度用尽，约 ${new Date(st.cooldown_until).toLocaleTimeString()} 恢复` : "?"}`);
  });
  await notify([L(`All AI accounts on ${hostName(cfg)} are unavailable, the fleet is paused:`, `${hostName(cfg)} 上所有 AI 账户都不可用，fleet 暂停中：`), ...lines,
    L(`Options: reply with a login code to finish a pending login, or add an account under [[accounts]] in config.local.toml.`, `可以：回复登录码完成待登录账户，或在 config.local.toml 的 [[accounts]] 加一个账户。`)].join("\n"), cfg);
}

// ------------------------------------------------------------------ remote-assisted login
type Pending = { id: string; account: string; proc: ReturnType<typeof Bun.spawn>; started: number };
const pending = new Map<string, Pending>();

function loginCommand(a: Account): { cmd: string[]; needsCode: boolean } {
  if (a.cli === "codex") return { cmd: ["codex", "login", "--device-auth"], needsCode: false };
  // claude setup-token prints an OAuth URL, waits for the pasted code, then prints a long-lived token
  return { cmd: ["claude", "setup-token"], needsCode: true };
}

/** Wrap in `script` so TUIs think they have a terminal (headless box, no monitor). */
function withPty(cmd: string[]): string[] {
  const q = cmd.map((c) => `'${c}'`).join(" ");
  if (process.platform === "linux" && Bun.which("script")) return ["script", "-qfec", q, "/dev/null"];
  if (process.platform === "darwin") return ["script", "-q", "/dev/null", ...cmd];
  return cmd;
}

export async function startLogin(a: Account, cfg: Cfg) {
  const k = key(a);
  if ([...pending.values()].some((p) => p.account === k)) return;
  const id = updateState(s => {
    const id = `L-${String(++s.seq).padStart(4, "0")}`;
    s.accounts[k] = { ...(s.accounts[k] ?? {}), login_id: id };
    return id;
  });
  const { cmd, needsCode } = loginCommand(a);
  const proc = Bun.spawn(withPty(cmd), {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...accountEnv(a), BROWSER: "/bin/false", TERM: "xterm-256color", COLUMNS: "500" },
  });
  pending.set(id, { id, account: k, proc, started: Date.now() });
  let buf = "";
  let sent = false;
  const host = hostName(cfg);
  const strip = (t: string) => t.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "");
  const onData = async (chunk: string) => {
    buf += strip(chunk);
    const url = buf.match(/https:\/\/\S+/)?.[0];
    const code = buf.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/)?.[1]; // device code (codex)
    if (url && !sent && (needsCode || code || buf.length > 2000 || /enter|code/i.test(buf))) {
      sent = true;
      await notify([
        L(`🔑 *${id}* · the ${a.cli} account "${a.name}" on ${host} needs to log in again`, `🔑 *${id}* · ${host} 上的 ${a.cli} 账户「${a.name}」需要重新登录`),
        L(`1. Open: ${url}`, `1. 打开：${url}`),
        code ? L(`2. Enter the device code: \`${code}\` (takes effect automatically, no reply needed)`, `2. 输入设备码：\`${code}\`（完成后会自动生效，无需回复）`) : L(`2. After logging in, reply with the code the page gives you: \`${id} <code>\``, `2. 登录后把页面给出的授权码回复：\`${id} <code>\``),
      ].join("\n"), cfg);
      journal(host, `🔑 ${id} login link sent for ${k}`);
    }
    const token = buf.match(/\b(sk-ant-oat[\w-]+)/)?.[1];
    if (token) updateState(st => { st.accounts[k] = { ...st.accounts[k], token }; });
  };
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const c of stream) await onData(dec.decode(c));
  };
  void Promise.all([pump(proc.stdout as ReadableStream), pump(proc.stderr as ReadableStream)]);
  proc.exited.then(async (code) => {
    pending.delete(id);
    const ok = code === 0;
    updateState(st => { st.accounts[k] = { ...st.accounts[k], needs_login: !ok, login_id: undefined, cooldown_until: undefined }; });
    journal(host, ok ? `${k} logged in (${id})` : `${k} login ${id} failed (exit ${code})`);
    await notify(ok ? L(`${k} logged in, the fleet continues`, `${k} 登录成功，fleet 继续运转`) : L(`${id} login did not finish (exit ${code}), a new link will follow`, `${id} 登录未完成（exit ${code}），稍后会再发新链接`), cfg);
  });
  setTimeout(() => { if (pending.has(id)) proc.kill(); }, 30 * 60_000); // link expiry
}

export const pendingLoginIds = () => new Set(pending.keys());

export function submitLoginCode(id: string, code: string): boolean {
  const p = pending.get(id);
  if (!p) return false;
  const stdin = p.proc.stdin as import("bun").FileSink;
  stdin.write(code.trim() + "\r");
  stdin.flush();
  return true;
}

/** Periodically retry logins for accounts still flagged (e.g. after an expired link). */
const lastLoginTry = new Map<string, number>();
export async function retryLogins(cfg: Cfg) {
  const s = load();
  for (const cli of ["claude", "codex"]) for (const a of accounts(cfg, cli)) {
    const st = s.accounts[key(a)];
    // back off: a login that exits immediately would otherwise send a new link every tick
    if (Date.now() - (lastLoginTry.get(key(a)) ?? 0) < 30 * 60_000) continue;
    if (st?.needs_login && !pending.size && Bun.which(cli)) { lastLoginTry.set(key(a), Date.now()); await startLogin(a, cfg); }
  }
}

/** Structured account states for this machine (the app's machine page). */
export function accountsInfo(cfg: Cfg): { cli: string; name: string; state: "ok" | "cooldown" | "login"; until?: string }[] {
  const s = load();
  return ["claude", "codex"].filter((c) => Bun.which(c)).flatMap((c) => accounts(cfg, c)).map((a) => {
    const st = s.accounts[key(a)] ?? {};
    const cool = !!st.cooldown_until && Date.parse(st.cooldown_until) > Date.now();
    return { cli: a.cli, name: a.name, state: st.needs_login ? "login" : cool ? "cooldown" : "ok", until: cool ? st.cooldown_until : undefined };
  });
}

export function accountsStatus(cfg: Cfg): string[] {
  const s = load();
  return ["claude", "codex"].filter((c) => Bun.which(c)).flatMap((c) => accounts(cfg, c)).map((a) => {
    const st = s.accounts[key(a)] ?? {};
    const state = st.needs_login ? "needs login" : st.cooldown_until && Date.parse(st.cooldown_until) > Date.now()
      ? `cooldown → ${new Date(st.cooldown_until).toLocaleTimeString()}` : "ok";
    return `${key(a).padEnd(20)} ${state}`;
  });
}
