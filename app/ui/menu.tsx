/**
 * Menus: the popup surface, a row and a separator, shared by every `Menu`, `ContextMenu` and `Submenu` in the app.
 * App code passes `menuPopup()` as `popupStyle` and fills it with `MenuRow` / `MenuSep`; it does not restyle them.
 */
import type { JSX, ViewStyle } from "nsh";
import { Text } from "nsh";
import { MenuItem, MenuSeparator } from "nsh/base";
import { Icon, type IconName } from "./icons";
import { alpha, colors } from "./theme";
import { corner, duration, fill, font, leading, space, touch } from "./tokens";

/** The popup of a menu: the surface, one hairline, a soft shadow. */
export const menuPopup = (): ViewStyle => ({
  minWidth: 160,
  padding: space.xs,
  borderRadius: corner.field,
  borderCurve: "continuous",
  borderWidth: 1,
  borderColor: colors.line,
  backgroundColor: colors.surface,
  boxShadow: "0 10px 30px rgba(0,0,0,0.16), 0 2px 6px rgba(0,0,0,0.06)",
});

/** A row's hover and press: the ghost control's fills. */
export const menuRowHover = (): ViewStyle => ({ backgroundColor: alpha(colors.text, fill.ghostHover) });
const menuRowPress = (): ViewStyle => ({ backgroundColor: alpha(colors.text, fill.ghostPress) });

/** A menu row: an optional icon and a label (`danger` for a destructive one), or `children` for a custom row. */
export function MenuRow(props: {
  label?: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  testID?: string;
  children?: JSX.Element;
}) {
  const fg = () => (props.danger ? colors.danger : colors.text);
  return (
    <MenuItem
      testID={props.testID}
      disabled={props.disabled}
      onSelect={props.onSelect}
      hoverStyle={menuRowHover()}
      activeStyle={menuRowPress()}
      disabledStyle={{ opacity: 0.45 }}
      style={{
        minHeight: touch ? 44 : 30,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingHorizontal: space.md,
        borderRadius: corner.control - 2,
        borderCurve: "continuous",
        transitionProperty: "background-color",
        transitionDuration: duration.quick,
      }}
    >
      {props.icon ? <Icon name={props.icon} size={15} tint={props.danger ? colors.danger : colors.muted} /> : null}
      {props.label ? <Text style={{ flex: 1, minWidth: 0, numberOfLines: 1, fontSize: font.sm + 1, lineHeight: leading.sm, color: fg() }}>{props.label}</Text> : null}
      {props.children}
    </MenuItem>
  );
}

/** The line between groups of a menu. */
export function MenuSep() {
  return <MenuSeparator style={{ height: 1, marginVertical: space.xs, marginHorizontal: space.md, backgroundColor: alpha(colors.text, 0.14) }} />;
}
