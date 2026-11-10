// The keyboard shortcuts sheet: a lazy chunk, loaded the first time `?` asks for it (lazy.tsx).
import { keymap, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { L } from "./i18n";
import { colors, IconButton, Kbd } from "./ui";
import { surfaceEdge } from "./kit";

// ---------------------------------------------------------------- keyboard help

const SHORTCUTS = (): [string, string][] => [
  ["Enter", L("Send", "发送")],
  ["Shift+Enter", L("New line", "换行")],
  [`${keymap.label("mod+enter")}`, L("Send (anytime)", "发送（任何时候）")],
  [`/  ·  ${keymap.label("mod+k")}`, L("Focus the message box", "聚焦输入框")],
  [`1 – 9  ·  ${keymap.label("alt+1")}…`, L("Pick an option on the current decision", "选择当前决策的选项")],
  [`J / K  ·  ${keymap.label("alt+j")} / ${keymap.label("alt+k")}`, L("Next / previous pending decision", "下一个 / 上一个待决策")],
  [`R  ·  ${keymap.label("alt+r")}`, L("Reply to the current decision (other instructions)", "回复当前决策（其他指示）")],
  [`G  ·  ${keymap.label("alt+g")}`, L("Back to bottom", "回到底部")],
  ["Esc", L("Cancel reply / leave the message box / close", "取消回复 / 离开输入框 / 关闭")],
  [keymap.label("mod+,"), L("Team settings", "团队设置")],
  [keymap.label("mod+b"), L("Show / hide sidebar", "显示 / 隐藏侧栏")],
  [keymap.label("mod+shift+l"), L("Toggle light / dark", "切换浅色 / 深色")],
  ["?", L("All keyboard shortcuts", "快捷键一览")],
];

/** The keyboard shortcuts, in a `Dialog`: Escape, the backdrop and the close button close it. */
export function HelpSheet(props: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      testID="help"
      open={props.open}
      animation="fade"
      onOpenChange={({ open }) => !open && props.onClose()}
      backdropClass="bg-scrim"
      backdropTestID="help-backdrop"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}
    >
      <View
        accessibilityLabel={L("Keyboard shortcuts", "键盘快捷键")}
        style={{
          width: "100%",
          maxWidth: 520,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          overflow: "hidden",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10, height: 56, borderBottomWidth: 0.5, borderBottomColor: surfaceEdge() }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: "600", color: colors.text }}>{L("Keyboard shortcuts", "键盘快捷键")}</Text>
          <IconButton icon="close" label={L("Close", "关闭")} shortcut="Esc" onPress={props.onClose} />
        </View>
        <View style={{ paddingVertical: 8 }}>
          <Each of={SHORTCUTS()}>
            {(s) => (
              <View style={{ flexDirection: "row", alignItems: "center", minHeight: 38, paddingHorizontal: 20, gap: 12 }}>
                <Text style={{ flex: 1, fontSize: 15, color: colors.text }}>{s()[1]}</Text>
                <View style={{ flexDirection: "row", gap: 4 }}>
                  <Each of={s()[0].split("  ·  ")}>{(k) => <Kbd keys={k()} />}</Each>
                </View>
              </View>
            )}
          </Each>
        </View>
        <Text style={{ fontSize: 13, color: colors.faint, paddingHorizontal: 20, paddingBottom: 16 }}>{L("Single-key shortcuts work outside the message box; while typing, use the Alt (⌥) combinations.", "单键快捷键在输入框外生效；打字时用带 Alt（⌥）的组合键。")}</Text>
      </View>
    </Dialog>
  );
}
