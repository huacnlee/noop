// The settings pages, wide and on phones, and the team's rules and memory: a lazy chunk, loaded the first time one
// shows (lazy.tsx). NumberInput comes with it, and on the web its part of the runtime.
import { cleanup, openUrl, platform, safeArea, Scroll, signal, Text, View, type ViewStyle } from "nsh";
import type { JSX } from "nsh";
import { AlertDialog, Dialog, Input, Menu, MenuItem, NumberInput, Radio, RadioGroup } from "nsh/base";
import { runningPackage } from "nsh/updater";
// shellInfo through the namespace: runtimes older than it lack the export, and a missing named import would fail to link
import * as nshUpdater from "nsh/updater";
import { L, lang, LANGS } from "./i18n";
import { alpha, colors, focusRing, hovered, Icon, isDark, radius, Spinner, tints, Toggle } from "./ui";
import {
  autonomyLabel, BUILTIN_COMMANDS, cliKey, cliLabel, type Command, type DataFile, everyLabel, groupRules, intervalsWith,
  MEDIA_DAYS, mediaDaysOf, NOTIFY_KINDS, notifyPatch, type NotifyPrefs, notifyPrefsOf, patches, QUIET_PRESETS, quietKey,
  RULE_PREFIXES, type RuleGroup, savedCommands, type SettingsView, stripFrontMatter, updateLine, type UpdateLine, updateSummary,
} from "./hub";
import { shellLine, type ShellInfo } from "./update";
import { CLIENT_VERSION } from "./version";
import { Avatar, Btn, displayName, Dot, Field, MONO, pickLang, size, surfaceEdge, ToolButton, touch } from "./kit";
import { Rich } from "./markdown";
import type { Hub } from "./connection";
import { type Push, systemNotifications } from "./push";
import { type Settings, SETTINGS_TABS, type SettingsTab } from "./settings-state";
import { updateAllMachines } from "./confirms";

/** The pages settings pushes on phones (App.tsx's routes). */
export type SettingsRoute = { name: "notify" } | { name: "member"; id: string } | { name: "routine"; routine: string } | { name: "rules" };

/** English or Chinese; the app speaks English until the owner picks. */
function LangChoices() {
  return (
    <Choices
      label={L("Language", "语言")}
      choices={LANGS.map((l) => ({ id: l.id, label: l.label, testID: `lang-${l.id}` }))}
      selected={lang()}
      onPick={pickLang}
    />
  );
}

// ---------------------------------------------------------------- team settings

function Chip(props: { label: string; on: boolean; onPress: () => void; testID?: string; accessibilityLabel?: string }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      hoverStyle={props.on ? undefined : hovered()}
      focusStyle={focusRing()}
      style={{
        minHeight: touch ? 40 : 34,
        minWidth: 34,
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: 12,
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: 0.5,
        borderColor: props.on ? alpha(colors.text, 0.2) : surfaceEdge(),
        backgroundColor: props.on ? tints.accent : colors.surface,
        transitionProperty: "background-color, border-color",
        transitionDuration: 120,
      }}
    >
      <Text style={{ textAlign: "center", fontSize: 14, fontWeight: props.on ? "600" : "400", color: props.on ? colors.accent : colors.text }}>{props.label}</Text>
    </View>
  );
}

/** A shared stepper for the per-machine parallel limit. */
function ParallelInput(props: { value: number; onChange: (value: number) => void }) {
  return <NumberInput
    testID="parallel" accessibilityLabel={L("Tasks each machine runs at once", "每台机器同时运行的任务数")} value={props.value} min={1} max={32}
    onChange={({ value }) => { if (value != null && value >= 1 && value <= 32 && value !== props.value) props.onChange(value); }}
    style={{ flexDirection: "row", alignItems: "center", height: touch ? 44 : 36, borderRadius: radius.control, borderCurve: "continuous", backgroundColor: colors.raised }}
    inputStyle={{ width: 40, textAlign: "center", fontSize: 16, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}
    decrementButtonClass="active:opacity-50 disabled:opacity-30" incrementButtonClass="active:opacity-50 disabled:opacity-30"
    decrementButtonStyle={{ width: touch ? 44 : 36, height: touch ? 44 : 36, alignItems: "center", justifyContent: "center" }}
    incrementButtonStyle={{ width: touch ? 44 : 36, height: touch ? 44 : 36, alignItems: "center", justifyContent: "center" }}
    decrementButton={<View testID="parallel-dec"><Icon name="minus" size={16} tint={colors.text} /></View>}
    incrementButton={<View testID="parallel-inc"><Icon name="plus" size={16} tint={colors.text} /></View>}
  />;
}

/** A settings section: the gallery's Card (a title above one flat surface). */
const AUTONOMY_DETAIL = (): Record<string, string> => ({
  onboarding: L("Asks you about most things and learns from your answers", "大多数事先问你，从你的回答里学习"),
  assisted: L("Handles routine work, asks you about important things", "常规的事自己做，重要的先问你"),
  autonomous: L("Decides on its own, asks only about high-risk things", "自己拿主意，只有高风险的事才问你"),
});
const cliDetail = (c: string[]) => {
  const name = (x: string) => cliLabel([x]).replace(/^(仅|only)\s*/i, "");
  return c.length === 1
    ? L(`Only ${name(c[0]!)}`, `只用 ${name(c[0]!)}`)
    : L(`${name(c[0]!)} first, then ${name(c[1]!)} on failure or when out of quota`, `先用 ${name(c[0]!)}，失败或额度用尽时换 ${name(c[1]!)}`);
};

type DropdownOption = { id: string; label: string; detail?: string; testID?: string };

/** A labelled value that opens a menu of its choices (each with a line saying what it means). */
function Dropdown(props: { label: string; value: string; options: DropdownOption[]; selected: string; onPick: (id: string) => void; testID?: string }) {
  return (
    <Menu
      align="end"
      offset={6}
      margin={8}
      popupStyle={{ minWidth: 260, maxWidth: 340, padding: 4, borderRadius: radius.control, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), backgroundColor: colors.surface }}
      trigger={
        <View
          role="button"
          testID={props.testID}
          accessibilityLabel={`${props.label}${L(": ", "：")}${props.value}`}
          hoverStyle={hovered()}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingLeft: 11, paddingRight: 9, borderRadius: radius.control, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), backgroundColor: colors.surface }}
        >
          <Text style={{ fontSize: 13, color: colors.faint }}>{props.label}</Text>
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{props.value}</Text>
          <Icon name="chevron-down" size={12} tint={colors.muted} />
        </View>
      }
    >
      <Each of={props.options}>
        {(o) => (
          <MenuItem
            testID={o().testID}
            role="menuitemradio"
            checked={o().id === props.selected}
            onSelect={() => o().id !== props.selected && props.onPick(o().id)}
            hoverStyle={hovered()}
            style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 6 }}
          >
            <View style={{ width: 14, paddingTop: 3 }}>
              <If when={o().id === props.selected}>
                <Icon name="check" size={13} tint={colors.text} />
              </If>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 14, fontWeight: "500", color: colors.text }}>{o().label}</Text>
              <If when={o().detail}>
                <Text style={{ fontSize: 12.5, lineHeight: 17, color: colors.muted }}>{o().detail}</Text>
              </If>
            </View>
          </MenuItem>
        )}
      </Each>
    </Menu>
  );
}

function Group(props: { title: string; hint?: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 3, paddingHorizontal: 2 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{props.title}</Text>
        {props.hint ? <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted }}>{props.hint}</Text> : null}
      </View>
      <View style={{ borderRadius: radius.card, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), overflow: "hidden" }}>{props.children}</View>
    </View>
  );
}

function Steps(props: { steps: string[] }) {
  return (
    <View style={{ gap: 8 }}>
      <Each of={props.steps}>
        {(s, i) => (
          <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: tints.accent }}>
              <Text style={{ fontSize: 12.5, fontWeight: "700", color: colors.accent }}>{String(i() + 1)}</Text>
            </View>
            <Text style={{ flex: 1, fontSize: 15, lineHeight: 22, color: colors.text }}>{s()}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

function NotifySettings(props: { push: Push; view: SettingsView | null; save: (patch: Record<string, unknown>) => void; wide: boolean }) {
  const push = props.push;
  const { prefs, setPrefs, state } = notifyModel(push, () => props.view, props.save);
  const row = (): ViewStyle => ({ gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 0.5, borderTopColor: surfaceEdge() });
  return (
    <Group title={L("Notifications", "通知")} hint={systemNotifications() ? L("While Noop is running, decisions that need you appear as system notifications. Click one to jump to it.", "Noop 运行时，需要你拍板的事会发系统通知，点开直接到这一条。") : L("Decisions that need you are pushed to your phone. You can pick an option right from the notification.", "需要你拍板的事推送到手机；通知上可以直接选择选项。")}>
      <View style={{ gap: 12, paddingHorizontal: 16, paddingVertical: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Dot tone={push.info()?.subscribed ? "on" : push.info()?.permission === "denied" ? "bad" : "off"} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 15.5, fontWeight: "600", color: colors.text }}>{push.info()?.device ?? L("This device", "本设备")}</Text>
            <Text testID="push-state" style={{ fontSize: 13.5, color: colors.muted }}>{state()}</Text>
          </View>
        </View>
        <If when={push.needsHomeScreen()}>
          <View style={{ gap: 10, padding: 14, borderRadius: radius.inset, backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.line }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{L("Turn on notifications on iPhone", "在 iPhone 上开启通知")}</Text>
            <Steps steps={[L("In Safari, tap the Share button at the bottom", "在 Safari 里点底部的「分享」按钮"), L("Choose “Add to Home Screen”, then tap “Add”", "选「添加到主屏幕」，再点「添加」"), L("Open Noop from the Home Screen, sign in, and tap “Turn on notifications” here", "从主屏幕打开 Noop，登录后回到这里点「开启通知」")]} />
          </View>
        </If>
        <If when={push.info()?.permission === "denied" && !push.needsHomeScreen()}>
          <Text style={{ fontSize: 14, lineHeight: 21, color: colors.muted }}>{systemNotifications() ? L("Allow Noop in System Settings → Notifications, then come back and turn them on.", "在系统设置 → 通知里允许 Noop，再回来开启。") : L("Allow Noop in the browser’s site settings (or System Settings → Notifications), then reload and turn them on.", "在浏览器的网站设置（或系统设置 → 通知）里允许 Noop，然后刷新页面再开启。")}</Text>
        </If>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <If
            when={push.info()?.subscribed}
            else={<Btn testID="push-enable" label={L("Turn on notifications", "开启通知")} icon="bell" kind="primary" busy={push.busy()} disabled={!push.canAsk()} onPress={push.enable} />}
          >
            <Btn testID="push-test" label={L("Send test notification", "发送测试通知")} icon="bell" busy={push.busy()} onPress={push.test} />
            <Btn testID="push-disable" label={L("Turn off on this device", "关闭本设备通知")} kind="ghost" onPress={push.disable} />
          </If>
        </View>
        <If when={push.note()}>
          <Text testID="push-note" style={{ fontSize: 14, lineHeight: 20, color: colors.danger }}>{push.note()}</Text>
        </If>
      </View>
      <If when={props.view}>
        <View style={row()}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.muted }}>{L("What to push", "推送哪些")}</Text>
          <Each of={NOTIFY_KINDS()}>
            {(k) => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 36 }}>
                <Text style={{ flex: 1, fontSize: 15.5, color: colors.text }}>{k()[1]}</Text>
                <Toggle
                  testID={`notify-${k()[0]}`}
                  label={k()[1]}
                  value={prefs().kinds[k()[0]]}
                  onChange={(on) => setPrefs({ kinds: { ...prefs().kinds, [k()[0]]: on } })}
                />
              </View>
            )}
          </Each>
        </View>
        <View style={row()}>
          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.muted }}>{L("Quiet hours", "免打扰时段")}</Text>
            <Text style={{ fontSize: 13, color: colors.faint }}>{L(`Recorded but not pushed during these hours (time zone ${prefs().tz})`, `这段时间只记下，不推送（时区 ${prefs().tz}）`)}</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Each of={QUIET_PRESETS()}>
              {(q) => (
                <Chip
                  testID={`quiet-${quietKey(q().value)}`}
                  label={q().label}
                  on={quietKey(q().value) === quietKey(prefs().quiet_hours)}
                  onPress={() => setPrefs({ quiet_hours: q().value })}
                />
              )}
            </Each>
          </View>
        </View>
      </If>
    </Group>
  );
}

/** The wide (desktop, tablet, wide browser) settings page. */
export function TeamSettings(props: { hub: Hub; push: Push; settings: Settings; wide: boolean; onRules: () => void; onConnection: () => void; onDisconnect: () => void }) {
  const { view, error, save } = props.settings;
  props.settings.load();
  const eff = () => view()?.effective;
  const row = (): ViewStyle => ({ gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 0.5, borderTopColor: surfaceEdge() });
  const chips: ViewStyle = { flexDirection: "row", flexWrap: "wrap", gap: 6 };

  const tab = props.settings.tab;
  const on = (k: SettingsTab) => tab() === k;
  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View testID="settings-nav" role="tablist" style={{ width: 208, gap: 2, paddingHorizontal: 10, paddingVertical: 20, borderRightWidth: 0.5, borderRightColor: surfaceEdge() }}>
        <Each of={[...SETTINGS_TABS()]}>
          {(x) => (
            <View
              role="tab"
              testID={`settings-tab-${x()[0]}`}
              accessibilityLabel={x()[1]}
              accessibilityState={{ selected: on(x()[0]) }}
              onPress={() => tab.set(x()[0])}
              hoverStyle={on(x()[0]) ? undefined : hovered()}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 36, paddingHorizontal: 10, borderRadius: 8, backgroundColor: on(x()[0]) ? colors.raised : undefined }}
            >
              <Icon name={x()[2]} size={16} tint={on(x()[0]) ? colors.text : colors.muted} />
              <Text style={{ fontSize: 14.5, fontWeight: on(x()[0]) ? "600" : "400", color: on(x()[0]) ? colors.text : colors.muted }}>{x()[1]}</Text>
            </View>
          )}
        </Each>
      </View>
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 28, paddingHorizontal: props.wide ? 32 : 16, paddingTop: props.wide ? 28 : 18, paddingBottom: 48 }}>
        <If when={error()}>
          <Text testID="settings-note" style={{ alignSelf: "flex-end", fontSize: 13.5, color: error() ? colors.danger : colors.up }}>{error()}</Text>
        </If>
        <If when={on("notify")}>
          <NotifySettings push={props.push} view={view()} save={save} wide={props.wide} />
        </If>
        <If when={on("members") || on("routines") || on("parallel")}>
        <If when={eff()} else={<Text style={{ fontSize: 14, color: colors.faint }}>{error() ? "" : L("Loading…", "读取中…")}</Text>}>
          {(e) => (
            <View style={{ gap: 28 }}>
              <If when={on("members")}>
              <Group title={L("Members", "成员")} hint={L("Each role on the team. The model decides who does the work; autonomy decides how big a decision needs your input first.", "团队里的每个角色。模型决定由谁来干活，自主程度决定多大的事要先问你。")}>
                <Each of={e().agents} key={(a) => a.id}>
                  {(a, i) => (
                    <View testID={`member-${a().id}`} style={{ flexDirection: props.wide ? "row" : "column", alignItems: props.wide ? "center" : "stretch", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: i() === 0 ? 0 : 0.5, borderTopColor: surfaceEdge() }}>
                      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 }}>
                        <Avatar from={a().id} />
                        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                            <Text style={{ fontSize: 15.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{displayName(a().id)}</Text>
                            <If when={displayName(a().id) !== a().id}>
                              <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint, numberOfLines: 1 }}>{a().id}</Text>
                            </If>
                          </View>
                          <If when={a().about}>
                            <Text testID={`member-about-${a().id}`} style={{ fontSize: 13.5, lineHeight: 19, color: colors.muted, numberOfLines: 2 }}>{a().about}</Text>
                          </If>
                        </View>
                      </View>
                      <View style={{ flexDirection: "row", gap: 8, paddingLeft: props.wide ? 0 : 52 }}>
                        <Dropdown
                          testID={`cli-${a().id}`}
                          label={L("Model", "模型")}
                          value={cliLabel(a().clis)}
                          options={view()!.options.clis.map((c) => ({ id: cliKey(c), label: cliLabel(c), detail: cliDetail(c), testID: `cli-${a().id}-${cliKey(c)}` }))}
                          selected={cliKey(a().clis)}
                          onPick={(k) => { const c = view()!.options.clis.find((x) => cliKey(x) === k); if (c) save(patches.clis(a().id, c)); }}
                        />
                        <Dropdown
                          testID={`autonomy-${a().id}`}
                          label={L("Autonomy", "自主程度")}
                          value={autonomyLabel(a().autonomy)}
                          options={view()!.options.autonomy.map((l) => ({ id: l, label: autonomyLabel(l), detail: AUTONOMY_DETAIL()[l], testID: `autonomy-${a().id}-${l}` }))}
                          selected={a().autonomy}
                          onPick={(l) => save(patches.autonomy(a().id, l))}
                        />
                      </View>
                    </View>
                  )}
                </Each>
              </Group>
              </If>

              <If when={on("routines")}>
              <Group title={L("Routines", "例行任务")} hint={L("Rules that create tasks on a schedule: on/off and when they run", "定时生成任务的规则：开关和运行时间")}>
                <Each of={e().routines} key={(r) => r.name}>
                  {(r, i) => (
                    <View style={{ ...row(), flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: i() === 0 ? 0 : 0.5 }}>
                      <View style={{ flex: 1, gap: 3 }}>
                        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                          <Text style={{ fontSize: 15.5, fontWeight: "500", color: r().enabled ? colors.text : colors.faint }}>{r().name}</Text>
                          <If when={r().agent}>
                            <Text style={{ fontSize: 12.5, color: colors.faint }}>{e().agents.find((a) => a.id === r().agent)?.title ?? r().agent}</Text>
                          </If>
                        </View>
                        <If when={r().desc}>
                          <Text testID={`routine-desc-${r().name}`} style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>{r().desc}</Text>
                        </If>
                      </View>
                      <Dropdown
                        testID={`every-${r().name}`}
                        label={L("Runs", "运行")}
                        value={everyLabel(r().every)}
                        options={intervalsWith(r().every).map((iv) => ({ id: iv, label: everyLabel(iv), testID: `every-${r().name}-${iv}` }))}
                        selected={r().every}
                        onPick={(iv) => save(patches.routine(r().name, { every: iv }))}
                      />
                      <Toggle
                        testID={`routine-${r().name}`}
                        label={r().name}
                        value={r().enabled}
                        onChange={(on) => save(patches.routine(r().name, { enabled: on }))}
                      />
                    </View>
                  )}
                </Each>
              </Group>
              </If>

              <If when={on("parallel")}>
              <Group title={L("Parallelism", "并行")}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 14 }}>
                  <Text style={{ flex: 1, fontSize: 15.5, color: colors.text }}>{L("Tasks each machine runs at once", "每台机器同时运行的任务数")}</Text>
                  <ParallelInput value={e().max_parallel ?? 2} onChange={(value) => save(patches.maxParallel(value))} />
                </View>
              </Group>
              </If>
            </View>
          )}
        </If>
        </If>
        <If when={on("commands")}>
        <Group title={L("Commands", "常用指令")} hint={L("Type / in the message box to use one. Built-in commands perform an action; ones you add send a message to the team.", "在输入框里输入 / 选用。内置指令执行操作，你添加的指令把一段话发给团队。")}>
          <CommandRows settings={props.settings} />
        </Group>
        </If>
        <If when={on("storage")}>
        <Group title={L("Image retention", "图片保留")} hint={MEDIA_HINT()}>
          <MediaDaysChoices settings={props.settings} />
        </Group>
        </If>
        <If when={on("version")}>
        <Group title={L("Version", "版本")} hint={L("The code each machine runs. Updating makes every machine pull the latest code, and the primary also redeploys the server.", "每台机器运行的代码。更新会让所有机器拉取最新代码，主控机同时重新发布线上。")}>
          <VersionRows hub={props.hub} />
        </Group>
        </If>
        <If when={on("rules")}>
        <Group title={L("Memory", "记忆")} hint={L("The rules the team works by, your preferences, member profiles and past decisions. Read-only.", "团队做事依据的规则、你的偏好、成员档案和决策先例。只读。")}>
          <SetRow first label={L("View rules & memory", "查看规则与记忆")} chevron onPress={props.onRules} testID="settings-rules" />
        </Group>
        </If>
        <If when={on("account")}>
        <Group title={L("Language", "语言")}>
          <LangChoices />
        </Group>
        <Group title={L("Account", "账号与连接")} hint={L("You stay signed in on this device and reconnect automatically next time.", "登录状态保存在这台设备上，下次打开自动连接。")}>
          <View style={{ flexDirection: props.wide ? "row" : "column", alignItems: props.wide ? "center" : "stretch", gap: 10, paddingHorizontal: 16, paddingVertical: 14 }}>
            <View style={{ flex: props.wide ? 1 : undefined, flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Dot tone={props.hub.conn() === "live" ? "on" : props.hub.conn() === "unauthorized" || props.hub.conn() === "blocked" ? "bad" : "wait"} />
              <Text style={{ flex: 1, fontSize: 15, color: colors.text, numberOfLines: 1 }}>{props.hub.cfg.url}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Btn label={L("Sign out", "退出登录")} kind="danger" onPress={props.onDisconnect} testID="logout" />
            </View>
          </View>
        </Group>
        </If>
      </View>
    </Scroll>
    </View>
  );
}

// ---------------------------------------------------------------- settings on phones (iOS / Android Settings)

/** What the notification settings show and change, for both layouts. */
function notifyModel(push: Push, view: () => SettingsView | null, save: (patch: Record<string, unknown>) => void) {
  const tz = "Asia/Singapore";
  const prefs = () => notifyPrefsOf(view(), tz);
  const setPrefs = (change: Partial<NotifyPrefs>) => save(notifyPatch({ ...prefs(), ...change }));
  const state = () => {
    const i = push.info();
    if (!i) return systemNotifications() ? L("System notifications aren’t available here (open the hub’s web page in a phone browser to get push)", "这个环境还不能发系统通知（可以在手机浏览器打开 hub 的网页接收推送）") : L("Web push isn’t supported here (open the hub’s web page in a phone browser)", "这个环境不支持网页推送（请用手机浏览器打开 hub 的网页）");
    if (push.needsHomeScreen()) return L("On iPhone, add Noop to the Home Screen first", "iPhone 需要先把 Noop 添加到主屏幕");
    if (!i.supported) return L("This browser doesn’t support web push", "这个浏览器不支持网页推送");
    if (i.permission === "denied") return systemNotifications() ? L("Blocked by the system", "通知被系统拦截了") : L("Blocked by the browser", "通知被浏览器拦截了");
    return i.subscribed ? L("On", "已开启") : L("Off", "未开启");
  };
  /** The short form for a row's value. */
  const short = () => {
    const i = push.info();
    if (!i || !i.supported || push.needsHomeScreen()) return L("Unavailable", "不可用");
    if (i.permission === "denied") return L("Blocked", "已拦截");
    return i.subscribed ? L("On", "已开启") : L("Off", "未开启");
  };
  return { prefs, setPrefs, state, short };
}

/** A grouped, inset section: a muted title above, rows on one rounded surface, a hint below. */
function Section(props: { title?: string; hint?: string; testID?: string; children: JSX.Element }) {
  return (
    <View testID={props.testID} style={{ gap: 7 }}>
      <If when={props.title}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, color: colors.muted }}>{props.title}</Text>
      </If>
      <View style={{ marginHorizontal: 16, borderRadius: radius.card, borderCurve: "continuous", borderWidth: 0.5, borderColor: surfaceEdge(), overflow: "hidden", backgroundColor: colors.surface }}>{props.children}</View>
      <If when={props.hint}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.faint }}>{props.hint}</Text>
      </If>
    </View>
  );
}

/** The hairline above every row of a section but its first, inset to the text. */
function Hairline(props: { inset?: number }) {
  return <View style={{ position: "absolute", top: 0, left: props.inset ?? 16, right: 0, height: 0.5, backgroundColor: surfaceEdge() }} />;
}

/** A row of a section, at least 48 pt tall: a label (and a line under it), then a value, a control or a chevron. */

/** One row per online machine with the commit it runs, then the button that updates them all. */
/** The commands typed after "/" in the composer: the built-ins, the saved ones (deletable), and a form to add one. */
function CommandRows(props: { settings: Settings }) {
  const { view, save } = props.settings;
  const saved = () => savedCommands(view());
  const { name, text, editing, note } = props.settings.commandDraft;
  const open = (c?: Command) => {
    name.set(c?.name ?? ""); text.set(c?.text ?? ""); note.set("");
    editing.set(c?.name ?? "");
  };
  return (
    <>
      <SetRow
        first
        label={L("/Update all machines", "/更新所有机器")}
        detail={L("Make every machine pull the latest code and restart", "让所有机器拉取最新代码并重启")}
        testID="command-row-builtin"
        trailing={<Text style={{ fontSize: 12, color: colors.faint, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.raised }}>{L("Built-in", "内置")}</Text>}
      />
      <Each of={saved()} key={(c) => c.name}>
        {(c) => (
          <View
            role="button"
            testID={`command-row-${c().name}`}
            accessibilityLabel={L(`Edit command ${c().name}`, `编辑指令 ${c().name}`)}
            onPress={() => open(c())}
            hoverStyle={hovered()}
            class="active:bg-raised"
          >
            <Hairline />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 14, paddingVertical: 11 }}>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text style={{ fontSize: 15.5, fontWeight: "500", color: colors.text, numberOfLines: 1 }}>/{c().name}</Text>
                <Text style={{ fontSize: 13.5, lineHeight: 19, color: colors.muted, numberOfLines: 2 }}>{c().text}</Text>
              </View>
              <Icon name="chevron" size={14} tint={colors.faint} />
            </View>
          </View>
        )}
      </Each>
      <SetRow label={L("New command", "新建指令")} tone="accent" leading={<Icon name="plus" size={16} tint={colors.info} />} onPress={() => open()} testID="command-new" />
      <CommandEditor settings={props.settings} />
    </>
  );
}

/** New / edit / delete one saved command, in a dialog: a name and the words it sends (several lines welcome). */
function CommandEditor(props: { settings: Settings }) {
  const { view, save } = props.settings;
  const { name, text, editing, note } = props.settings.commandDraft;
  const isNew = () => editing() === "";
  const close = () => editing.set(undefined);
  const others = () => savedCommands(view()).filter((c) => c.name !== editing());
  const clean = () => name().trim().replace(/^\//, "").replace(/\s+/g, "-");
  const ok = () => !!clean() && !!text().trim();
  const submit = async () => {
    const n = clean(), t = text().trim();
    if (!n) return note.set(L("Give the command a name", "给指令起个名字"));
    if (!t) return note.set(L("Write what this command sends to the team", "写下这条指令要发给团队的话"));
    if (BUILTIN_COMMANDS().some((b) => b.name === n)) return note.set(L(`“${n}” is a built-in command`, `「${n}」是内置指令的名字`));
    if (others().some((c) => c.name === n)) return note.set(L(`“/${n}” already exists`, `已经有一条「/${n}」`));
    const list = savedCommands(view());
    const i = list.findIndex((c) => c.name === editing());
    const next = i < 0 ? [...list, { name: n, text: t }] : list.map((c, j) => (j === i ? { name: n, text: t } : c));
    close();
    await save({ commands: next });
  };
  const remove = async () => {
    const n = editing();
    close();
    await save({ commands: savedCommands(view()).filter((c) => c.name !== n) });
  };
  const focused = signal(false);
  return (
    <Dialog
      testID="command-editor"
      open={editing() !== undefined}
      animation="fade"
      onOpenChange={({ open }) => !open && close()}
      backdropClass="bg-scrim"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View style={{ width: "100%", maxWidth: 560, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 0.5, borderBottomColor: surfaceEdge() }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{isNew() ? L("New command", "新建指令") : L("Edit command", "编辑指令")}</Text>
          <ToolButton icon="close" label={L("Close", "关闭")} shortcut="Esc" onPress={close} />
        </View>
        <View style={{ gap: 16, padding: 20 }}>
          <Field label={L("Name", "名称")} value={name()} onChange={(v) => { name.set(v); note.set(""); }} placeholder={L("e.g. daily-report", "例如：日报")} testID="command-name" autoFocus={isNew()} hint={clean() ? L(`Type /${clean()} in the message box to use it`, `在输入框里输入 /${clean()} 选用`) : L("Type / and the name in the message box to use it", "在输入框里输入 / 加名称选用")} />
          <View style={{ gap: 7 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{L("Message to the team", "发给团队的话")}</Text>
            <Input
              testID="command-text"
              multiline
              value={text()}
              onChange={({ value }) => { text.set(value); note.set(""); }}
              onFocus={() => focused.set(true)}
              onBlur={() => focused.set(false)}
              placeholder={L("e.g. Summarize today’s progress on each project as a daily report,\none section per project, conclusion first.", "例如：把今天各项目的进展整理成日报发给我，\n按项目分段，每段先说结论。")}
              class="placeholder:text-faint"
              style={{
                height: 140,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: radius.control,
                borderWidth: 1,
                borderColor: focused() ? colors.accent : colors.fieldBorder,
                backgroundColor: colors.field,
                fontSize: 15.5,
                lineHeight: 23,
                color: colors.text,
                ...(focused() ? { outlineStyle: "solid", outlineWidth: 3, outlineColor: alpha(colors.accent, 0.12) } : {}),
              }}
            />
          </View>
          <If when={note()}>
            <Text testID="command-note" style={{ fontSize: 13.5, color: colors.danger }}>{note()}</Text>
          </If>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingBottom: 20 }}>
          <If when={!isNew()}>
            <Btn label={L("Delete", "删除")} kind="danger" icon="trash" onPress={() => void remove()} testID="command-delete" />
          </If>
          <View style={{ flex: 1 }} />
          <Btn label={L("Cancel", "取消")} kind="ghost" onPress={close} testID="command-cancel" />
          <Btn label={isNew() ? L("Add", "添加") : L("Save", "保存")} kind="primary" disabled={!ok()} onPress={() => void submit()} testID="command-save" />
        </View>
      </View>
    </Dialog>
  );
}

function VersionRows(props: { hub: Hub }) {
  const hosts = () => props.hub.status()?.hosts ?? [];
  // the lines age (waiting → not responding, finished → hidden): re-read the clock every few seconds
  const clock = signal(Date.now());
  const timer = setInterval(() => clock.set(Date.now()), 5000);
  cleanup(() => clearInterval(timer));
  const request = () => props.hub.status()?.update?.at;
  const summary = () => updateSummary(props.hub.status(), clock());
  const toneColor = (t: UpdateLine["tone"]) => (t === "ok" ? colors.up : t === "bad" ? colors.danger : colors.muted);
  // This app's own code: the release it was built for, or the OTA package it runs (nsh/updater).
  const ota = runningPackage();
  const client = ota ? L(`${ota.version} · OTA build ${ota.build}`, `${ota.version} · OTA 构建 ${ota.build}`) : CLIENT_VERSION;
  // The installed app around that code (on iOS its CFBundleShortVersionString / CFBundleVersion) and its NSH runtime.
  const info = (nshUpdater as { shellInfo?: () => ShellInfo }).shellInfo?.();
  const shell = shellLine(info, platform.os);
  const shellText = shell?.text === "no-packages" ? L(`${info!.version ?? "?"} (${info!.build ?? "?"}) takes no over-the-air updates: install the app again`, `${info!.version ?? "?"}（${info!.build ?? "?"}）收不到自动更新：请重新安装 App`)
    : shell?.text;
  return (
    <>
      <SetRow first label={L("This app", "本机客户端")} value={client} testID="version-client" />
      <If when={shell}>
        <SetRow label={L("App shell", "外壳")} value={shell?.tone === "ok" ? shellText : undefined} detail={shell?.tone === "bad" ? shellText : undefined} tone={shell?.tone === "bad" ? "danger" : undefined} testID="version-shell" />
      </If>
      <Each of={hosts()} key={(h) => h.host}>
        {(h) => {
          const line = () => updateLine(h(), request(), clock());
          return (
            <SetRow
              label={h().host}
              value={h().rev?.slice(0, 7) ?? L("Unknown", "未知")}
              chevron={!!h().rev_url}
              onPress={h().rev_url ? () => void openUrl(h().rev_url!).catch(() => {}) : undefined}
              testID={`version-${h().host}`}
              below={
                <If when={line()}>
                  <View testID={`update-${h().host}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <If when={line()!.busy}>
                      <Spinner size={12} tint={colors.muted} />
                    </If>
                    <Text style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: toneColor(line()!.tone) }}>{line()!.text}</Text>
                  </View>
                </If>
              }
            />
          );
        }}
      </Each>
      <SetRow
        first={!hosts().length}
        label={summary()?.busy ? L("Updating…", "正在更新…") : L("Update all machines", "更新所有机器")}
        detail={summary()?.text}
        tone="accent"
        disabled={!!summary()?.busy}
        onPress={() => void updateAllMachines(props.hub)}
        testID="update-fleet"
      />
    </>
  );
}

function SetRow(props: {
  label: string;
  detail?: string;
  value?: string;
  first?: boolean;
  chevron?: boolean;
  tone?: "danger" | "accent";
  leading?: JSX.Element;
  trailing?: JSX.Element;
  /** Under the label and detail (a progress line). */
  below?: JSX.Element;
  inset?: number;
  disabled?: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  const press = () => (props.disabled ? undefined : props.onPress);
  return (
    <View
      role={props.onPress ? "button" : undefined}
      testID={props.testID}
      accessibilityLabel={props.onPress ? [props.label, props.value].filter(Boolean).join("，") : undefined}
      accessibilityState={props.onPress ? { disabled: !!props.disabled } : undefined}
      onPress={press()}
      class={props.onPress && !props.disabled ? "active:bg-raised" : undefined}
      style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 14, paddingVertical: 10 }}
    >
      <If when={!props.first}>
        <Hairline inset={props.inset} />
      </If>
      {props.leading}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          style={{
            fontSize: 16,
            textAlign: props.tone === "danger" && !props.trailing && !props.chevron ? "center" : "left",
            color: props.disabled ? colors.faint : props.tone === "danger" ? colors.danger : props.tone === "accent" ? colors.info : colors.text,
            numberOfLines: 1,
          }}
        >
          {props.label}
        </Text>
        <If when={props.detail}>
          <Text style={{ fontSize: 13, lineHeight: 18, color: colors.muted }}>{props.detail}</Text>
        </If>
        {props.below}
      </View>
      <If when={props.value}>
        <Text style={{ flexShrink: 1, fontSize: 16, color: colors.muted, numberOfLines: 1 }}>{props.value}</Text>
      </If>
      {props.trailing}
      <If when={props.chevron}>
        <Icon name="chevron" size={14} tint={colors.faint} />
      </If>
    </View>
  );
}

const MEDIA_HINT = () => L("How long screenshots and images in the chat are kept. They’re deleted when they expire.", "聊天里的截图和图片保存多久，过期后自动删除。");

/** How long images are kept: 7, 14, 30 or 90 days. */
function MediaDaysChoices(props: { settings: Settings }) {
  const { view, save } = props.settings;
  return (
    <Choices
      label={L("Image retention", "图片保留")}
      choices={MEDIA_DAYS.map((d) => ({ id: String(d), label: L(`${d} days`, `${d} 天`), testID: `media-days-${d}` }))}
      selected={view() ? String(mediaDaysOf(view())) : null}
      onPick={(id) => save(patches.mediaDays(Number(id)))}
    />
  );
}

type Choice = { id: string; label: string; detail?: string; testID: string };

/** Pick one of a few: a radio set of rows, the chosen one checked. */
function Choices(props: { label: string; choices: Choice[]; selected: string | null; onPick: (id: string) => void }) {
  return (
    <RadioGroup>
      <Each of={props.choices} key={(c) => c.id}>
        {(c, i) => (
          <Radio
            testID={c().testID}
            checked={c().id === props.selected}
            onChange={() => props.onPick(c().id)}
            accessibilityLabel={c().label}
            class="active:bg-raised"
            style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16, paddingRight: 16, paddingVertical: 10 }}
          >
            <If when={i() > 0}>
              <Hairline />
            </If>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 16, color: colors.text }}>{c().label}</Text>
              <If when={c().detail}>
                <Text style={{ fontSize: 13, color: colors.muted }}>{c().detail}</Text>
              </If>
            </View>
            <View style={{ width: 20, alignItems: "center" }}>
              <If when={c().id === props.selected}>
                <View testID={`choice-check-${c().testID}`}><Icon name="check" size={17} tint={colors.info} /></View>
              </If>
            </View>
          </Radio>
        )}
      </Each>
    </RadioGroup>
  );
}

/** A page of sections on the grouped background. */
function Grouped(props: { testID?: string; settings?: Settings; children: JSX.Element }) {
  return (
    <View style={{ flex: 1, backgroundColor: platform.os === "ios" ? (isDark() ? "#1c1c1e" : "#f2f2f2") : colors.background }}>
      <If when={props.settings}><SaveNote settings={props.settings!} /></If>
      <Scroll testID={props.testID} style={{ flex: 1 }}>
        <View style={{ width: "100%", maxWidth: 640, alignSelf: "center", gap: 28, paddingTop: 20, paddingBottom: Math.max(32, safeArea().bottom + 16) }}>{props.children}</View>
      </Scroll>
    </View>
  );
}

function SaveNote(props: { settings: Settings }) {
  return (
    <If when={props.settings.error()}>
      <Text testID="settings-note" style={{ paddingHorizontal: 32, paddingVertical: 8, fontSize: 13, color: props.settings.error() ? colors.danger : colors.up }}>
        {props.settings.error()}
      </Text>
    </If>
  );
}

const routineValue = (r: { enabled: boolean; every: string }) => (r.enabled ? everyLabel(r.every) : L("Off", "已关闭"));

/** 设置 on a phone: a list of sections; 通知, each member and each routine push pages of their own. */
export function PhoneSettings(props: { hub: Hub; push: Push; settings: Settings; onOpen: (r: SettingsRoute) => void; onDisconnect: () => void }) {
  const { view, error, save } = props.settings;
  props.settings.load();
  const notify = notifyModel(props.push, view, save);
  const eff = () => view()?.effective;
  async function logout() {
    const r = await AlertDialog.show({
      title: L("Sign out?", "退出登录？"),
      description: L("Notifications will be turned off on this device, and you’ll need to sign in again next time.", "这台设备会关闭通知，下次打开需要重新登录。"),
      actions: [
        { id: "cancel", label: L("Cancel", "取消"), role: "cancel" },
        { id: "logout", label: L("Sign out", "退出登录"), role: "destructive" },
      ],
    });
    if (r.action === "logout") props.onDisconnect();
  }
  return (
    <Grouped testID="phone-settings" settings={props.settings}>
      <Section title={L("Notifications", "通知")} hint={L("Decisions that need you are pushed to this device. You can pick an option right from the notification.", "需要你拍板的事推送到这台设备；通知上可以直接选择选项。")}>
        <SetRow first label={L("Notifications", "通知")} value={notify.short()} chevron onPress={() => props.onOpen({ name: "notify" })} testID="settings-notify" />
      </Section>
      <Section title={L("Language", "语言")}>
        <LangChoices />
      </Section>
      <Section title={L("Memory", "记忆")} hint={L("The rules the team works by, your preferences, member profiles and past decisions. Read-only.", "团队做事依据的规则、你的偏好、成员档案和决策先例。只读。")}>
        <SetRow first label={L("Rules & memory", "规则与记忆")} chevron onPress={() => props.onOpen({ name: "rules" })} testID="settings-rules" />
      </Section>
      <If when={eff()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>{error() ? L("Couldn’t load settings", "设置读取失败") : L("Loading…", "读取中…")}</Text>}>
        {(e) => (
          <View style={{ gap: 28 }}>
            <Section title={L("Members", "成员")} hint={L("Model: which to use first, and which to switch to on failure or when out of quota. Autonomy: how big a decision needs your input first.", "模型：先用哪个、失败或额度用尽时换哪个；自主程度：多大的事需要先问你。")}>
              <Each of={e().agents} key={(a) => a.id}>
                {(a, i) => (
                  <SetRow
                    first={i() === 0}
                    inset={58}
                    leading={<Avatar from={a().id} />}
                    label={displayName(a().id)}
                    detail={`${cliLabel(a().clis)} · ${autonomyLabel(a().autonomy)}`}
                    chevron
                    onPress={() => props.onOpen({ name: "member", id: a().id })}
                    testID={`member-${a().id}`}
                  />
                )}
              </Each>
            </Section>
            <Section title={L("Routines", "例行任务")} hint={L("Things the team does on a schedule.", "团队定时自己做的事。")}>
              <Each of={e().routines} key={(r) => r.name}>
                {(r, i) => (
                  <SetRow
                    first={i() === 0}
                    label={r().name}
                    detail={r().agent}
                    value={routineValue(r())}
                    chevron
                    onPress={() => props.onOpen({ name: "routine", routine: r().name })}
                    testID={`routine-row-${r().name}`}
                  />
                )}
              </Each>
            </Section>
            <Section title={L("Parallelism", "并行")} hint={L("Tasks each machine runs at once, 1 to 32.", "每台机器同时运行的任务数，1 到 32。")}>
              <SetRow
                first
                label={L("At once", "同时运行")}
                trailing={
                  <ParallelInput value={e().max_parallel ?? 2} onChange={(value) => save(patches.maxParallel(value))} />
                }
              />
            </Section>
          </View>
        )}
      </If>
      <Section title={L("Commands", "常用指令")} hint={L("Type / in the message box to use one. Built-in commands perform an action; ones you add send a message to the team.", "在输入框里输入 / 选用。内置指令执行操作，你添加的指令把一段话发给团队。")}>
        <CommandRows settings={props.settings} />
      </Section>
      <Section title={L("Image retention", "图片保留")} hint={MEDIA_HINT()}>
        <MediaDaysChoices settings={props.settings} />
      </Section>
      <Section title={L("Version", "版本")} hint={L("The code each machine runs. Updating makes every machine pull the latest code, and the primary also redeploys the server.", "每台机器运行的代码。更新会让所有机器拉取最新代码，主控机同时重新发布线上。")}>
        <VersionRows hub={props.hub} />
      </Section>
      <Section title={L("Account", "账号与连接")} hint={L("You stay signed in on this device and reconnect automatically next time.", "登录状态保存在这台设备上，下次打开自动连接。")}>
        <SetRow
          first
          leading={<Dot tone={props.hub.conn() === "live" ? "on" : props.hub.conn() === "unauthorized" || props.hub.conn() === "blocked" ? "bad" : "wait"} />}
          label={props.hub.cfg.url.replace(/^https?:\/\//, "")}
        />
        <SetRow label={L("Sign out", "退出登录")} tone="danger" onPress={() => void logout()} testID="logout" inset={0} />
      </Section>
    </Grouped>
  );
}

/** 通知 on a phone: this device, what is pushed, and the quiet hours. */
export function PhoneNotify(props: { push: Push; settings: Settings }) {
  const push = props.push;
  const { view, save } = props.settings;
  const notify = notifyModel(push, view, save);
  return (
    <Grouped testID="phone-notify" settings={props.settings}>
      <Section title={L("This device", "本设备")} hint={L("When on, important messages are pushed to this device.", "开启后，重要消息会推送到这台设备。")}>
        <SetRow first label={push.info()?.device ?? L("This device", "本设备")} trailing={<Text testID="push-state" style={{ fontSize: 16, color: colors.muted }}>{notify.short()}</Text>} />
        <If
          when={push.info()?.subscribed}
          else={<SetRow label={L("Turn on notifications", "开启通知")} tone="accent" disabled={!push.canAsk() || push.busy()} onPress={push.enable} testID="push-enable" />}
        >
          <SetRow label={L("Send test notification", "发送测试通知")} tone="accent" disabled={push.busy()} onPress={push.test} testID="push-test" />
          <SetRow label={L("Turn off on this device", "关闭本设备通知")} tone="danger" onPress={push.disable} testID="push-disable" />
        </If>
      </Section>
      <If when={push.note()}>
        <Text testID="push-note" style={{ marginTop: -20, paddingHorizontal: 32, fontSize: 13, color: colors.danger }}>{push.note()}</Text>
      </If>
      <If when={push.needsHomeScreen()}>
        <Section title={L("Turn on notifications on iPhone", "在 iPhone 上开启通知")}>
          <View style={{ padding: 16 }}>
            <Steps steps={[L("In Safari, tap the Share button at the bottom", "在 Safari 里点底部的「分享」按钮"), L("Choose “Add to Home Screen”, then tap “Add”", "选「添加到主屏幕」，再点「添加」"), L("Open Noop from the Home Screen, sign in, and tap “Turn on notifications” here", "从主屏幕打开 Noop，登录后回到这里点「开启通知」")]} />
          </View>
        </Section>
      </If>
      <If when={push.info()?.permission === "denied" && !push.needsHomeScreen()}>
        <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.muted }}>{L(`${notify.state()}: allow Noop in the browser’s site settings (or System Settings → Notifications), then reload and turn it on.`, `${notify.state()}：在浏览器的网站设置（或系统设置 → 通知）里允许 Noop，然后刷新页面再开启。`)}</Text>
      </If>
      <If when={view()}>
        <Section title={L("What to push", "推送哪些")}>
          <Each of={NOTIFY_KINDS()}>
            {(k, i) => (
              <SetRow
                first={i() === 0}
                label={k()[1]}
                trailing={
                  <Toggle
                    testID={`notify-${k()[0]}`}
                    label={k()[1]}
                    value={notify.prefs().kinds[k()[0]]}
                    onChange={(on) => notify.setPrefs({ kinds: { ...notify.prefs().kinds, [k()[0]]: on } })}
                  />
                }
              />
            )}
          </Each>
        </Section>
        <Section title={L("Quiet hours", "免打扰时段")} hint={L(`Recorded but not pushed during these hours (time zone ${notify.prefs().tz}).`, `这段时间只记下，不推送（时区 ${notify.prefs().tz}）。`)}>
          <Choices
            label={L("Quiet hours", "免打扰时段")}
            choices={QUIET_PRESETS().map((q) => ({ id: quietKey(q.value), label: q.label, testID: `quiet-${quietKey(q.value)}` }))}
            selected={quietKey(notify.prefs().quiet_hours)}
            onPick={(id) => notify.setPrefs({ quiet_hours: QUIET_PRESETS().find((q) => quietKey(q.value) === id)!.value })}
          />
        </Section>
      </If>
    </Grouped>
  );
}

/** A member on a phone: its models and its autonomy. */
export function PhoneMember(props: { id: string; settings: Settings }) {
  const { view, save } = props.settings;
  const agent = () => view()?.effective.agents.find((a) => a.id === props.id);
  return (
    <Grouped testID="phone-member" settings={props.settings}>
      <If when={agent()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>{L("No such member", "没有这个成员")}</Text>}>
        {(a) => (
          <>
            <Section title={L("Model", "模型")} hint={L("Which to use first; switches to the next on failure or when out of quota.", "先用哪个；失败或额度用尽时换下一个。")}>
              <Choices
                label={L("Model", "模型")}
                choices={view()!.options.clis.map((c) => ({ id: cliKey(c), label: cliLabel(c), testID: `cli-${props.id}-${cliKey(c)}` }))}
                selected={cliKey(a().clis)}
                onPick={(id) => save(patches.clis(props.id, view()!.options.clis.find((c) => cliKey(c) === id)!))}
              />
            </Section>
            <Section title={L("Autonomy", "自主程度")} hint={L("How big a decision needs your input first.", "多大的事需要先问你。")}>
              <Choices
                label={L("Autonomy", "自主程度")}
                choices={view()!.options.autonomy.map((l) => ({ id: l, label: autonomyLabel(l), testID: `autonomy-${props.id}-${l}` }))}
                selected={a().autonomy}
                onPick={(l) => save(patches.autonomy(props.id, l))}
              />
            </Section>
          </>
        )}
      </If>
    </Grouped>
  );
}

/** A routine on a phone: on or off, and how often. */
export function PhoneRoutine(props: { name: string; settings: Settings }) {
  const { view, save } = props.settings;
  const routine = () => view()?.effective.routines.find((r) => r.name === props.name);
  return (
    <Grouped testID="phone-routine" settings={props.settings}>
      <If when={routine()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: colors.faint }}>{L("No such routine", "没有这个例行任务")}</Text>}>
        {(r) => (
          <>
            <Section hint={[r().desc, r().agent && L(`Run by ${r().agent}.`, `由 ${r().agent} 执行。`)].filter(Boolean).join("\n")}>
              <SetRow
                first
                label={L("Enabled", "启用")}
                trailing={<Toggle testID={`routine-${props.name}`} label={L("Enabled", "启用")} value={r().enabled} onChange={(on) => save(patches.routine(props.name, { enabled: on }))} />}
              />
            </Section>
            <Section title={L("Interval", "运行间隔")}>
              <Choices
                label={L("Interval", "运行间隔")}
                choices={intervalsWith(r().every).map((iv) => ({ id: iv, label: everyLabel(iv), testID: `every-${props.name}-${iv}` }))}
                selected={r().every}
                onPick={(iv) => save(patches.routine(props.name, { every: iv }))}
              />
            </Section>
          </>
        )}
      </If>
    </Grouped>
  );
}

// ---------------------------------------------------------------- the team's rules and memory (read-only)

/** 记忆: policies, the owner's memory, each agent's profile and memory, closed decisions. */
export function RulesList(props: { hub: Hub; onOpen: (path: string) => void }) {
  const groups = signal<RuleGroup[] | null>(null);
  const error = signal("");
  void (async () => {
    const lists: Record<string, DataFile[]> = {};
    for (const pre of RULE_PREFIXES) {
      const r = await props.hub.api("GET", `/api/files/list?prefix=${encodeURIComponent(pre)}`);
      if (!r.ok) { error.set(r.status ? L(`Couldn’t load (${r.status})`, `读取失败（${r.status}）`) : L("Can’t reach the server", "连不上服务器")); return; }
      lists[pre] = (r.data.files as DataFile[] | undefined) ?? [];
    }
    groups.set(groupRules(lists));
  })();
  return (
    <Grouped testID="rules">
      <Text style={{ paddingHorizontal: 32, fontSize: 13, lineHeight: 18, color: colors.muted }}>{L("The rules and memory the team works by. Read-only; the team maintains them as it works.", "团队做事依据的规则和记忆。这里只读，内容由团队在工作中维护。")}</Text>
      <If when={groups()} else={<Text style={{ paddingHorizontal: 32, fontSize: 14, color: error() ? colors.danger : colors.faint }}>{error() || L("Loading…", "读取中…")}</Text>}>
        {(gs) => (
          <Each of={gs()} key={(g) => g.key}>
            {(g) => (
              <Section title={g().title} hint={g().hint} testID={`rules-${g().key}`}>
                <If when={g().items.length} else={<SetRow first label={L("Nothing yet", "暂无内容")} disabled />}>
                  <Each of={g().items} key={(it) => it.path}>
                    {(it, i) => (
                      <SetRow first={i() === 0} label={it().title} value={it().detail} chevron onPress={() => props.onOpen(it().path)} testID={`rule-${it().path}`} />
                    )}
                  </Each>
                </If>
              </Section>
            )}
          </Each>
        )}
      </If>
    </Grouped>
  );
}

/** One rules or memory file, rendered as markdown. Read-only. */
export function RuleDoc(props: { hub: Hub; path: string; wide: boolean }) {
  const text = signal<string | null>(null);
  const error = signal("");
  void props.hub.api("GET", `/api/files/read?path=${encodeURIComponent(props.path)}`).then((r) => {
    if (r.ok && typeof r.data.content === "string") text.set(stripFrontMatter(r.data.content));
    else error.set(r.status === 404 ? L("This file no longer exists.", "这个文件已经不在了。") : r.status ? L(`Couldn’t load (${r.status})`, `读取失败（${r.status}）`) : L("Can’t reach the server", "连不上服务器"));
  });
  return (
    <Scroll testID="rule-doc" style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 12, paddingHorizontal: props.wide ? 32 : 16, paddingTop: 20, paddingBottom: Math.max(32, safeArea().bottom + 16) }}>
        <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{props.path}</Text>
        <If when={text() !== null} else={<Text style={{ fontSize: 14, color: error() ? colors.danger : colors.faint }}>{error() || L("Loading…", "读取中…")}</Text>}>
          <If when={(text() ?? "").trim()} else={<Text style={{ fontSize: 14, color: colors.faint }}>{L("(Empty file)", "（空文件）")}</Text>}>
            <View selectable><Rich text={text() ?? ""} /></View>
          </If>
        </If>
      </View>
    </Scroll>
  );
}
