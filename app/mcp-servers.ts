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

/** Claude Code's `--mcp-config` JSON. Claude expands `${VAR}` itself, so no secret ends up in the command line. */
export function claudeMcpConfig(list: McpServer[]): string {
  const servers = Object.fromEntries(list.map((s) => [s.name, s.type === "http"
    ? { type: "http", url: s.url, ...(Object.keys(s.headers ?? {}).length ? { headers: s.headers } : {}) }
    : { type: "stdio", command: s.command, args: s.args ?? [], ...(Object.keys(s.env ?? {}).length ? { env: s.env } : {}) }]));
  return JSON.stringify({ mcpServers: servers });
}

const toml = (v: string) => JSON.stringify(v); // a TOML basic string has JSON's escapes
const tomlTable = (m: Record<string, string>) => `{${Object.entries(m).map(([k, v]) => `${toml(k)}=${toml(v)}`).join(",")}}`;

/** Codex `-c mcp_servers.<name>=…` overrides. A value that is exactly `${NAME}` for the same key is passed through
 *  (`env_vars`) instead of being written out; other references are filled from the machine's environment. */
export function codexMcpArgs(list: McpServer[], env: Record<string, string | undefined>): string[] {
  return list.flatMap((s) => {
    const parts: string[] = [];
    if (s.type === "http") {
      parts.push(`url=${toml(s.url!)}`);
      const headers = { ...(s.headers ?? {}) };
      const auth = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
      const bearer = auth ? headers[auth]!.match(/^Bearer \$\{([A-Za-z_]\w*)\}$/) : null;
      if (auth && bearer) { parts.push(`bearer_token_env_var=${toml(bearer[1]!)}`); delete headers[auth]; }
      const rest = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, fill(v, env)]));
      if (Object.keys(rest).length) parts.push(`http_headers=${tomlTable(rest)}`);
    } else {
      parts.push(`command=${toml(fill(s.command!, env))}`, `args=[${(s.args ?? []).map((a) => toml(fill(a, env))).join(",")}]`);
      const pass: string[] = [], set: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.env ?? {})) v === `\${${k}}` ? pass.push(k) : (set[k] = fill(v, env));
      if (pass.length) parts.push(`env_vars=[${pass.map(toml).join(",")}]`);
      if (Object.keys(set).length) parts.push(`env=${tomlTable(set)}`);
    }
    return ["-c", `mcp_servers.${s.name}={${parts.join(",")}}`];
  });
}
