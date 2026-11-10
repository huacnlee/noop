// The report reader: a lazy chunk, loaded with the first report the chat shows (lazy.tsx).
import { computed, Scroll, signal, Text, untracked, View } from "nsh";
import { L } from "./i18n";
import { alpha, colors, hovered, Icon, type IconName } from "./ui";
import { Btn } from "./kit";
import { Rich } from "./markdown";
import { docBody, type DocRef, retryDoc } from "./docs";

const DOC_SCALES = [0.875, 1, 1.125, 1.25, 1.4];
/** The reader beside the chat (a full sheet on a phone): the open report rendered with TextView, with text zoom and a wider pane. */
export function DocPane(props: { doc: DocRef; wide: boolean; expanded: boolean; onExpand: () => void; onClose: () => void }) {
  const step = signal(1);
  // looked up once per report, so a re-render never fetches again by itself
  const cell = computed(() => { const src = props.doc.src; return untracked(() => docBody(src)); });
  const body = () => cell()();
  const btn = (p: { id: string; icon: IconName; label: string; on?: boolean; disabled?: boolean; onPress: () => void }) => (
    <View testID={p.id} role="button" accessibilityLabel={p.label} accessibilityState={{ disabled: !!p.disabled }}
      onPress={p.disabled ? undefined : p.onPress} hoverStyle={p.disabled ? undefined : hovered()}
      style={{ width: props.wide ? 28 : 36, height: props.wide ? 28 : 36, borderRadius: 6, alignItems: "center", justifyContent: "center", cursor: p.disabled ? "default" : "pointer", opacity: p.disabled ? 0.35 : 1, backgroundColor: p.on ? alpha(colors.text, 0.07) : undefined }}>
      <Icon name={p.icon} size={15} tint={colors.muted} />
    </View>
  );
  return (
    <View testID="doc-reader" style={{ flex: 1, minWidth: 0, backgroundColor: colors.background }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2, height: props.wide ? 44 : 52, paddingLeft: 14, paddingRight: 8, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
        <Icon name="document" size={16} tint={colors.muted} />
        <Text testID="doc-title" style={{ flex: 1, minWidth: 0, marginLeft: 8, marginRight: 6, fontSize: 13.5, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{props.doc.name}</Text>
        {btn({ id: "doc-zoom-out", icon: "zoom-out", label: L("Smaller text", "缩小文字"), disabled: step() === 0, onPress: () => step.set(Math.max(0, step() - 1)) })}
        <Text testID="doc-scale" style={{ width: 36, textAlign: "center", fontSize: 11.5, fontVariant: ["tabular-nums"], color: colors.faint }}>{`${Math.round(DOC_SCALES[step()] * 100)}%`}</Text>
        {btn({ id: "doc-zoom-in", icon: "zoom-in", label: L("Larger text", "放大文字"), disabled: step() === DOC_SCALES.length - 1, onPress: () => step.set(Math.min(DOC_SCALES.length - 1, step() + 1)) })}
        <If when={props.wide}>
          {btn({ id: "doc-expand", icon: props.expanded ? "minimize" : "maximize", label: props.expanded ? L("Narrow reader", "收窄阅读栏") : L("Widen reader", "加宽阅读栏"), on: props.expanded, onPress: props.onExpand })}
        </If>
        {btn({ id: "doc-close", icon: "close", label: L("Close reader", "关闭阅读栏"), onPress: props.onClose })}
      </View>
      <Scroll style={{ flex: 1 }}>
        <View selectable style={{ width: "100%", maxWidth: 760, alignSelf: "center", gap: 12, paddingHorizontal: props.wide ? 28 : 20, paddingTop: 28, paddingBottom: 48 }}>
          <If when={body().text !== null} else={
            <View style={{ gap: 10, alignItems: "flex-start" }}>
              <Text testID="doc-status" style={{ fontSize: 14, color: body().error ? colors.danger : colors.faint }}>{body().error || L("Loading…", "读取中…")}</Text>
              <If when={body().error}>
                <Btn label={L("Retry", "重试")} onPress={() => retryDoc(props.doc.src, cell())} testID="doc-retry" />
              </If>
            </View>
          }>
            <Rich text={body().text ?? ""} scale={DOC_SCALES[step()]} />
          </If>
        </View>
      </Scroll>
    </View>
  );
}
