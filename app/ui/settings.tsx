/** Settings: a titled group of items, each item a row that answers the pointer. */
import type { JSX, ViewStyle } from "nsh";
import { Text, View } from "nsh";
import { alpha, colors } from "./theme";
import { corner, duration, fill } from "./tokens";

/** A titled group of settings items on one card. */
export function SettingsGroup(props: { title: string; hint?: string; children: JSX.Element }) {
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 3, paddingHorizontal: 2 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{props.title}</Text>
        {props.hint ? <Text style={{ fontSize: 13.5, lineHeight: 20, color: colors.muted }}>{props.hint}</Text> : null}
      </View>
      <View style={{ borderRadius: corner.field + 2, borderCurve: "continuous", borderWidth: 1, borderColor: colors.line, overflow: "hidden" }}>{props.children}</View>
    </View>
  );
}

/** One item of a `SettingsGroup`: a hairline above all but the `first`, and a ghost hover fill under the pointer. */
export function SettingsItem(props: { first?: boolean; testID?: string; style?: ViewStyle; onPress?: () => void; children: JSX.Element }) {
  return (
    <View
      testID={props.testID}
      onPress={props.onPress}
      role={props.onPress ? "button" : undefined}
      hoverStyle={{ backgroundColor: alpha(colors.text, fill.ghostHover / 2) }}
      style={{
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: props.first ? 0 : 1,
        borderTopColor: colors.line,
        transitionProperty: "background-color",
        transitionDuration: duration.quick,
        ...props.style,
      }}
    >
      {props.children}
    </View>
  );
}
