import { keyboardFrame, platform, safeArea, signal, Text, View } from "nsh";
import { Button, Popover, Sheet } from "nsh/base";
import { L } from "./i18n";
import { lazyComponent, lazyModule } from "./lazy";
import { colors, hovered, Icon, Tip } from "./ui";
import { popupSurface } from "./ui/popup";

// The picker is a chunk of its own (emoji-picker.tsx): on the web it and EmojiPicker's part of the runtime download
// when it first opens. Package updates can reach shells predating EmojiPicker: the chunk tells, and native bundles
// inline it, so a native shell knows at once whether to show the button. A web page runs the runtime packaged with
// this code, which has it.
const panel = lazyModule(() => import("./emoji-picker"));
const native = platform.os !== "web";
if (native) void panel.load().catch(() => {});
/** Whether the composer shows the emoji button. */
export const hasEmojiPicker = (): boolean => (native ? panel.loaded()?.hasEmojiPicker === true : panel.loaded()?.hasEmojiPicker !== false);

const Panel = lazyComponent(panel, (m) => m.EmojiPanel, (state) => (
  <Text testID="emoji-loading" class="p-6 text-center text-sm text-muted-foreground">
    {state.failed ? L("Couldn’t load emoji. Close and try again.", "表情加载失败，关闭后再试一次。") : L("Loading emoji…", "正在加载表情…")}
  </Text>
));

export function ComposerEmoji(props: {
  touch: boolean;
  onOpen: () => void;
  onSelect: (emoji: string) => void;
  onInserted: () => void;
}) {
  const open = signal(false);
  const recent = signal<string[]>([]);
  let inserted = false;
  const change = (next: boolean) => {
    if (next) { inserted = false; props.onOpen(); }
    open.set(next);
  };
  const closed = () => {
    if (inserted) { inserted = false; props.onInserted(); }
  };
  const trigger = () => (
    <Button
      testID="emoji"
      accessibilityLabel={L("Choose emoji", "选择表情")}
      tooltip={props.touch ? undefined : <Tip label={L("Choose emoji", "选择表情")} />}
      onPress={props.touch ? () => change(true) : undefined}
      hoverStyle={hovered()}
      style={{ width: props.touch ? 44 : 36, height: props.touch ? 44 : 36, borderRadius: props.touch ? 22 : 18, alignItems: "center", justifyContent: "center" }}
    >
      <Icon name="smile" size={props.touch ? 22 : 19} tint={colors.text} />
    </Button>
  );
  const picker = () => (
    <Panel
      touch={props.touch}
      recent={recent()}
      onSelect={({ emoji, base }) => {
        recent.update((items) => [base, ...items.filter((item) => item !== base)].slice(0, 24));
        props.onSelect(emoji);
        inserted = true;
        change(false);
      }}
      onCancel={() => change(false)}
    />
  );
  return (
    <If when={hasEmojiPicker()}>
    {props.touch ? (
    <View>
      {trigger()}
      <Sheet open={open()} onOpenChange={({ open }) => change(open)} onClose={closed} closeOnSwipe
        popupClass="rounded-t-2xl bg-popover"
        popupStyle={{ paddingBottom: safeArea().bottom, marginBottom: keyboardFrame().height }}
        backdropClass="bg-foreground/20">
        <View class="flex-row items-center justify-between px-4 pt-2">
          <Text class="text-base font-semibold text-popover-foreground">{L("Emoji", "表情")}</Text>
          <Button testID="emoji-close" onPress={() => change(false)} accessibilityLabel={L("Close emoji", "关闭表情")} class="size-11 items-center justify-center rounded-full active:bg-accent">
            <Icon name="close" size={18} tint={colors.text} />
          </Button>
        </View>
        {picker()}
      </Sheet>
    </View>
  ) : (
    <Popover open={open()} onOpenChange={({ open }) => change(open)} onClose={closed}
      placement="top" align="start" offset={8} margin={12} popupStyle={popupSurface()} trigger={trigger()}>
      {picker()}
    </Popover>
  )}
    </If>
  );
}
