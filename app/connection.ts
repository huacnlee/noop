// The hub client: the saved session, the page that served the app, and the live connection (feed, status, socket).
import { host, setColorScheme, signal, Storage, untracked } from "nsh";
import { L, lang, LANG_KEY } from "./i18n";
import { type Attachment, type HubEvent, merge, normalizeUrl, type SettingsView, type Status, wsUrl } from "./hub";

export type Config = { url: string; token: string };
/** `token` holds the login session (sent as `Bearer`, and `?token=` on the WebSocket and media URLs). */
export const KEYS = { url: "hub.url", token: "hub.token", email: "hub.email", theme: "hub.theme", seen: "hub.lastSeen", notifyOff: "hub.notifyOff", draft: "hub.draft" };

export type Page = { origin?: string; theme?: string | null; ref?: string | null };

/** A function of the page's host (host.js on the web: push, badge, ...); null where there is none or it failed. */
export async function hostCall<T>(name: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    if (!host.available()) return null;
    return ((await host.call(name, args ?? {})) ?? null) as T | null;
  } catch {
    return null;
  }
}

/** Where the app was served from on the web (nsh.json `web.host`); nothing elsewhere. */
export async function pageInfo(): Promise<Page> {
  try {
    if (!host.available()) return {};
    return ((await host.call("page")) ?? {}) as Page;
  } catch {
    return {};
  }
}

export type Boot = { config: Config | null; suggested: string; served: boolean; email: string; ref: string | null };

export async function loadConfig(): Promise<Boot> {
  const page = await pageInfo();
  if (page.theme === "light" || page.theme === "dark") setColorScheme(page.theme);
  else {
    const saved = await Storage.getItem(KEYS.theme);
    if (saved === "light" || saved === "dark") setColorScheme(saved);
  }
  const saved = await Storage.getItem(LANG_KEY);
  if (saved === "en" || saved === "zh") lang.set(saved);
  let url = (await Storage.getItem(KEYS.url)) ?? "";
  const token = (await Storage.getItem(KEYS.token)) ?? "";
  if (!url && page.origin) url = page.origin;
  const suggested = url || page.origin || "";
  const email = (await Storage.getItem(KEYS.email)) ?? "";
  return { config: url && token ? { url: normalizeUrl(url), token } : null, suggested, served: !!page.origin, email, ref: page.ref ?? null };
}

export type Conn = "connecting" | "live" | "offline" | "unauthorized" | "blocked";
/** The Worker's IP allow-list (HUB_ALLOW_IPS) turned this device away; `ip` is its address as the Worker saw it. */
export const ipBlocked = (status: number, data: unknown): string | null =>
  status === 403 && (data as { error?: unknown })?.error === "ip_blocked" ? String((data as { ip?: unknown }).ip ?? "?") : null;

/** Failed reconnects in a row before the owner hears about it; anything shorter recovers silently. */
export const OFFLINE_AFTER = 5;

export function createHub(cfg: Config) {
  const events = signal<HubEvent[]>([]);
  const status = signal<Status | null>(null);
  const conn = signal<Conn>("connecting");
  const blockedIp = signal("");
  const loaded = signal(false);
  const headers = { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" };
  let disposed = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  const last = () => {
    const evs = untracked(events);
    return evs.length ? evs[evs.length - 1].ts : "";
  };

  async function loadFeed() {
    const since = last();
    try {
      const r = await fetch(`${cfg.url}/api/feed${since ? `?since=${encodeURIComponent(since)}` : ""}`, { headers });
      if (r.status === 401) return conn.set("unauthorized");
      const body = (await r.json()) as { events: HubEvent[] };
      const ip = ipBlocked(r.status, body);
      if (ip) { blockedIp.set(ip); return conn.set("blocked"); } // retried with the socket: the device may change networks
      if (untracked(conn) === "blocked") conn.set("connecting");
      events.update((evs) => merge(evs, body.events));
    } catch {
      /* the socket's retries decide when this counts as offline */
    } finally {
      loaded.set(true);
    }
  }

  async function loadStatus() {
    try {
      const r = await fetch(`${cfg.url}/api/status`, { headers });
      if (r.ok) status.set((await r.json()) as Status);
    } catch {
      /* the feed reports the connection */
    }
  }

  function stream() {
    if (disposed || untracked(conn) === "unauthorized") return;
    const ws = new WebSocket(wsUrl(cfg.url, cfg.token));
    socket = ws;
    ws.onopen = () => {
      failures = 0;
      conn.set("live");
      loadStatus(); // whatever changed while disconnected; from here on the hub pushes it
    };
    ws.onmessage = (m: { data: unknown }) => {
      try {
        const d = JSON.parse(String(m.data)) as HubEvent & { $status?: Status };
        if (d.$status) status.set(d.$status);
        else events.update((evs) => merge(evs, [d]));
      } catch {
        /* not JSON */
      }
    };
    ws.onclose = () => {
      if (disposed) return;
      if (++failures >= OFFLINE_AFTER && untracked(conn) !== "unauthorized" && untracked(conn) !== "blocked") conn.set("offline");
      retry = setTimeout(async () => {
        await loadFeed();
        stream();
      }, 3000);
    };
  }

  /** Uploads one image the owner attaches; resolves with its media path ("/media/…"). */
  async function upload(a: Attachment): Promise<string> {
    const fd = new FormData();
    fd.append("file", a.file, a.name);
    const r = await fetch(`${cfg.url}/api/uploads`, { method: "POST", headers: { Authorization: headers.Authorization }, body: fd });
    if (r.status === 401) conn.set("unauthorized");
    if (!r.ok) throw new Error(L(`Image upload failed (${r.status})`, `图片上传失败（${r.status}）`));
    return ((await r.json()) as { url: string }).url;
  }

  async function send(text: string, replyTo: string | null, files: Attachment[] = [], thread = false, clientId?: string, channel?: string) {
    const attachments: string[] = [];
    for (const f of files) attachments.push(await upload(f));
    const r = await fetch(`${cfg.url}/api/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, ...(clientId ? { client_id: clientId } : {}), ...(replyTo ? { reply_to: replyTo } : {}), ...(attachments.length ? { attachments } : {}), ...(thread ? { thread } : {}), ...(channel ? { channel } : {}) }),
    });
    if (r.status === 401) conn.set("unauthorized");
    if (!r.ok) throw new Error(L(`Send failed (${r.status})`, `发送失败（${r.status}）`));
    const ev = (await r.json()) as HubEvent;
    if (ev?.id) events.update((evs) => merge(evs, [ev]));
    return ev?.id;
  }

  async function settings(patch?: Record<string, unknown>): Promise<SettingsView> {
    const r = await fetch(`${cfg.url}/api/settings`, patch ? { method: "PUT", headers, body: JSON.stringify(patch) } : { headers });
    if (r.status === 401) conn.set("unauthorized");
    if (!r.ok) throw new Error(L(`Couldn’t ${patch ? "save" : "load"} settings (${r.status})`, `设置${patch ? "保存" : "读取"}失败（${r.status}）`));
    return (await r.json()) as SettingsView;
  }

  /** A JSON call of the hub's API: never throws (status 0 when unreachable); a 401 ends the session. */
  async function api(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    try {
      const r = await fetch(`${cfg.url}${path}`, method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) });
      if (r.status === 401) conn.set("unauthorized");
      let data: Record<string, unknown> = {};
      try {
        data = ((await r.json()) ?? {}) as Record<string, unknown>;
      } catch {
        /* no body */
      }
      return { ok: r.ok, status: r.status, data };
    } catch {
      return { ok: false, status: 0, data: {} };
    }
  }

  async function logout() {
    try {
      await fetch(`${cfg.url}/api/auth/logout`, { method: "POST", headers });
    } catch {
      /* forgotten locally either way */
    }
  }

  loadFeed().then(stream);
  loadStatus();
  // the socket pushes the dashboard; only without it does the app poll, and slowly (Cloudflare free plan)
  const timer = setInterval(() => untracked(conn) !== "live" && loadStatus(), 120_000);
  const dispose = () => {
    disposed = true;
    clearInterval(timer);
    clearTimeout(retry);
    socket?.close();
  };
  return { events, status, conn, blockedIp, loaded, send, settings, api, logout, dispose, cfg };
}
export type Hub = ReturnType<typeof createHub>;
