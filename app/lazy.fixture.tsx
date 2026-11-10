// A test entry (lazy.test.tsx): lazy interfaces whose chunk is fetched first, so a test decides when the download fails.
import { mount, signal, Text, View } from "nsh";
import { latch, lazyComponent, lazyModule, lazyOverlay, PageLoading } from "./lazy";

const CHUNK = "http://chunk.test";
const fetched = async (name: string) => {
  const res = await fetch(`${CHUNK}/${name}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
};

const HelpSheet = lazyOverlay(
  lazyModule(async () => { await fetched("help-sheet.js"); return import("./help-sheet"); }),
  (m) => m.HelpSheet,
  () => "Couldn’t open the keyboard shortcuts",
);
const Page = lazyComponent(
  lazyModule(async () => {
    await fetched("page.js");
    return { Page: (props: { label: string; onClose: () => void }) => <Text testID="page-label">{props.label}</Text> };
  }),
  (m) => m.Page,
  (s) => <PageLoading failed={s.failed} retry={s.retry} onClose={s.props.onClose} />,
);

function Fixture() {
  const help = signal(false);
  const helpOpened = latch(help);
  const paged = signal(false);
  const label = signal("first");
  const button = (id: string, onPress: () => void) => (
    <View testID={id} role="button" accessibilityLabel={id} onPress={onPress} style={{ padding: 8 }}>
      <Text>{id}</Text>
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      {button("open-help", () => help.set(true))}
      {button("open-page", () => paged.set(true))}
      {button("relabel", () => label.set("second"))}
      <If when={paged()}>
        <Page label={label()} onClose={() => paged.set(false)} />
      </If>
      <If when={helpOpened()}>
        <HelpSheet open={help()} onClose={() => help.set(false)} />
      </If>
    </View>
  );
}

mount(Fixture);
