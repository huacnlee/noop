// noop: the demo server. Signing in as the test account (demo@noop.dev), or entering "demo" as the server address, talks to this
// in-memory hub instead of a Worker: a small simulated team with a fleet, tasks, cards, channels and files. Nothing leaves
// the device, so it serves App Store review, screenshots and UI work without anyone's real server.
// `scripts/demo-server.ts` serves the same hub over HTTP and WebSocket for local development of the real network path.
import { L } from "./i18n";
import type { HubEvent, Status, TaskInfo, SettingsView } from "./hub";
import type { Channel } from "./channels";

/** normalizeUrl("demo"): the address that selects the demo. */
export const DEMO_URL = "http://demo";
export const DEMO_TOKEN = "demo";
export const DEMO_EMAIL = "demo@noop.dev";
/** The demo accepts any codes; these are the ones the sign-in page and the review notes suggest. */
export const DEMO_CODE = "DEMO2026";
export const DEMO_TOTP = "000000";

export const isDemo = (url: string) => /^https?:\/\/demo(\/|$)/i.test(url.trim()) || url.trim().toLowerCase() === "demo";

type Reply = { status: number; data: unknown; text?: string };
type Listener = (frame: string) => void;
type Task = TaskInfo & { channel?: string };
type Card = { id: string; kind: string; question: string; held: boolean; task?: string; options: string[]; open: boolean };

const MIN = 60_000;

/** A simulated hub: the Worker's owner API over in-memory state, plus a team that answers and works. */
export function createDemoHub(opts: { now?: () => number; pace?: number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const pace = opts.pace ?? 1; // 0 in tests: the team answers at once
  const iso = (agoMin = 0) => new Date(now() - agoMin * MIN).toISOString();
  const listeners = new Set<Listener>();
  let seq = 0, taskSeq = 120, cardSeq = 40;

  const events: HubEvent[] = [];
  const tasks: Task[] = [];
  const cards: Card[] = [];
  const channels: { slug: string; name: string; goal: string; created: string; archived: boolean }[] = [];
  const files = new Map<string, { content: string; updated: string }>();
  const docs = new Map<string, string>();
  let demoSecrets: { name: string; updated: string }[] = [];
  const DEMO_IP = "203.0.113.7";
  let demoAllowList: string[] = [];
  const demoAllow = () => ({ entries: demoAllowList.map((value) => ({ value, mine: value === DEMO_IP || value === "203.0.113.0/24" })), on: demoAllowList.length > 0, ip: DEMO_IP, machines: [], pending: null });
  let settingsView: SettingsView;

  function emit(e: Omit<HubEvent, "id" | "ts"> & { ts?: string }): HubEvent {
    const ev = { id: `demo-${++seq}`, ts: e.ts ?? iso(), ...e } as HubEvent;
    events.push(ev);
    return ev;
  }
  const push = (frame: unknown) => { const s = JSON.stringify(frame); for (const l of listeners) l(s); };
  const say = (e: Omit<HubEvent, "id" | "ts">) => { const ev = emit(e); push(ev); return ev; };
  const pushStatus = () => push({ $status: status() });
  const later = (ms: number, fn: () => void) => (pace ? setTimeout(fn, ms * pace) : fn());

  // ---------------------------------------------------------------- the seeded team
  function seed() {
    const t = (id: string, title: string, agent: string, state: string, ago: number, extra: Partial<Task> = {}): Task => ({
      id, title, agent, state, host: agent === "dev" ? "linux-box" : "studio", created: iso(ago + 30), started: iso(ago + 25),
      updated: iso(ago), ...(state === "done" ? { finished: iso(ago) } : {}), cli: "claude", ...extra,
    });
    tasks.push(
      t("T-0118", L("Weekly dependency audit", "每周依赖检查"), "dev", "active", 2, {
        request: L("Check every repo for outdated or vulnerable dependencies and open PRs for safe upgrades.", "检查所有仓库里过期或有漏洞的依赖，安全的升级直接开 PR。"),
        activity: { at: iso(1), step: "Bash · npm outdated", steps: 14 },
      }),
      t("T-0117", L("Draft the launch blog post", "起草发布博客"), "lead", "active", 5, {
        request: L("Write a launch post for the new website, friendly and short.", "给新网站写一篇发布博客，亲切简短。"),
        activity: { at: iso(0), step: "Write · posts/launch.md", steps: 6 }, channel: "website",
      }),
      t("T-0116", L("Fix the flaky login test", "修复不稳定的登录测试"), "dev", "done", 40, {
        request: L("The login test fails one run in ten on CI. Find out why and fix it.", "登录测试在 CI 上十次挂一次，查清原因并修好。"),
        runs: [{ ts: iso(40), host: "linux-box", cli: "claude", status: "done", summary: L("Fixed: the test raced the session cookie. PR #42 waits for it; 50 CI runs passed.", "修好了：测试和 session cookie 有竞争。PR #42 改为等待 cookie，CI 连跑 50 次全过。") }],
      }),
      t("T-0115", L("Compress the website images", "压缩网站图片"), "lead", "done", 180, { channel: "website" }),
      t("T-0114", L("Summarise this week's issues", "汇总本周 issue"), "lead", "done", 60 * 26),
      t("T-0113", L("Translate the docs into Chinese", "把文档翻译成中文"), "lead", "inbox", 3),
    );
    channels.push({ slug: "website", name: L("Website", "网站改版"), goal: L("Launch the new website by Friday", "周五前上线新网站"), created: iso(60 * 50), archived: false });
    cards.push(
      { id: "D-0041", kind: "decision", question: L("Merge PR #42 (flaky login test fix)?", "合并 PR #42（登录测试修复）吗？"), held: true, task: "T-0116", open: true,
        options: [L("A: Merge it", "A: 合并"), L("B: Wait for another review", "B: 等再审一次"), L("C: Close it", "C: 关闭")] },
      { id: "P-0007", kind: "proposals", question: L("Routine suggestions", "例行任务建议"), held: false, open: true,
        options: [L("1 Check broken links on the website every day", "1 每天检查网站死链"), L("2 Post a Friday summary of finished work", "2 每周五总结完成的工作"), "all", "none"] },
    );

    docs.set("/media/demo-report.md", L(
      "# Flaky login test\n\n**Cause:** the test clicked *Sign in* before the session cookie was written, so one run in ten saw no session.\n\n**Fix:** wait for the cookie before navigating (PR #42).\n\n| Runs | Before | After |\n|---|---|---|\n| CI | 45 / 50 | 50 / 50 |\n",
      "# 登录测试不稳定\n\n**原因：**测试在 session cookie 写入前就点了「登录」，所以十次里有一次拿不到 session。\n\n**修复：**跳转前先等 cookie（PR #42）。\n\n| 运行 | 修复前 | 修复后 |\n|---|---|---|\n| CI | 45 / 50 | 50 / 50 |\n"));
    files.set("memory/preferences.md", { updated: iso(60 * 30), content: L(
      "# Preferences\n\n- Small PRs, one change each.\n- Ask before merging anything that touches billing.\n- Reports in plain words, no raw logs.\n",
      "# 偏好\n\n- PR 要小，一个 PR 一件事。\n- 涉及计费的改动，合并前先问我。\n- 报告用大白话，不要贴原始日志。\n") });
    files.set("policies/gates.md", { updated: iso(60 * 72), content: L(
      "# Gates\n\nMerging, releasing and publishing always need the owner's decision.\n",
      "# 门禁\n\n合并、发布、上架永远需要我来决定。\n") });
    files.set("reports/2026-weekly.md", { updated: iso(60 * 26), content: L(
      "# This week\n\n- 12 tasks finished, 1 waiting for a decision.\n- Login test fixed; dependency audit running.\n",
      "# 本周\n\n- 完成 12 个任务，1 个等你决定。\n- 登录测试已修好；依赖检查进行中。\n") });

    settingsView = {
      current: {},
      effective: {
        agents: [
          { id: "lead", title: L("Lead", "负责人"), about: L("Plans the work and writes", "规划工作、负责写作"), clis: ["claude"], autonomy: "assisted" as never },
          { id: "dev", title: L("Developer", "开发"), about: L("Code, tests and pull requests", "代码、测试和 PR"), clis: ["codex", "claude"], autonomy: "assisted" as never },
        ],
        autonomy: "assisted" as never,
        routines: [
          { name: "deps", desc: L("Dependency audit", "依赖检查"), every: "weekly MON 09:00", agent: "dev", enabled: true },
          { name: "triage", desc: L("Triage new issues", "整理新 issue"), every: "2h", agent: "lead", enabled: true },
        ],
        max_parallel: 3,
        media_days: 30,
      },
      options: { clis: [["claude"], ["codex", "claude"], ["claude", "codex"], ["codex"]], autonomy: ["onboarding", "assisted", "autonomous"] },
    };

    // yesterday and today in the main chat
    const at = (ago: number) => ({ ts: iso(ago) });
    emit({ ...at(60 * 26), from: "owner", kind: "owner", text: L("Summarise this week's issues for me", "帮我汇总一下本周的 issue") });
    emit({ ...at(60 * 26 - 1), from: "hub", kind: "notice", ref: "T-0114", text: L("On it: T-0114 Summarise this week's issues.", "收到，已建任务 T-0114：汇总本周 issue。") });
    emit({ ...at(60 * 25), from: "lead@studio", kind: "notice", ref: "T-0114", text: L("Done: 23 new issues, 4 are bugs (2 urgent), the rest are feature ideas. Full list in reports/2026-weekly.md.", "完成：本周新增 23 个 issue，4 个是 bug（2 个紧急），其余是功能建议。详见 reports/2026-weekly.md。") });
    emit({ ...at(190), from: "owner", kind: "owner", channel: "website", text: L("The homepage feels slow on phones", "首页在手机上有点慢") });
    emit({ ...at(180), from: "lead@studio", kind: "notice", ref: "T-0115", text: L("Compressed 38 images (14.2 MB → 3.1 MB). The homepage now loads in 1.1 s on 4G.", "压缩了 38 张图片（14.2 MB → 3.1 MB），首页在 4G 下 1.1 秒打开。") });
    emit({ ...at(75), from: "owner", kind: "owner", text: L("The login test keeps failing on CI, please look into it", "CI 上登录测试老是挂，帮我看看") });
    emit({ ...at(74), from: "hub", kind: "notice", ref: "T-0116", text: L("On it: T-0116 Fix the flaky login test.", "收到，已建任务 T-0116：修复不稳定的登录测试。") });
    emit({ ...at(40), from: "dev@linux-box", kind: "notice", ref: "T-0116", text: L("Fixed: the test raced the session cookie. PR #42 waits for it; 50 CI runs passed. [Report](/media/demo-report.md)", "修好了：测试和 session cookie 有竞争。PR #42 改为等待 cookie，CI 连跑 50 次全过。[报告](/media/demo-report.md)") });
    const d = cards[0];
    emit({ ...at(39), from: "hub", kind: "decision", ref: d.id, text: L(`${d.question}\n\nThe fix is small and CI is green. Recommended: A`, `${d.question}\n\n改动很小，CI 全绿。建议：A`), options: d.options });
    emit({ ...at(20), from: "hub", kind: "proposals", ref: "P-0007", text: L("Routines I could take over. Pick the ones to approve:\n1. Check broken links on the website every day\n2. Post a Friday summary of finished work", "这些例行工作我可以接手，选你要批准的：\n1. 每天检查网站死链\n2. 每周五总结完成的工作"), options: cards[1].options });
    emit({ ...at(5), from: "hub", kind: "notice", ref: "T-0117", channel: "website", text: L("Started T-0117: drafting the launch blog post.", "开始 T-0117：起草发布博客。") });
  }
  let seeded = false;
  const ensure = () => { if (!seeded) { seeded = true; seed(); } };

  // ---------------------------------------------------------------- views
  const count = (s: string) => tasks.filter((t) => t.state === s).length;
  function status(): Status & { hub: { online: boolean; seen: string } } {
    const active = tasks.filter((t) => t.state === "active");
    const host = (name: string, os: string, arch: string, clis: string[], primary: boolean) => ({
      host: name, caps: [`os:${os}`, `arch:${arch}`, ...clis.map((c) => `cli:${c}`), ...(primary ? ["primary"] : [])], seen: iso(0),
      busy: active.filter((t) => t.host === name).length, os, arch, clis, lan: primary ? "192.168.1.10" : "192.168.1.23",
      stats: { loadRatio: primary ? 0.31 : 0.58, cores: primary ? 12 : 16, memFreePct: 46, diskFreeGB: primary ? 412 : 180, diskFreePct: 58 },
      accounts: clis.map((cli) => ({ cli, name: "default", state: "ok" as const })),
      running: active.filter((t) => t.host === name).map((t) => ({ id: t.id, title: t.title, agent: t.agent, started: t.started, activity: t.activity })),
      recent: tasks.filter((t) => t.host === name && t.state === "done").slice(0, 3).map((t) => ({ id: t.id, title: t.title, state: "done", finished: t.finished })),
      rev: "e2ddc14b7f0c3d9a8e6f5b4c3d2e1f0a9b8c7d6e", rev_url: "https://github.com/huacnlee/noop",
    });
    return {
      tasks: { proposed: 0, inbox: count("inbox"), active: count("active"), blocked: 0, failed: 0, done: count("done") + 40 },
      active,
      recent: tasks.filter((t) => t.state === "done").sort((a, b) => String(b.updated).localeCompare(String(a.updated))),
      decisions: cards.filter((c) => c.open).map(({ id, kind, question, held, task }) => ({ id, kind, question, held, ...(task ? { task } : {}) })),
      hosts: [host("studio", "macos", "arm64", ["claude", "codex"], true), host("linux-box", "linux", "x64", ["claude", "codex"], false)],
      hub: { online: true, seen: iso(0) },
    };
  }

  function channelsView(): { channels: Channel[] } {
    return {
      channels: channels.map((c) => {
        const items = [
          ...tasks.filter((t) => t.channel === c.slug).map((t) => ({ id: t.id, kind: "task" as const, title: t.title, state: t.state ?? "", updated: String(t.updated ?? "") })),
        ].sort((a, b) => b.updated.localeCompare(a.updated));
        const last = events.filter((e) => e.channel === c.slug).map((e) => e.ts).concat(items.map((i) => i.updated)).sort().pop() ?? c.created;
        return { slug: c.slug, name: c.name, goal: c.goal, status: c.archived ? "archived" : "active", created: c.created, last_activity: last, stale: false, count: items.length, refs: items.map((i) => i.id), items };
      }),
    };
  }

  // ---------------------------------------------------------------- the team at work
  function newTask(title: string, request: string, channel?: string): Task {
    const t: Task = { id: `T-${String(++taskSeq).padStart(4, "0")}`, title, agent: "lead", host: "studio", state: "active", request,
      created: iso(), started: iso(), updated: iso(), cli: "claude", activity: { at: iso(), step: "Read · README.md", steps: 1 }, ...(channel ? { channel } : {}) };
    tasks.unshift(t);
    return t;
  }

  function answer(id: string, choice: string, ref: string | undefined) {
    const card = cards.find((c) => c.id === id);
    if (!card || !card.open) return say({ from: "hub", kind: "system", text: L(`${id} was already answered.`, `${id} 已经处理过了。`) });
    card.open = false;
    pushStatus();
    if (card.kind === "proposals") {
      const n = choice.toLowerCase() === "all" ? 2 : choice.toLowerCase() === "none" ? 0 : choice.split(/[\s,，]+/).filter((x) => /^\d+$/.test(x)).length;
      return later(900, () => say({ from: "hub", kind: "notice", ref, text: n ? L(`Approved ${n} routine${n > 1 ? "s" : ""}. They start on their next schedule.`, `已批准 ${n} 个例行任务，到点就会开始。`) : L("Noted, none of them.", "好的，都不要。") }));
    }
    later(900, () => say({ from: "hub", kind: "notice", ref: card.task ?? ref, text: L(`Got ${id}: ${choice}.`, `收到 ${id}：${choice}。`) }));
    if (/^A/i.test(choice)) later(2500, () => say({ from: "dev@linux-box", kind: "notice", ref: card.task, text: L("Merged PR #42 (squash). CI on main is green.", "已合并 PR #42（squash），main 上 CI 全绿。") }));
  }

  /** What the demo team reports back: a plausible result for the usual kinds of request. */
  function resultOf(text: string, title: string): string {
    if (/link/i.test(text) || /链接|死链/.test(text)) return L("Done: checked 214 links on 36 pages. 3 were broken (two moved docs pages, one dead external link); fixed in PR #45.", "完成：检查了 36 个页面的 214 个链接，3 个失效（两个文档页挪了位置，一个外链已失效），已在 PR #45 修好。");
    if (/test|ci\b/i.test(text) || /测试/.test(text)) return L("Done: the suite passes again. One test depended on the clock; it now uses a fixed time. PR #46 is ready.", "完成：测试重新全部通过。有一个测试依赖当前时间，已改成固定时间。PR #46 已就绪。");
    if (/summar|report|review/i.test(text) || /总结|汇总|报告/.test(text)) return L("Done: the summary is ready. 12 tasks finished this week, 1 decision waits for you. Full report in reports/weekly.md.", "完成：总结写好了。本周完成 12 个任务，还有 1 个决定等你。完整报告在 reports/weekly.md。");
    return L(`Done: ${title}. The details are in the task.`, `完成：${title}。细节写在任务里。`);
  }

  function work(owner: HubEvent) {
    const text = owner.text.trim();
    const m = text.match(/^\s*([DLP]-[A-Z]?\d{4})\s+(.+)$/s);
    if (m) return answer(m[1], m[2].trim(), owner.ref);
    if (owner.ref && /^[DLP]-/.test(owner.ref)) return answer(owner.ref, text, owner.ref);
    if (owner.thread && owner.ref) {
      return later(1200, () => say({ from: "lead@studio", kind: "notice", ref: owner.ref, thread: true, text: L("Noted, I'll take that into account for this task.", "好的，这个任务里我会照这个来。") }));
    }
    if (/^(hi|hello|hey|你好|嗨|在吗)/i.test(text)) {
      return later(900, () => say({ from: "hub", kind: "notice", ...(owner.channel ? { channel: owner.channel } : {}), text: L("Hi! This is the Noop demo. Ask the team for anything, for example \"check the website for broken links\", and watch it work.", "你好！这是 Noop 演示。随便交代一件事，比如「检查一下网站有没有死链」，看看团队怎么干活。") }));
    }
    const title = text.split("\n")[0].replace(/[。.!！?？]+$/, "").slice(0, 60);
    later(1000, () => {
      const t = newTask(title, text, owner.channel);
      say({ from: "hub", kind: "notice", ref: t.id, ...(owner.channel ? { channel: owner.channel } : {}), text: L(`On it: ${t.id} ${title}.`, `收到，已建任务 ${t.id}：${title}。`) });
      pushStatus();
      later(3500, () => { t.activity = { at: iso(), step: "Bash · rg TODO", steps: 7 }; pushStatus(); });
      later(8000, () => {
        t.state = "done";
        t.finished = t.updated = iso();
        delete t.activity;
        const summary = resultOf(text, title);
        t.runs = [{ ts: iso(), host: "studio", cli: "claude", status: "done", summary }];
        say({ from: "lead@studio", kind: "notice", ref: t.id, ...(owner.channel ? { channel: owner.channel } : {}), text: summary });
        pushStatus();
      });
    });
  }

  // ---------------------------------------------------------------- the API
  const ok = (data: unknown = { ok: true }): Reply => ({ status: 200, data });
  const notFound: Reply = { status: 404, data: { error: "not found" } };

  async function handle(method: string, url: string, body?: unknown): Promise<Reply> {
    ensure();
    const [p, query = ""] = url.split("#")[0].split("?");
    const params = new Map(query.split("&").filter(Boolean).map((kv) => {
      const [k, v = ""] = kv.split("=");
      return [decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, " "))] as const;
    }));
    const q = (k: string) => params.get(k) ?? "";
    const b = (body ?? {}) as Record<string, unknown>;
    if (p.startsWith("/media/")) {
      const doc = docs.get(p);
      return doc ? { status: 200, data: null, text: doc } : notFound;
    }
    switch (`${method} ${p}`) {
      case "POST /api/auth/start": return ok({ ok: true, delivery: "demo" });
      case "POST /api/auth/verify": return ok({ session: DEMO_TOKEN });
      case "POST /api/auth/logout": return ok();
      case "GET /api/feed": {
        const since = q("since");
        return ok({ events: events.filter((e) => !since || e.ts > since).slice(-300) });
      }
      case "GET /api/status": return ok(status());
      case "POST /api/messages": {
        const text = String(b.text ?? "");
        const prior = b.client_id ? events.find((e) => e.client_id === b.client_id) : undefined;
        if (prior) return ok(prior);
        const ev = say({ from: "owner", kind: "owner", text, ...(b.reply_to ? { ref: String(b.reply_to) } : {}), ...(b.client_id ? { client_id: String(b.client_id) } : {}),
          ...(Array.isArray(b.attachments) && b.attachments.length ? { attachments: b.attachments as string[] } : {}), ...(b.thread ? { thread: true } : {}), ...(b.channel ? { channel: String(b.channel) } : {}) });
        work(ev);
        return ok(ev);
      }
      case "POST /api/uploads": return ok({ url: `/media/upload-${++seq}.png` });
      case "GET /api/settings": return ok(settingsView);
      case "GET /api/secrets": return ok({ secrets: demoSecrets });
      case "PUT /api/secrets": {
        const name = String(b.name ?? "");
        demoSecrets = demoSecrets.filter((k) => k.name !== name);
        if (b.value) demoSecrets = [...demoSecrets, { name, updated: new Date().toISOString() }].sort((x, y) => x.name.localeCompare(y.name));
        return ok({ secrets: demoSecrets });
      }
      // demo: the list applies at once (no primary to wait for); this device is 203.0.113.7
      case "GET /api/allow-ips": return ok(demoAllow());
      case "PUT /api/allow-ips": {
        const list = [...new Set((Array.isArray(b.entries) ? b.entries : []).map((e) => String(e).trim()).filter(Boolean))];
        if (list.length && !list.some((e) => e === DEMO_IP || e === "203.0.113.0/24")) return { status: 400, data: { error: `这台设备的 IP ${DEMO_IP} 将不在名单里，保存后你会被挡在外面。`, code: "self", ips: [DEMO_IP] } };
        demoAllowList = list;
        return ok(demoAllow());
      }
      case "PUT /api/settings": {
        const deep = (a: Record<string, unknown>, c: Record<string, unknown>): Record<string, unknown> => {
          const o = { ...a };
          for (const [k, v] of Object.entries(c ?? {})) o[k] = v && typeof v === "object" && !Array.isArray(v) ? deep((o[k] ?? {}) as Record<string, unknown>, v as Record<string, unknown>) : v;
          return o;
        };
        settingsView = { ...settingsView, current: deep(settingsView.current, b) };
        return ok(settingsView);
      }
      case "GET /api/tasks": {
        const needle = q("q").toLowerCase(), offset = Number(q("offset")) || 0, limit = Number(q("limit")) || 30;
        const all = tasks.filter((t) => !needle || `${t.id} ${t.title} ${t.agent}`.toLowerCase().includes(needle))
          .sort((a, c) => String(c.updated ?? "").localeCompare(String(a.updated ?? "")));
        return ok({ tasks: all.slice(offset, offset + limit), total: all.length });
      }
      case "GET /api/tasks/get": {
        const t = tasks.find((x) => x.id === q("id"));
        if (!t) return notFound;
        const decisions = cards.filter((c) => c.task === t.id).map((c) => c.id);
        return ok({ ...t, decisions, events: events.filter((e) => e.ref === t.id || decisions.includes(e.ref ?? "")) });
      }
      case "POST /api/tasks/cancel": {
        const t = tasks.find((x) => x.id === b.id);
        if (!t) return { status: 400, data: { error: "id required" } };
        t.state = b.done ? "done" : "rejected";
        t.updated = t.finished = iso();
        delete t.activity;
        later(600, () => { say({ from: "hub", kind: "notice", ref: t.id, text: b.done ? L(`Marked ${t.id} as done.`, `已把 ${t.id} 标为完成。`) : L(`Cancelled ${t.id}.`, `已取消 ${t.id}。`) }); pushStatus(); });
        return ok();
      }
      case "GET /api/channels": return ok(channelsView());
      case "GET /api/channels/feed": {
        const c = channelsView().channels.find((x) => x.slug === q("slug"));
        if (!c) return notFound;
        return ok({ events: events.filter((e) => !e.thread && (e.channel === c.slug || (!!e.ref && (c.refs ?? []).includes(e.ref) && !/^hub/.test(e.from)))) });
      }
      case "POST /api/channels": {
        const c = channels.find((x) => x.slug === b.slug);
        if (!c) return { status: 400, data: { error: "slug required" } };
        if (typeof b.goal === "string") c.goal = b.goal;
        if (typeof b.archived === "boolean") c.archived = b.archived;
        return ok();
      }
      case "POST /api/fleet/update":
        later(800, () => say({ from: "hub", kind: "system", text: L("Every machine is already on the latest version.", "所有机器都已经是最新版本。") }));
        return ok();
      case "GET /api/files/list": {
        const prefix = q("prefix");
        return ok({ files: [...files].filter(([path]) => path.startsWith(prefix)).map(([path, f]) => ({ path, size: f.content.length, updated: f.updated, version: 1 })) });
      }
      case "GET /api/files/read": {
        const f = files.get(q("path"));
        return f ? ok({ path: q("path"), content: f.content, size: f.content.length, updated: f.updated, version: 1 }) : notFound;
      }
      case "GET /api/push/vapid": return { status: 503, data: { error: L("Notifications are off in the demo", "演示里没有推送通知") } };
      case "POST /api/push/subscribe": case "POST /api/push/unsubscribe": case "POST /api/push/test": return ok();
    }
    return notFound;
  }

  /** A connection like /api/stream?v=2: events and {"$status"} frames, "pong" to "ping". */
  function connect(onFrame: Listener): { send: (data: string) => void; close: () => void } {
    ensure();
    listeners.add(onFrame);
    return { send: (data) => { if (data === "ping") onFrame("pong"); }, close: () => listeners.delete(onFrame) };
  }

  return { handle, connect, status: () => { ensure(); return status(); } };
}

// ---------------------------------------------------------------- the app's transport

let shared: ReturnType<typeof createDemoHub> | null = null;
const demoHub = () => (shared ??= createDemoHub());

type Init = { method?: string; body?: unknown; headers?: unknown };
/** What the app reads of a fetch response. */
type Res = { ok: boolean; status: number; json(): Promise<any>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> };

/** `fetch`, except that demo addresses are answered by the in-app demo hub. */
export async function hubFetch(url: string, init?: Init): Promise<Res> {
  if (!isDemo(url)) return fetch(url, init as RequestInit) as unknown as Promise<Res>;
  let body: unknown;
  if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = undefined; } }
  const r = await demoHub().handle((init?.method ?? "GET").toUpperCase(), url.replace(/^https?:\/\/demo/i, ""), body);
  const text = r.text ?? JSON.stringify(r.data);
  return {
    ok: r.status >= 200 && r.status < 300, status: r.status,
    json: async () => (r.text !== undefined ? JSON.parse(r.text) : r.data),
    text: async () => text,
    arrayBuffer: async () => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff).buffer as ArrayBuffer,
  };
}

/** The slice of WebSocket the hub client uses. */
export type Socket = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((m: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
};

/** `new WebSocket(url)`, except that demo addresses connect to the in-app demo hub. */
export function openSocket(url: string): Socket {
  if (!/^wss?:\/\/demo(\/|$)/i.test(url)) return new WebSocket(url) as unknown as Socket;
  const s: Socket = {
    readyState: 0, onopen: null, onmessage: null, onclose: null,
    send: (data) => conn?.send(data),
    close: () => { if (s.readyState === 3) return; s.readyState = 3; conn?.close(); setTimeout(() => s.onclose?.(), 0); },
  };
  let conn: ReturnType<ReturnType<typeof createDemoHub>["connect"]> | null = null;
  setTimeout(() => {
    if (s.readyState === 3) return;
    conn = demoHub().connect((data) => setTimeout(() => s.readyState === 1 && s.onmessage?.({ data }), 0));
    s.readyState = 1;
    s.onopen?.();
  }, 0);
  return s;
}
