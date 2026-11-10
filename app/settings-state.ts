// The team's settings as the settings pages read and change them, kept by the chat so a page laid out again (or
// loaded later) finds them as they were.
import { signal } from "nsh";
import { L } from "./i18n";
import { type SettingsView } from "./hub";
import type { Hub } from "./connection";
import { createSettingsToast } from "./settings-toast";

/** The team's settings, shared by the settings page and the pages it pushes on phones. */
export function createSettings(hub: Hub) {
  const view = signal<SettingsView | null>(null);
  const error = signal("");
  const toast = createSettingsToast();
  const saving = signal(0);
  let writes = Promise.resolve();
  let revision = 0;
  let confirmed: SettingsView | null = null;
  const pending: { patch: Record<string, unknown> }[] = [];
  function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      const previous = result[key];
      result[key] = value && typeof value === "object" && !Array.isArray(value)
        ? merge(previous && typeof previous === "object" && !Array.isArray(previous) ? previous as Record<string, unknown> : {}, value as Record<string, unknown>)
        : value;
    }
    return result;
  }
  function displayed(v: SettingsView): SettingsView {
    const current = v.current as { clis?: { agents?: Record<string, string[]> }; autonomy?: { agents?: Record<string, string> }; routines?: Record<string, { enabled?: boolean; every?: string }>; host?: { max_parallel?: number } };
    return { ...v, effective: { ...v.effective,
      agents: v.effective.agents.map((a) => ({ ...a, clis: current.clis?.agents?.[a.id] ?? a.clis, autonomy: current.autonomy?.agents?.[a.id] ?? a.autonomy })),
      routines: v.effective.routines.map((r) => ({ ...r, ...current.routines?.[r.name] })),
      max_parallel: current.host?.max_parallel ?? v.effective.max_parallel,
    } };
  }
  function refresh() {
    if (!confirmed) return;
    const current = pending.reduce((state, item) => merge(state, item.patch), confirmed.current);
    view.set(displayed({ ...confirmed, current }));
  }
  const load = () => {
    error.set("");
    const started = revision;
    hub.settings().then((v) => { if (started === revision && !saving()) { confirmed = v; refresh(); } }, (e) => { if (started === revision && !saving()) error.set(String(e?.message ?? e)); });
  };
  async function save(patch: Record<string, unknown>) {
    revision++;
    error.set("");
    toast.dismiss();
    saving.update((n) => n + 1);
    const item = { patch };
    pending.push(item);
    refresh();
    try {
      const request = writes.then(() => hub.settings(patch));
      writes = request.then(() => {}, () => {});
      confirmed = await request;
    } catch (e) {
      error.set(e instanceof Error ? e.message : String(e));
    } finally {
      pending.splice(pending.indexOf(item), 1);
      refresh();
      saving.update((n) => n - 1);
      if (!saving() && !error()) {
        toast.show(L("Saved", "已保存"));
      }
    }
  }
  // the command being added in 常用指令 (kept here: the settings page may be laid out again while typing)
  /** The command editor: `editing` is undefined when closed, "" for a new command, else the name being edited. */
  const commandDraft = { name: signal(""), text: signal(""), editing: signal<string | undefined>(undefined), note: signal("") };
  /** The section the wide settings page shows (its sidebar picks it). */
  const tab = signal<SettingsTab>("notify");
  return { view, error, toast, saving, load, save, commandDraft, tab };
}
export type Settings = ReturnType<typeof createSettings>;

/** The sections of the wide settings page, in its sidebar's order. */
export const SETTINGS_TABS = () => [
  ["notify", L("Notifications", "通知"), "bell"],
  ["members", L("Members", "成员"), "chat"],
  ["routines", L("Routines", "例行任务"), "play"],
  ["parallel", L("Parallelism", "并行"), "layers"],
  ["commands", L("Commands", "常用指令"), "terminal"],
  ["storage", L("Storage", "存储"), "photos"],
  ["version", L("Version", "版本"), "github"],
  ["rules", L("Rules & memory", "规则与记忆"), "scroll"],
  ["account", L("Account", "账号与连接"), "lock"],
] as const;
export type SettingsTab = ReturnType<typeof SETTINGS_TABS>[number][0];
