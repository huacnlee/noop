// The report reader: a lazy chunk, loaded with the first report the chat shows (lazy.tsx).
import { computed, Scroll, signal, Text, untracked, View } from "nsh";
import { L } from "./i18n";
import { isAvailable as hasWindow, titleBar } from "nsh/desktop";
import { Button, colors, Icon, IconButton, type IconName, size } from "./ui";
import { surfaceEdge } from "./kit";
import { Rich } from "./markdown";
import { docBody, type DocRef, retryDoc } from "./docs";

const DOC_SCALES = [0.875, 1, 1.125, 1.25, 1.4];
/**
 * The reader beside the chat (a full sheet on a phone): the open report rendered with TextView, with text zoom and a
 * wider pane. Beside the chat (`wide`) it runs to the window's top edge: its header is part of the window's
 * title bar (drags the window, and leaves room for the window buttons Linux and Windows draw at the right).
 */
export function DocPane(props: { doc: DocRef; wide: boolean; expanded: boolean; onExpand: () => void; onClose: () => void }) {
  const step = signal(1);
  // looked up once per report, so a re-render never fetches again by itself
  const cell = computed(() => { const src = props.doc.src; return untracked(() => docBody(src)); });
  const body = () => cell()();
  const btn = (p: { id: string; icon: IconName; label: string; on?: boolean; disabled?: boolean; onPress: () => void }) => (
    <IconButton testID={p.id} icon={p.icon} label={p.label} size="sm" selected={p.on} disabled={p.disabled} onPress={p.onPress} />
  );
  return (
    <View testID="doc-reader" style={{ flex: 1, minWidth: 0, backgroundColor: colors.background }}>
      <View
        desktop={props.wide ? { windowDrag: true } : undefined}
        style={{ flexDirection: "row", alignItems: "center", gap: 2, height: size.bar, paddingLeft: 14, paddingRight: (props.wide && hasWindow ? titleBar().right : 0) + 8, borderBottomWidth: 0.5, borderColor: surfaceEdge(), backgroundColor: colors.background }}
      >
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
                <Button label={L("Retry", "重试")} onPress={() => retryDoc(props.doc.src, cell())} testID="doc-retry" />
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
