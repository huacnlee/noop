import { colorScheme, setColorScheme, Storage } from "nsh";
import { KEYS } from "./connection";

export function toggleTheme() {
  const next = colorScheme() === "dark" ? "light" : "dark";
  setColorScheme(next);
  Storage.setItem(KEYS.theme, next);
}
