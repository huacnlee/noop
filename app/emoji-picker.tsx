// The composer's emoji picker: a lazy chunk (composer-emoji.tsx), loaded on the web the first time the picker opens,
// with EmojiPicker's part of the runtime; its emoji (nsh-emoji.bin) come with the first picker shown.
import { keyboardFrame, safeArea, Text, windowSize } from "nsh";
// EmojiPicker through the namespace: package updates can reach shells predating it, where a missing named import
// would fail to link. The bundler counts a member read by name as an import of that name only.
import * as base from "nsh/base";
import { L } from "./i18n";

const EmojiPicker = base.EmojiPicker;
/** This shell has the picker (a shell predating it gets no emoji button). */
export const hasEmojiPicker = typeof EmojiPicker === "function";

export function EmojiPanel(props: {
  touch: boolean;
  recent: string[];
  onSelect: (pick: { emoji: string; base: string }) => void;
  onCancel: () => void;
}) {
  if (!hasEmojiPicker) return null;
  return (
    <EmojiPicker
      testID="emoji-picker"
      accessibilityLabel={L("Emoji", "表情")}
      searchAccessibilityLabel={L("Search emoji", "搜索表情")}
      placeholder={L("Search emoji", "搜索表情（英文名称）")}
      autoFocus={!props.touch}
      columns={props.touch ? Math.max(1, Math.min(7, Math.floor((windowSize().width - 16) / 44))) : 8}
      recent={props.recent}
      groupLabels={{ recent: L("Recent", "最近使用"), smileysEmotion: L("Smileys & emotion", "笑脸与情感"), peopleBody: L("People & body", "人物与身体"), animalsNature: L("Animals & nature", "动物与自然"), foodDrink: L("Food & drink", "食物与饮料"), travelPlaces: L("Travel & places", "旅行与地点"), activities: L("Activities", "活动"), objects: L("Objects", "物品"), symbols: L("Symbols", "符号"), flags: L("Flags", "旗帜") }}
      onSelect={({ emoji, base }) => props.onSelect({ emoji, base })}
      onCancel={props.onCancel}
      style={{ width: props.touch ? "100%" : Math.min(336, windowSize().width - 32), height: Math.max(120, Math.min(380, windowSize().height - keyboardFrame().height - safeArea().top - safeArea().bottom - 96)) }}
      searchBarClass="mx-2 mt-2 h-11 flex-row items-center rounded-lg bg-muted px-3"
      searchClass="flex-1 text-base text-foreground placeholder:text-muted-foreground"
      rowClass="px-2"
      groupClass="px-3 pt-3 pb-1 text-xs font-semibold text-muted-foreground"
      itemClass="flex-1 h-11 items-center justify-center rounded-md text-2xl hover:bg-accent focus:bg-accent active:bg-accent"
      empty={<Text class="p-6 text-center text-sm text-muted-foreground">{L("No emoji found", "没有找到表情")}</Text>}
      loading={<Text class="p-6 text-center text-sm text-muted-foreground">{L("Loading emoji…", "正在加载表情…")}</Text>}
    />
  );
}
