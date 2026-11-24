import { createMotion, effect, keymap, Overlay, signal, untracked, View, type JSX } from "nsh";
import { ResizablePanel, ResizablePanelGroup } from "nsh/base";
import { colors, motion } from "./theme";

/**
 * A report overlays the conversation without resizing or remounting its chat.
 *
 * It is not modal: it covers only the chat region (`insetLeft` on), so the
 * navigation sidebar beside it stays usable while a report is open. A press
 * on the scrim over the chat or Escape closes it; it slides in from the right
 * edge as the scrim fades in, and back out as it closes.
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

  // Stays made while it slides out, after `open` turns false.
  const shown = signal(false);
  const scrim = createMotion({ initial: { opacity: 0 } });
  const panel = createMotion();
  const distance = () => (props.expanded ? props.availableWidth : props.width);
  effect(() => {
    const open = props.open;
    untracked(() => {
      const from = distance();
      if (open) {
        shown.set(true);
        void scrim.play({ ...motion.enter, keyframes: { opacity: [0, 1] } });
        void panel.play({ ...motion.enter, keyframes: { translateX: [from, 0] } });
      } else if (shown()) {
        const exit = { duration: 200, easing: motion.enter.easing };
        void scrim.play({ ...exit, keyframes: { opacity: [1, 0] } });
        void panel.play({ ...exit, keyframes: { translateX: [0, from] } }).then(() => {
          if (!props.open) shown.set(false);
        });
      }
    });
  });

  return (
    <If when={shown()}>
      <Overlay onCancel={() => { if (props.open) props.onClose(); }}
        style={{ top: 0, bottom: 0, right: 0, left: props.insetLeft, overflow: "hidden", pointerEvents: props.open ? "auto" : "none" }}>
        <View class="bg-scrim" style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, ...scrim.style }} />
        <View style={{ flex: 1, ...panel.style }}>
          <ResizablePanelGroup
            handleClass="bg-border group-hover:bg-primary group-active:bg-primary"
            handleAccessibilityLabel="Resize report reader"
            onResize={({ sizes }) => { if (!props.expanded && sizes.length === 2) props.onResize(sizes[1]); }}>
            <ResizablePanel size={props.availableWidth - props.width} minSize={0} visible={!props.expanded}>
              <View accessibilityLabel="Close reader" role="button" onPress={props.onClose} style={{ flex: 1 }} />
            </ResizablePanel>
            <ResizablePanel size={props.expanded ? props.availableWidth : props.width} minSize={Math.min(360, props.availableWidth)}
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
