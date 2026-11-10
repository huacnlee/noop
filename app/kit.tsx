// The app's small shared pieces (the gallery's idioms): sizes, buttons, the avatar, a text field. Imported by the
// chat (App.tsx) and by the interfaces loaded later (settings, the report reader, ...), never importing either.
import { alpha, colors, focusRing, hovered, Icon, type IconName, radius, Spinner, tints, Tip } from "./ui";
import { Image, platform, signal, Storage, Text, token, View, type ViewStyle } from "nsh";
import { Input } from "nsh/base";
import { L, lang, LANG_KEY } from "./i18n";
import { agentDisplayName, avatarOf } from "./avatars";
import { isHub } from "./hub";

/** A sender's name in the current language (agents localized, others without the @host). */
export const displayName = (from: string): string => agentDisplayName(from, lang() === "zh");

export const touch = !(platform.idiom === "desktop" || platform.idiom === "mac");
/** iOS and Android draw the pages' headers (title, back, swipe back); the desktops and the web show the app's. */
export const systemHeader = platform.os === "ios" || platform.os === "android";
export const MONO = "monospace";

/** Sizes: the gallery's proportions, a step larger (the owner reads this all day). */
export const size = {
  text: 17,
  line: 26,
  small: 15,
  tiny: 13,
  control: touch ? 44 : 38,
  row: touch ? 44 : 34,
  bar: touch ? 56 : 52,
  sidebar: 288,
  column: 880,
};

export function pickLang(id: string) {
  if (id !== "en" && id !== "zh") return;
  lang.set(id);
  Storage.setItem(LANG_KEY, id);
}

/** A key as a small badge: `1`, `Enter`, `⌘K`. */
export function Kbd(props: { k: string; on?: string }) {
  return (
    <View
      style={{
        minWidth: 22,
        height: 22,
        paddingHorizontal: 6,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 5,
        borderWidth: 1,
        borderColor: props.on ? alpha(props.on, 0.35) : colors.border,
        backgroundColor: props.on ? "transparent" : colors.raised,
      }}
    >
      <Text style={{ fontSize: 12.5, fontWeight: "500", color: props.on ?? colors.muted, fontVariant: ["tabular-nums"] }}>{props.k}</Text>
    </View>
  );
}

/** A quiet icon button of the toolbars and the sidebar (the gallery's ToolButton, at 36 pt). */
export function ToolButton(props: { icon: IconName; label: string; shortcut?: string; on?: boolean; onPress: () => void; testID?: string; noTooltip?: boolean; compact?: boolean }) {
  return (
    <View
      onPress={props.onPress}
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={props.on === undefined ? undefined : { selected: props.on }}
      tooltip={props.noTooltip ? undefined : <Tip label={props.label} shortcut={props.shortcut} />}
      hoverStyle={hovered()}
      activeStyle={{ backgroundColor: alpha(colors.text, 0.09) }}
      focusStyle={focusRing()}
      style={{ width: touch ? 44 : 32, height: touch ? 44 : 32, alignItems: "center", justifyContent: "center", borderRadius: radius.control, borderCurve: "continuous", borderWidth: 1, borderColor: "transparent" }}
    >
      <Icon name={props.icon} size={18} tint={props.on ? colors.accent : colors.muted} />
    </View>
  );
}

export type BtnKind = "primary" | "secondary" | "ghost" | "dashed" | "danger";

/** Shared edge for controls and grouped settings surfaces. */
export const surfaceEdge = () => colors.line;

/** A labelled button: the gallery's raised / accent-filled look, 38 pt (44 on touch). */
export function Btn(props: {
  label: string;
  kind?: BtnKind;
  icon?: IconName;
  kbd?: string;
  note?: string;
  busy?: boolean;
  disabled?: boolean;
  /** the option the owner picked: a check and an accent edge, not dimmed */
  checked?: boolean;
  onPress: () => void;
  testID?: string;
  accessibilityLabel?: string;
  grow?: boolean;
}) {
  const kind = () => props.kind ?? "secondary";
  const fg = () => (kind() === "primary" ? colors.onAccent : kind() === "danger" ? colors.danger : kind() === "dashed" || kind() === "ghost" ? colors.muted : colors.text);
  const look = (): ViewStyle =>
    kind() === "primary"
      ? { backgroundColor: colors.accentFill, borderColor: "transparent" }
      : kind() === "danger"
        ? { backgroundColor: tints.danger, borderColor: alpha(colors.danger, 0.3) }
        : kind() === "ghost"
          ? { backgroundColor: "transparent", borderColor: "transparent" }
          : kind() === "dashed"
            ? { backgroundColor: "transparent", borderColor: colors.fieldBorder, borderStyle: "dashed" }
            : { backgroundColor: colors.surface, borderColor: surfaceEdge() };
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: !!props.disabled, ...(props.checked ? { checked: true } : {}) }}
      onPress={() => !props.disabled && !props.busy && props.onPress()}
      hoverStyle={props.disabled ? undefined : kind() === "primary" ? { opacity: 0.92 } : hovered()}
      activeStyle={props.disabled ? undefined : kind() === "primary" ? { opacity: 0.85 } : { backgroundColor: alpha(colors.text, 0.09) }}
      focusStyle={focusRing()}
      style={{
        minHeight: size.control,
        maxWidth: "100%",
        flexShrink: 1,
        flexGrow: props.grow ? 1 : 0,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: radius.control,
        borderCurve: "continuous",
        borderWidth: props.checked ? 1.5 : 0.5,
        opacity: props.disabled && !props.checked ? 0.45 : 1,
        transitionProperty: "background-color, border-color, opacity",
        transitionDuration: 120,
        ...look(),
        ...(props.checked ? { backgroundColor: tints.accent, borderColor: colors.accentFill, cursor: "default" } : props.disabled ? { cursor: "default" } : {}),
      }}
    >
      <If when={props.checked}>
        <Icon name="check" size={16} tint={colors.accentFill} />
      </If>
      <If when={props.kbd}>
        <Kbd k={props.kbd!} on={kind() === "primary" ? colors.onAccent : undefined} />
      </If>
      <If when={props.busy}>
        <Spinner size={14} tint={fg()} />
      </If>
      <If when={!props.busy && props.icon}>
        <Icon name={props.icon!} size={16} tint={fg()} />
      </If>
      <Text style={{ flexShrink: 1, textAlign: "center", fontSize: 15, lineHeight: 21, fontWeight: kind() === "primary" ? "600" : "500", color: fg() }}>{props.label}</Text>
      <If when={props.note}>
        <Text style={{ fontSize: size.tiny, color: kind() === "primary" ? alpha(colors.onAccent, 0.7) : colors.faint }}>{props.note}</Text>
      </If>
    </View>
  );
}

/** Links use a quiet, underlined accent shared by the app's themes. */
export const linkColor = () => token("link");

export function Dot(props: { tone: "on" | "run" | "queue" | "wait" | "off" | "bad" }) {
  const color = () => ({ on: colors.up, run: colors.up, queue: colors.info, wait: colors.warn, off: colors.faint, bad: colors.danger })[props.tone];
  return <View style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, backgroundColor: color() }} />;
}

/** Each agent's own color and mark, the same everywhere it appears (stable by its id). */
export const MARKS = ["★", "◆", "▲", "●", "✦", "☾", "✿", "♪"];

export function persona(from: string): { tint: string; mark: string } {
  const id = from.split("@")[0].toLowerCase();
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { tint: token(`agent-${(h % 8) + 1}` as "agent-1"), mark: MARKS[(h >>> 3) % MARKS.length] };
}

export function Avatar(props: { from: string; small?: boolean; testID?: string }) {
  const hubbed = isHub(props.from);
  const p = persona(props.from);
  const box = props.small ? 22 : 36;
  return (
    <View
      testID={props.testID}
      accessibilityLabel={displayName(props.from)}
      style={{
        width: box,
        height: box,
        borderRadius: box / 2,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hubbed ? colors.raised : alpha(p.tint, 0.16),
      }}
    >
      <If when={hubbed} else={
        <If when={avatarOf(props.from) !== null} else={<>
          <Text style={{ fontSize: props.small ? 12 : 16, fontWeight: "700", color: p.tint }}>{displayName(props.from).slice(0, 1).toUpperCase()}</Text>
          <If when={!props.small}>
            <View style={{ position: "absolute", right: -3, bottom: -3, width: 17, height: 17, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
              <Text style={{ fontSize: 10, lineHeight: 12, color: p.tint }}>{p.mark}</Text>
            </View>
          </If>
        </>}>
          <Image src={avatarOf(props.from) ?? ""} style={{ width: box, height: box, borderRadius: box / 2 }} />
        </If>
      }>
        <View style={{ width: props.small ? 8 : 12, height: props.small ? 8 : 12, borderRadius: 6, backgroundColor: colors.muted }} />
      </If>
    </View>
  );
}

/** A task's state: its label, color and mark. */
export const STATE_OF = (): Record<string, [string, string, string]> => ({
  active: [L("In progress", "进行中"), colors.up, "●"], inbox: [L("Queued", "排队中"), colors.info, "○"], waiting: [L("Waiting on subtasks", "等子任务"), colors.warn, "○"], nohost: [L("Waiting for a machine", "等机器"), colors.warn, "○"], parked: [L("Waiting on external result", "等外部结果"), colors.warn, "○"],
  blocked: [L("Needs your decision", "等你决定"), colors.warn, "!"], failed: [L("Failed", "失败"), colors.danger, "✕"], done: [L("Done", "完成"), colors.faint, "✓"], cancelled: [L("Cancelled", "已取消"), colors.faint, "✕"],
});

export function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  masked?: boolean;
  testID?: string;
  hint?: string;
  autoFocus?: boolean;
  keyboardType?: "email-address" | "number-pad" | "url";
  autoComplete?: "email" | "one-time-code" | "url";
  maxLength?: number;
  big?: boolean;
}) {
  const focused = signal(false);
  return (
    <View style={{ gap: 7 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{props.label}</Text>
      <Input
        testID={props.testID}
        value={props.value}
        masked={props.masked}
        autoFocus={props.autoFocus}
        keyboardType={props.keyboardType}
        autoComplete={props.autoComplete}
        maxLength={props.maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={props.placeholder}
        class="placeholder:text-faint"
        submitBehavior="submit"
        onSubmit={() => props.onSubmit?.()}
        onChange={({ value }) => props.onChange(value)}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        style={{
          height: props.big ? 56 : 44,
          paddingHorizontal: 14,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: focused() ? colors.accent : colors.fieldBorder,
          backgroundColor: colors.field,
          fontSize: 16,
          color: colors.text,
          ...(props.big ? { fontSize: 26, letterSpacing: 10, textAlign: "center", fontVariant: ["tabular-nums"] } : {}),
          ...(focused() ? { outlineStyle: "solid", outlineWidth: 3, outlineColor: alpha(colors.accent, 0.12) } : {}),
        }}
      />
      <If when={props.hint}>
        <Text style={{ fontSize: 13, lineHeight: 19, color: colors.muted }}>{props.hint}</Text>
      </If>
    </View>
  );
}
