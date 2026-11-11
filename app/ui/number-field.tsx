// Not in the `./ui` barrel: `nsh/base`'s `NumberInput` (and on the web its part of the runtime) loads only with the
// interface that imports this file directly (the settings pages, a lazy chunk).
import type { ViewStyle } from "nsh";
import { View } from "nsh";
import { NumberInput as BaseNumberInput } from "nsh/base";
import { Icon } from "./icons";
import { alpha, colors, focusRing } from "./theme";
import { corner, duration, font, size, touch } from "./tokens";

/** A disabled control's strength, as `controls.tsx`'s. */
const DISABLED = 0.45;

/**
 * A number typed or stepped (`nsh/base`'s `NumberInput`) in the field's frame: the value in the middle, a minus and a
 * plus at the ends, each set off by a hairline and taking the ghost fills, as gpui-component's `NumberInput`.
 */
export function NumberField(props: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const h = size.field;
  const stepStyle = (left: boolean): ViewStyle => ({
    width: touch ? 44 : 30, alignItems: "center", justifyContent: "center",
    [left ? "borderRightWidth" : "borderLeftWidth"]: 1, borderColor: colors.line,
    transitionProperty: "background-color", transitionDuration: duration.quick,
  });
  const steps = "hover:bg-foreground/8 active:bg-foreground/14 disabled:opacity-35";
  return (
    <BaseNumberInput
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step}
      disabled={props.disabled}
      onChange={({ value }) => value != null && props.onChange(value)}
      hoverStyle={{ borderColor: alpha(colors.text, 0.28) }}
      focusStyle={focusRing()}
      style={{
        flexDirection: "row", alignItems: "stretch", height: h, overflow: "hidden",
        borderRadius: corner.field, borderCurve: "continuous", borderWidth: 1, borderColor: colors.fieldBorder,
        backgroundColor: colors.field, boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        opacity: props.disabled ? DISABLED : 1,
        transitionProperty: "border-color", transitionDuration: duration.quick,
      }}
      inputStyle={{ width: 44, textAlign: "center", fontSize: font.md, color: colors.text, fontVariant: ["tabular-nums"] }}
      decrementButtonClass={steps}
      incrementButtonClass={steps}
      decrementButtonStyle={stepStyle(true)}
      incrementButtonStyle={stepStyle(false)}
      decrementButton={<View testID={props.testID && `${props.testID}-dec`}><Icon name="minus" size={14} tint={colors.muted} /></View>}
      incrementButton={<View testID={props.testID && `${props.testID}-inc`}><Icon name="plus" size={14} tint={colors.muted} /></View>}
    />
  );
}
