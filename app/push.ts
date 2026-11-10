// This device's notifications: the system's in an installed app, Web Push through host.js in a page.
import { host, Notifications, platform, signal, Storage, untracked } from "nsh";
import { L } from "./i18n";
import { hostCall, type Hub, KEYS } from "./connection";

// ---------------------------------------------------------------- notifications (Web Push through host.js; the system's in an installed app)

/** In an installed app (no page host) NSH shows the system's notifications; they appear while the app runs. */
export const systemNotifications = () => !host.available();
/** The notifications this run showed, by id, to take them back. Ones without an event to open start with `noop:`. */
export const showing = new Set<string>();
export const closeNotification = (id: string) => {
  if (!showing.delete(id)) return;
  Notifications.close(id).catch(() => {});
};
export function clearNotification(ref: string) {
  if (systemNotifications()) closeNotification(ref);
  else hostCall("clearNotifications", { ref });
}
export function setBadge(count: number) {
  if (systemNotifications()) Notifications.setBadge(count).catch(() => {}); // iOS refuses it before the permission
  else hostCall("setBadge", { count });
}
export const DEVICES: Record<string, string> = { macos: "Mac", ios: "iPhone", android: "Android", windows: "Windows", linux: "Linux" };

export type PushInfo = { supported: boolean; ios: boolean; standalone: boolean; permission: string; subscribed: boolean; endpoint: string | null; device: string };

export async function systemInfo(): Promise<PushInfo | null> {
  try {
    const permission = await Notifications.permission();
    if (permission === "unavailable") return null;
    const off = !!(await Storage.getItem(KEYS.notifyOff));
    return { supported: true, ios: false, standalone: true, permission, subscribed: permission === "granted" && !off, endpoint: null, device: DEVICES[platform.os] ?? L("This device", "本设备") };
  } catch {
    return null;
  }
}

/** This device's push state and the steps that change it (the permission prompt needs the press that calls `enable`). */
export function createPush(hub: Hub, success: (message: string) => void) {
  const info = signal<PushInfo | null>(null);
  const busy = signal(false);
  const note = signal<string | null>(null);
  const refresh = async () => info.set(systemNotifications() ? await systemInfo() : await hostCall<PushInfo>("pushState"));
  refresh();

  async function run(work: () => Promise<string>) {
    busy.set(true);
    note.set(null);
    try {
      success(await work());
    } catch (e) {
      note.set(e instanceof Error ? e.message : String(e));
    } finally {
      busy.set(false);
      await refresh();
    }
  }
  const enable = () =>
    run(async () => {
      if (systemNotifications()) {
        const permission = await Notifications.requestPermission();
        if (permission === "denied") throw new Error(L("Notifications are blocked. Allow Noop in System Settings, then come back and turn them on.", "通知被拦截了：请在系统设置里允许 Noop 发通知，再回来开启"));
        if (permission !== "granted") throw new Error(L("Notifications aren’t on", "没有开启通知"));
        await Storage.removeItem(KEYS.notifyOff);
        return L("On. Decisions that need you appear as system notifications.", "已开启：需要你决定的事会发到系统通知");
      }
      // Ask the browser first, while the press still counts as the user's gesture.
      const v = hub.api("GET", "/api/push/vapid");
      const key = (await v).data.publicKey;
      if (typeof key !== "string" || !key) throw new Error(L("The server hasn’t set up push yet, so it can’t be turned on", "服务器还没有配置推送，暂时无法开启"));
      const r = await hostCall<{ permission: string; subscription: unknown; device?: string }>("pushEnable", { publicKey: key });
      if (!r) throw new Error(L("Web push isn’t supported here", "这个环境不支持网页推送"));
      if (r.permission === "denied") throw new Error(L("Notifications are blocked. Allow Noop in your browser or system settings, then come back and turn them on.", "通知被拦截了：请在浏览器或系统设置里允许 Noop 发通知，再回来开启"));
      if (r.permission !== "granted" || !r.subscription) throw new Error(L("Notifications aren’t on", "没有开启通知"));
      const s = await hub.api("POST", "/api/push/subscribe", { subscription: r.subscription, device_label: r.device ?? untracked(info)?.device ?? L("Device", "设备") });
      if (!s.ok) throw new Error(L(`Subscription failed (${s.status || "can’t reach the server"})`, `订阅失败（${s.status || "连不上服务器"}）`));
      return L("On. Decisions that need you are pushed to this device.", "已开启：需要你决定的事会推送到这台设备");
    });
  const disable = () =>
    run(async () => {
      if (systemNotifications()) {
        await Storage.setItem(KEYS.notifyOff, "1");
        for (const id of [...showing]) closeNotification(id);
        return L("Notifications are off on this device", "已关闭这台设备的通知");
      }
      const r = await hostCall<{ endpoint: string | null }>("pushDisable");
      if (r?.endpoint) await hub.api("POST", "/api/push/unsubscribe", { endpoint: r.endpoint });
      return L("Notifications are off on this device", "已关闭这台设备的通知");
    });
  const test = () =>
    run(async () => {
      if (systemNotifications()) {
        showing.add("noop:test");
        if (!(await Notifications.show({ id: "noop:test", title: "Noop", body: L("Test notification: system notifications are working.", "测试通知：系统通知已开通。"), silent: true }))) throw new Error(L("The system didn’t accept the notification", "系统没有接收这条通知"));
        return L("Test notification sent", "测试通知已发出");
      }
      const r = await hub.api("POST", "/api/push/test");
      if (!r.ok) throw new Error(L(`Couldn’t send the test notification (${r.status || "can’t reach the server"})`, `测试通知发送失败（${r.status || "连不上服务器"}）`));
      return L("Test notification sent. It should arrive in a few seconds.", "测试通知已发出，几秒内会到");
    });
  /** iOS shows web push only to an app added to the home screen. */
  const needsHomeScreen = () => !!info()?.ios && !info()?.standalone;
  const canAsk = () => !!info()?.supported && !needsHomeScreen();
  return { info, busy, note, refresh, enable, disable, test, needsHomeScreen, canAsk };
}
export type Push = ReturnType<typeof createPush>;
