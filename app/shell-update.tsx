import { Text, View } from "nsh";
import { L } from "./i18n";
import { Button, colors } from "./ui";
import { font, leading, space } from "./ui/tokens";
import type { UpdateState } from "./update";

/** The optional native update lives with the installed shell's version, never in a dialog. */
export function ShellUpdate(props: { state: UpdateState; onUpdate: () => void }) {
  const update = () => props.state.kind === "shell" ? props.state : null;
  const busy = () => update()?.phase === "downloading" || update()?.phase === "installing";
  const label = () => {
    const u = update();
    if (!u) return "";
    if (u.phase === "installing") return L("Restarting…", "正在重启…");
    if (u.phase === "downloading") return u.progress == null ? L("Downloading shell…", "正在下载外壳…")
      : L(`Downloading shell… ${Math.round(u.progress)}%`, `正在下载外壳… ${Math.round(u.progress)}%`);
    if (u.phase === "failed") return L("Retry shell update", "重试外壳更新");
    return L(`Update shell to ${u.version}`, `更新外壳至 ${u.version}`);
  };
  return <If when={update()}>
    <View testID="shell-update" style={{ gap: space.xs, paddingTop: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <If when={!busy()}><View testID="shell-update-dot" style={{ width: space.sm, height: space.sm, borderRadius: space.sm / 2, backgroundColor: colors.info }} /></If>
        <Button label={label()} accessibilityLabel={label()} size="md" variant="ghost" loading={busy()} disabled={busy()} onPress={props.onUpdate} testID="shell-update-action" />
      </View>
      <If when={update()?.message}>
        <Text testID="shell-update-error" style={{ fontSize: font.xs, lineHeight: leading.xs, color: colors.danger }}>{update()?.message}</Text>
      </If>
    </View>
  </If>;
}
