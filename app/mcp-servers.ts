// MCP servers the owner shares with every machine (settings `mcp_servers`, kept in the data repo's settings.json).
// Pure: the app edits them, the server validates them, the runner hands them to Claude Code and Codex.
//
// The data repo syncs through the cloud, so it never holds a secret. A value that needs one (an API key in `env`,
// an Authorization header) names an environment variable instead, `${GITHUB_TOKEN}`, and each machine fills it from
// its own environment when it starts an agent. A server whose variables a machine lacks is left out on that machine.

export type McpServer = {
  name: string;
  /** stdio: a command the machine starts; http: a remote server at `url`. */
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Off keeps the entry but no agent gets it. */
  enabled?: boolean;
};

export const MCP_NAME = /^[A-Za-z0-9][\w-]{0,39}$/;
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Tokens with a well-known shape, and long opaque strings: never stored, reference a variable instead. */
const SECRET = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|glpat-[\w-]{16,})\b|^(Bearer|Basic|token)\s+(?!\$\{)\S{12,}$|^[A-Za-z0-9+/_=.-]{32,}$/i;

export const looksSecret = (value: string) => SECRET.test(value.replace(VAR, "").trim() === "" ? "" : value.trim());

/** The settings' list, with anything malformed left out. */
export function mcpServers(list: unknown): McpServer[] {
  if (!Array.isArray(list)) return [];
  const strMap = (m: unknown) => (m && typeof m === "object" && !Array.isArray(m)
    ? Object.fromEntries(Object.entries(m).filter(([k, v]) => k && typeof v === "string")) as Record<string, string> : undefined);
  return list.flatMap((s): McpServer[] => {
    if (!s || typeof s !== "object" || typeof s.name !== "string" || !MCP_NAME.test(s.name)) return [];
    const type = s.type === "http" ? "http" : "stdio";
    const out: McpServer = { name: s.name, type, enabled: s.enabled !== false };
    if (type === "stdio") {
      if (typeof s.command !== "string" || !s.command.trim()) return [];
      out.command = s.command.trim();
      out.args = Array.isArray(s.args) ? s.args.filter((a: unknown): a is string => typeof a === "string") : [];
      out.env = strMap(s.env) ?? {};
    } else {
      if (typeof s.url !== "string" || !/^https?:\/\//.test(s.url)) return [];
      out.url = s.url.trim();
      out.headers = strMap(s.headers) ?? {};
    }
    return [out];
  });
}

/** What is wrong with one entry, or null. Codes, so the app and the server word them each in their own way. */
export function mcpProblem(s: McpServer, others: McpServer[] = []): null | { code: "name" | "duplicate" | "command" | "url" | "secret"; field?: string } {
  if (!MCP_NAME.test(s.name)) return { code: "name" };
  if (others.some((o) => o.name === s.name)) return { code: "duplicate" };
  if (s.type === "stdio" && !s.command?.trim()) return { code: "command" };
  if (s.type === "http" && !/^https?:\/\/\S+$/.test(s.url ?? "")) return { code: "url" };
  const values: [string, string][] = [
    ...Object.entries(s.env ?? {}), ...Object.entries(s.headers ?? {}),
    ...(s.args ?? []).map((a, i): [string, string] => [`arg ${i + 1}`, a]), ["url", s.url ?? ""],
  ];
  const bad = values.find(([, v]) => looksSecret(v));
  return bad ? { code: "secret", field: bad[0] } : null;
}

/** Problems of the whole list (first one), for the server before it writes. */
export function mcpListProblem(list: McpServer[]): null | { name: string; code: string; field?: string } {
  for (let i = 0; i < list.length; i++) {
    const p = mcpProblem(list[i]!, list.slice(0, i));
    if (p) return { name: list[i]!.name, ...p };
  }
  return null;
}

// ---------------------------------------------------------------- editing as text (one "KEY=value" per line)

export const formatPairs = (m: Record<string, string> | undefined, sep = "=") => Object.entries(m ?? {}).map(([k, v]) => `${k}${sep}${v}`).join("\n");
export function parsePairs(text: string, sep: "=" | ":" = "="): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
/** A command line split like a shell would (quotes kept together), first word the command. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(line));) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}
export const joinCommand = (parts: string[]) => parts.map((p) => (/[\s"]/.test(p) ? `'${p}'` : p)).join(" ");

// ---------------------------------------------------------------- handing them to the agent CLIs

/** The variables an entry needs from the machine. */
export function mcpVars(s: McpServer): string[] {
  const all = [...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {}), ...(s.args ?? []), s.command ?? "", s.url ?? ""].join("\n");
  return [...new Set([...all.matchAll(VAR)].map((m) => m[1]!))];
}

/** The variable a machine receives a signed-in server's access token in (cloud/src/mcp-oauth.ts signs in). */
export const oauthVar = (server: string) => `NOOP_OAUTH_${server.replace(/\W/g, "_").toUpperCase()}`;

/** Remote servers without their own Authorization header use the shared sign-in when there is one. */
export function withOAuth(list: McpServer[], env: Record<string, string | undefined>): McpServer[] {
  return list.map((s) => {
    if (s.type !== "http" || !env[oauthVar(s.name)] || Object.keys(s.headers ?? {}).some((k) => k.toLowerCase() === "authorization")) return s;
    return { ...s, headers: { ...s.headers, Authorization: `Bearer \${${oauthVar(s.name)}}` } };
  });
}

/** On this machine: the enabled entries whose variables are all set, and the names left out for a missing one. */
export function usableMcp(list: McpServer[], env: Record<string, string | undefined>): { use: McpServer[]; missing: { name: string; vars: string[] }[] } {
  const use: McpServer[] = [], missing: { name: string; vars: string[] }[] = [];
  for (const s of list) {
    if (s.enabled === false) continue;
    const lack = mcpVars(s).filter((v) => !env[v]);
    if (lack.length) missing.push({ name: s.name, vars: lack });
    else use.push(s);
  }
  return { use, missing };
}

const fill = (v: string, env: Record<string, string | undefined>) => v.replace(VAR, (_, k) => env[k] ?? "");

/** Claude Code's `--mcp-config` JSON. Without `env` the `${VAR}` references stay for Claude to expand; with it they are
 *  filled in, for the private file the runner hands Claude (so a key is never in the agent's environment or argv). */
export function claudeMcpConfig(list: McpServer[], env?: Record<string, string | undefined>): string {
  const f = (v: string) => (env ? fill(v, env) : v);
  const map = (m: Record<string, string> | undefined) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, f(v)]));
  const servers = Object.fromEntries(list.map((s) => [s.name, s.type === "http"
    ? { type: "http", url: f(s.url!), ...(Object.keys(s.headers ?? {}).length ? { headers: map(s.headers) } : {}) }
    : { type: "stdio", command: f(s.command!), args: (s.args ?? []).map(f), ...(Object.keys(s.env ?? {}).length ? { env: map(s.env) } : {}) }]));
  return JSON.stringify({ mcpServers: servers });
}

const toml = (v: string) => JSON.stringify(v); // a TOML basic string has JSON's escapes
const tomlTable = (m: Record<string, string>) => `{${Object.entries(m).map(([k, v]) => `${toml(k)}=${toml(v)}`).join(",")}}`;
const hasVar = (v: string) => /\$\{[A-Za-z_]\w*\}/.test(v);

/** Codex `-c mcp_servers.<name>=…` overrides, and the environment Codex must be started with. A value that names a
 *  variable never lands in the arguments: it goes through Codex's env indirections (`env_vars`, `bearer_token_env_var`,
 *  `env_http_headers`), filled into `env`. Plain values stay inline. */
export function codexMcpLaunch(list: McpServer[], env: Record<string, string | undefined>): { args: string[]; env: Record<string, string> } {
  const out: Record<string, string> = {};
  const via = (name: string, v: string) => { out[name] = fill(v, env); return name; };
  const args = list.flatMap((s, si) => {
    const parts: string[] = [];
    const tag = `NOOP_MCP_${si}_${s.name.replace(/\W/g, "_").toUpperCase()}`;
    if (s.type === "http") {
      parts.push(`url=${toml(fill(s.url!, env))}`);
      const plain: Record<string, string> = {}, viaEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.headers ?? {})) {
        const bearer = k.toLowerCase() === "authorization" ? v.match(/^Bearer (.*)$/) : null;
        if (bearer && hasVar(v)) {
          const m = bearer[1]!.match(/^\$\{([A-Za-z_]\w*)\}$/);
          parts.push(`bearer_token_env_var=${toml(m ? via(m[1]!, bearer[1]!) : via(`${tag}_BEARER`, bearer[1]!))}`);
        } else if (hasVar(v)) viaEnv[k] = via(`${tag}_H${Object.keys(viaEnv).length}`, v);
        else plain[k] = v;
      }
      if (Object.keys(plain).length) parts.push(`http_headers=${tomlTable(plain)}`);
      if (Object.keys(viaEnv).length) parts.push(`env_http_headers=${tomlTable(viaEnv)}`);
    } else {
      parts.push(`command=${toml(fill(s.command!, env))}`, `args=[${(s.args ?? []).map((a) => toml(fill(a, env))).join(",")}]`);
      const pass: string[] = [], set: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.env ?? {})) hasVar(v) ? pass.push(via(k, v)) : (set[k] = v);
      if (pass.length) parts.push(`env_vars=[${pass.map(toml).join(",")}]`);
      if (Object.keys(set).length) parts.push(`env=${tomlTable(set)}`);
    }
    return ["-c", `mcp_servers.${s.name}={${parts.join(",")}}`];
  });
  return { args, env: out };
}
