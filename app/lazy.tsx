// Interfaces the owner opens now and then (settings, the report reader, a message's images at full size, the keyboard
// help, a confirmation) live in modules of their own, loaded the first time one shows. On the web each is a chunk the
// page downloads then, with the side modules of the runtime it needs (NumberInput's, Carousel's), so the first load
// fetches only the chat. Native bundles inline every module: `import()` resolves at once, which is why a shell that
// updates its code over the air needs nothing new for this.
import { computed, effect, keymap, Overlay, signal, Text, untracked, View } from "nsh";
import type { JSX } from "nsh";
import { L } from "./i18n";
import { colors, hovered, radius } from "./ui";

/** A module loaded the first time `load` is called; a failed load is tried again by the next call. */
export type LazyModule<M> = {
  /** The module once loaded, else null. */
  loaded: () => M | null;
  /** Why the last load failed ("" while loading or loaded). */
  failed: () => string;
  load: () => Promise<M>;
};

export function lazyModule<M>(importer: () => Promise<M>): LazyModule<M> {
  // the namespace object is kept in a box: a signal compares by identity and never calls it
  const loaded = signal<{ module: M } | null>(null);
  const failed = signal("");
  let pending: Promise<M> | undefined;
  const load = () => {
    if (pending) return pending;
    failed.set(""); // a new attempt: what the last one said no longer holds
    return (pending = importer().then(
      (module) => {
        failed.set("");
        loaded.set({ module });
        return module;
      },
      (err: unknown) => {
        pending = undefined;
        failed.set(err instanceof Error ? err.message : String(err));
        throw err;
      },
    ));
  };
  return { loaded: () => loaded()?.module ?? null, failed, load };
}

/** What a lazy component's placeholder is given: why the last load failed ("" while loading) and how to try again.
 * Its fields are live (getters), so read them where they are shown, never in the placeholder's body. */
export type LazyState<P> = { failed: string; retry: () => void; props: P };

/**
 * A component of a lazy module: `Placeholder` shows until the module is there (and says why when it failed; showing
 * the component again tries again), then the component, with the props passed on as they are (getters stay live).
 */
export function lazyComponent<M, P extends object>(
  module: LazyModule<M>,
  pick: (module: M) => (props: P) => JSX.Element,
  Placeholder: (state: LazyState<P>) => JSX.Element = () => null,
): (props: P) => JSX.Element {
  const retry = () => void module.load().catch(() => {});
  return function Lazy(props: P) {
    retry();
    return (
      <If when={module.loaded()} else={<Placeholder failed={module.failed()} retry={retry} props={props} />}>
        {(m) => {
          const Component = pick(m());
          return <Component {...props} />;
        }}
      </If>
    );
  };
}

/**
 * An overlay of a lazy module (an image at full size, the shortcuts): mounted on its first opening and kept (`latch`)
 * so it animates closed. Until the module is there, an opening shows a small card over the window instead: loading,
 * or the reason it could not, with Retry and Close. Every opening while the module is missing loads it again, so
 * closing a failed one and opening it again tries again. The card is drawn with an `Overlay`, so the entry needs no
 * `Dialog` before the module brings its own.
 */
export function lazyOverlay<M, P extends { open: boolean; onClose: () => void }>(
  module: LazyModule<M>,
  pick: (module: M) => (props: P) => JSX.Element,
  failedText: () => string,
): (props: P) => JSX.Element {
  const retry = () => void module.load().catch(() => {});
  return function LazyOverlay(props: P) {
    effect(() => {
      if (props.open && !untracked(module.loaded)) untracked(retry);
    });
    return (
      <If
        when={module.loaded()}
        else={
          <If when={props.open}>
            <OverlayLoading failed={module.failed()} failedText={failedText()} retry={retry} onClose={props.onClose} />
          </If>
        }
      >
        {(m) => {
          const Component = pick(m());
          return <Component {...props} />;
        }}
      </If>
    );
  };
}

function TextButton(props: { id: string; label: string; onPress: () => void }) {
  return (
    <View testID={props.id} role="button" accessibilityLabel={props.label} onPress={props.onPress} hoverStyle={hovered()}
      style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.control, cursor: "pointer" }}>
      <Text style={{ fontSize: 14, color: colors.accent }}>{props.label}</Text>
    </View>
  );
}

/** The card an opening lazy overlay shows until its module is there. Escape closes it, as it does the overlay's
 * `Dialog` (the latest binding wins, and it goes with the card). */
function OverlayLoading(props: { failed: string; failedText: string; retry: () => void; onClose: () => void }) {
  keymap.bind("escape", () => props.onClose(), { when: "always" });
  return (
    <Overlay style={{ top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: 16, pointerEvents: "box-none" }}>
      <View testID="lazy-overlay"
        style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 420, paddingLeft: 16, paddingRight: 6, paddingVertical: 6, borderRadius: radius.inset, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.raised }}>
        <Text testID="lazy-status" style={{ flexShrink: 1, marginRight: 6, fontSize: 14, color: props.failed ? colors.danger : colors.faint }}>
          {props.failed ? props.failedText : L("Loading…", "读取中…")}
        </Text>
        <If when={props.failed}>
          <TextButton id="lazy-retry" label={L("Retry", "重试")} onPress={props.retry} />
        </If>
        <TextButton id="lazy-close" label={L("Close", "关闭")} onPress={props.onClose} />
      </View>
    </Overlay>
  );
}

/** True from the first time `cond` is: what mounts a lazy overlay on its first opening and keeps it for the next ones
 * (so it still animates closed). */
export function latch(cond: () => unknown): () => boolean {
  let on = false;
  const value = computed(() => (on ||= !!cond()));
  return () => value();
}

/** The placeholder of a lazy page: quiet while it loads, the reason and a retry (and a way out, given `onClose`) when it
 * could not. */
export function PageLoading(props: { failed: string; retry: () => void; onClose?: () => void }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
      <Text testID="lazy-status" style={{ fontSize: 14, textAlign: "center", color: props.failed ? colors.danger : colors.faint }}>
        {props.failed ? L("Couldn’t load this page", "这个页面加载失败") : L("Loading…", "读取中…")}
      </Text>
      <If when={props.failed}>
        <View style={{ flexDirection: "row", gap: 4 }}>
          <TextButton id="lazy-retry" label={L("Retry", "重试")} onPress={props.retry} />
          <If when={props.onClose}>
            <TextButton id="lazy-close" label={L("Close", "关闭")} onPress={() => props.onClose?.()} />
          </If>
        </View>
      </If>
    </View>
  );
}
