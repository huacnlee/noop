// The app's small shared pieces: names, the avatar, task states, a text field. Imported by the
// chat (App.tsx) and by the interfaces loaded later (settings, the report reader, ...), never importing either.
import { alpha, colors, corner, statusColor } from "./ui";
import { Image, Keyboard, platform, signal, Storage, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import { L, lang, LANG_KEY } from "./i18n";
import { agentDisplayName, avatarOf } from "./avatars";
import { isHub } from "./hub";

/** A sender's name in the current language (agents localized, others without the @host). */
export const displayName = (from: string): string => agentDisplayName(from, lang() === "zh");

/** iOS and Android draw the pages' headers (title, back, swipe back); the desktops and the web show the app's. */
export const systemHeader = platform.os === "ios" || platform.os === "android";
export const MONO = "monospace";

/**
 * macOS sends Copy to the input that has the keyboard, so with a box still focused, text selected on the page above it
 * cannot be copied (NSH before #1410). A press on a page with no input of its own (a task's conversation, the reader)
 * gives the keyboard back to the window, as the main timeline does for its composer.
 */
export const releaseKeyboard = () => { if (platform.os === "macos") Keyboard.dismiss(); };

export function pickLang(id: string) {
  if (id !== "en" && id !== "zh") return;
  lang.set(id);
  Storage.setItem(LANG_KEY, id);
}

/** Shared edge for controls and grouped settings surfaces. */
export const surfaceEdge = () => colors.line;

/** Links use a quiet, underlined accent shared by the app's themes. */
export const linkColor = () => token("link");

/** Each agent's own color and mark, the same everywhere it appears (stable by its id). */
export const MARKS = ["★", "◆", "▲", "●", "✦", "☾", "✿", "♪"];

export function persona(from: string): { tint: string; mark: string } {
  const id = from.split("@")[0].toLowerCase();
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { tint: token(`agent-${(h % 8) + 1}` as "agent-1"), mark: MARKS[(h >>> 3) % MARKS.length] };
}

export function Avatar(props: { from: string; small?: boolean; testID?: string }) {
  // The hub speaks as 顺风耳 (avatars.ts); the grey dot only if a hub sender ever has no avatar.
  const hubbed = isHub(props.from) && avatarOf(props.from) === null;
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

/** A task's state: its label, color (its dot's, `TONE`) and mark. */
export const STATE_OF = (): Record<string, [string, string, string]> => ({
  active: [L("In progress", "进行中"), statusColor("running"), "●"], inbox: [L("Queued", "排队中"), statusColor("queued"), "○"], waiting: [L("Waiting on subtasks", "等子任务"), statusColor("waiting"), "○"], nohost: [L("Waiting for a machine", "等机器"), statusColor("waiting"), "○"], parked: [L("Waiting on external result", "等外部结果"), statusColor("waiting"), "○"],
  blocked: [L("Needs your decision", "等你决定"), statusColor("waiting"), "!"], failed: [L("Failed", "失败"), statusColor("error"), "✕"], done: [L("Done", "完成"), statusColor("done"), "✓"], cancelled: [L("Cancelled", "已取消"), statusColor("idle"), "✕"],
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
          borderRadius: corner.field,
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
