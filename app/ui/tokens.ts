/**
 * Noop's design tokens: the one place for sizes, the corner-radius ladder, spacing, type and the floating glass.
 * Colors live in `theme.ts` (from `theme.json`); components in `controls.tsx` read only these.
 */
import type { ViewStyle } from "nsh";
import { platform } from "nsh";
import { alpha, colors } from "./theme";

/** A touch screen: 44-point targets. */
export const touch = !(platform.idiom === "desktop" || platform.idiom === "mac");

/**
 * Sizes: the gallery's compact desktop proportions. A field is a hair taller than a `md` button so a row of both
 * still reads as one line; `sm` is the compact tier of toolbars and cards.
 */
export const size = {
  text: 17,
  line: 26,
  small: 15,
  tiny: 13,
  field: touch ? 44 : 32,
  control: touch ? 44 : 30,
  controlSm: touch ? 36 : 24,
  icon: touch ? 44 : 28,
  iconSm: touch ? 36 : 24,
  row: touch ? 44 : 34,
  bar: touch ? 56 : 52,
  sidebar: 288,
  column: 880,
};

/**
 * The corner-radius ladder, largest first: the composer, then fields, then buttons and rows, then icon buttons, then
 * badges and keys. Restrained on purpose: a small button never gets a pill.
 */
export const corner = {
  composer: 24,
  field: 10,
  control: 8,
  item: 8,
  icon: 6,
  badge: 5,
  key: 4,
} as const;

/** Spacing steps (points). */
export const space = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24 } as const;

/** Type steps (points), each with its line height: a label never sets its own. */
export const font = { key: 12, badge: 12, sm: 13, md: 15, lg: 17 } as const;
export const leading = { key: 16, badge: 16, sm: 18, md: 20, lg: 24 } as const;

/**
 * The quiet fills of controls, as the text color's opacity over whatever surface they sit on: the same steps in light
 * and dark. `rest` is a secondary control's own fill, `hover` and `press` its states; a ghost control starts clear and
 * takes `hover` / `press`, and the selected or checked one keeps `selected`.
 */
export const fill = { rest: 0.07, hover: 0.12, press: 0.16, ghostHover: 0.1, ghostPress: 0.15, selected: 0.12 } as const;

/** Durations shared by hover / state transitions (milliseconds). */
export const duration = { quick: 120, settle: 180, enter: 420 } as const;

/**
 * Press feedback, kept small: a control gives a little under the finger and settles back (`duration.settle`). Rows
 * barely move; icon buttons, being small, a touch more.
 */
export const press = { control: 0.97, icon: 0.9, row: 0.985 } as const;

/**
 * A floating surface, for the composer and the sidebar: Apple's Liquid Glass where it is drawn (iOS 26, macOS 26), a
 * blur elsewhere. Linux and Android before 12 draw no backdrop, so they stay opaque there, or what is behind would show
 * through the text on it.
 */
export const glass = (tint: string, cornerRadius: number): ViewStyle => ({
  borderRadius: cornerRadius,
  borderCurve: "continuous",
  borderWidth: 1,
  borderColor: alpha(colors.text, 0.1),
  boxShadow: "0 8px 28px rgba(0,0,0,0.1)",
  ...(platform.os === "linux" || (platform.os === "android" && Number(platform.version) < 31)
    ? { backgroundColor: tint }
    : { backgroundColor: alpha(tint, 0.55), glassEffect: "regular" as const, backdropFilter: "blur(20px)" }),
});

/** The floating surface of a message composer, which the conversation scrolls under. */
export const composerGlass = (active = false): ViewStyle => ({
  ...glass(colors.field, corner.composer),
  ...(platform.os === "ios" ? { backgroundColor: alpha(colors.field, 0.25) } : {}),
  boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
  borderWidth: platform.os === "ios" || platform.os === "macos" ? 0 : 1,
  borderColor: alpha(colors.text, active ? 0.22 : 0.1),
  transitionProperty: "border-color",
  transitionDuration: duration.quick,
});
