// This machine's side of the team's shared secrets (cloud/src/secrets.ts has the why).
// With a Worker: values come from GET /api/secrets/values (machine key only). Without one: a 0600 file in HOME_DIR,
// beside noop.toml and outside the synced data. Values live in this process's memory and are handed only to the
// agent runs whose MCP servers name them.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SecretInfo, seal, secretProblem, unseal } from "../cloud/src/secrets";
import { type Cfg, HOME_DIR } from "./core";

const FILE = () => join(HOME_DIR, "secrets.json");
type Stored = Record<string, { sealed: string; updated: string }>;
const readFile = (): Stored => { try { return JSON.parse(readFileSync(FILE(), "utf8")); } catch { return {}; } };

/** Local server (no Worker): names only. */
export const localSecretList = (): SecretInfo[] =>
  Object.entries(readFile()).map(([name, s]) => ({ name, updated: s.updated })).sort((a, b) => a.name.localeCompare(b.name));

/** Local server (no Worker): set, replace or (empty value) delete one. */
export async function localSecretPut(cfg: Cfg, name: unknown, value: unknown): Promise<{ error: string } | { secrets: SecretInfo[] }> {
  const bad = secretProblem(name, value);
  if (bad) return { error: bad };
  const token = String(cfg.server?.token ?? "");
  if (!token) return { error: "no machine key" };
  const all = readFile();
  if (value === null || value === "") delete all[name as string];
  else all[name as string] = { sealed: await seal(token, name as string, value as string), updated: new Date().toISOString() };
  writeFileSync(FILE(), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  chmodSync(FILE(), 0o600);
  return { secrets: localSecretList() };
}

let cache: { at: number; values: Record<string, string> } = { at: 0, values: {} };
const FRESH_MS = 60_000;

/** The shared values, refreshed at most once a minute. A failed fetch keeps the last good set (a short outage must not
 *  drop every MCP server); nothing is ever written to disk on a Worker setup. */
export async function sharedSecrets(cfg: Cfg, fetcher: typeof fetch = fetch): Promise<Record<string, string>> {
  if (Date.now() - cache.at < FRESH_MS) return cache.values;
  const token = String(cfg.server?.token ?? "");
  const url = String(cfg.cloud?.url ?? "").replace(/\/$/, "");
  if (url && token) {
    const r = await fetcher(`${url}/api/secrets/values`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const j = r?.ok ? ((await r.json().catch(() => null)) as { values?: Record<string, string> } | null) : null;
    if (j?.values && typeof j.values === "object") cache = { at: Date.now(), values: j.values };
    return cache.values;
  }
  const values: Record<string, string> = {};
  if (token && existsSync(FILE())) for (const [n, s] of Object.entries(readFile())) {
    const v = await unseal(token, n, s.sealed);
    if (v !== null) values[n] = v;
  }
  cache = { at: Date.now(), values };
  return values;
}
export const _resetSecretCache = () => { cache = { at: 0, values: {} }; };
