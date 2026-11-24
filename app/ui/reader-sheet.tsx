import { createMotion, effect, keymap, Overlay, signal, untracked, View, type JSX } from "nsh";
import { ResizablePanel, ResizablePanelGroup } from "nsh/base";
import { colors } from "./theme";

/**
 * A report overlays the conversation without resizing or remounting its chat.
 * It is not modal: it covers the chat column only (from `insetLeft`), so the
 * sidebar beside it stays live and picking a channel there works while it is
 * open. A press on the scrim over the chat, Escape or the close button closes it.
 */
export function ReaderSheet(props: {
  open: boolean;
  availableWidth: number;
  insetLeft: number;
  width: number;
  expanded: boolean;
  onResize: (width: number) => void;
  onClose: () => void;
  children: JSX.Element;
}) {
  const resize = (delta: number) => {
    if (props.open && !props.expanded) props.onResize(Math.max(Math.min(360, props.availableWidth), Math.min(props.availableWidth, props.width + delta)));
  };
  keymap.bind("mod+alt+left", () => resize(40), { when: "always" });
  keymap.bind("mod+alt+right", () => resize(-40), { when: "always" });

  // Stays shown while it slides out, then goes.
  const shown = signal(untracked(() => props.open));
  const scrim = createMotion({ initial: { opacity: 0 } });
  const panel = createMotion({ initial: { opacity: 0 } });
  const panelWidth = () => (props.expanded ? props.availableWidth : props.width);
  effect(() => {
    const open = props.open;
    untracked(() => {
      const away = Math.min(panelWidth(), 480);
      if (open) {
        shown.set(true);
        void scrim.play({ keyframes: { opacity: [0, 1] }, duration: 200, easing: "easeOut" });
        void panel.play({ keyframes: { opacity: [0, 1], translateX: [away, 0] }, duration: 240, easing: "easeOut" });
      } else if (shown()) {
        void scrim.play({ keyframes: { opacity: [1, 0] }, duration: 180, easing: "easeIn" });
        void panel.play({ keyframes: { opacity: [1, 0], translateX: [0, away] }, duration: 180, easing: "easeIn" }).then(() => {
          if (!props.open) shown.set(false);
        });
      }
    });
  });

  return (
    <If when={shown()}>
      <Overlay style={{ top: 0, bottom: 0, left: props.insetLeft, right: 0, pointerEvents: props.open ? "auto" : "none" }}
        onCancel={() => { if (props.open) props.onClose(); }}>
        <View class="bg-scrim" style={[scrim.style, { position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }]} />
        <View style={[panel.style, { flex: 1 }]}>
          <ResizablePanelGroup
            handleClass="bg-border group-hover:bg-primary group-active:bg-primary"
            handleAccessibilityLabel="Resize report reader"
            onResize={({ sizes }) => { if (!props.expanded && sizes.length === 2) props.onResize(sizes[1]); }}>
            <ResizablePanel size={props.availableWidth - props.width} minSize={0} visible={!props.expanded}>
              <View accessibilityLabel="Close reader" role="button" onPress={props.onClose} style={{ flex: 1 }} />
            </ResizablePanel>
            <ResizablePanel size={panelWidth()} minSize={Math.min(360, props.availableWidth)}
              maxSize={props.availableWidth}>
              <View testID="doc-side" style={{ flex: 1, minWidth: 0, backgroundColor: colors.background }}>
                {props.children}
              </View>
            </ResizablePanel>
          </ResizablePanelGroup>
        </View>
      </Overlay>
    </If>
  );
}
