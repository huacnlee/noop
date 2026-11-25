import type { TextStyle } from "nsh";
import { Icon as SetIcon } from "nsh-icon";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Component,
  Copy,
  Download,
  FileText,
  Globe,
  Image,
  Images,
  Layers,
  Lock,
  Maximize2,
  Menu,
  MessageCircle,
  Mic,
  Minimize2,
  Minus,
  Moon,
  PanelLeft,
  Pause,
  Play,
  Plus,
  Reply,
  Replace,
  ScrollText,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Sun,
  Terminal,
  Trash,
  X,
  ZoomIn,
  ZoomOut,
} from "nsh-icon-lucide";

/** The GitHub mark, filled with the text color (Lucide ships no brand icons). */
const GITHUB = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`,
)}`;

/** The app's icons by role, drawn from Lucide (https://lucide.dev) through nsh-icon. */
const ICONS = {
  "photos": Images,
  "scroll": ScrollText,
  "components": Component,
  "image": Image,
  "chat": MessageCircle,
  "chevron": ChevronRight,
  "chevron-up": ChevronUp,
  "chevron-down": ChevronDown,
  "back": ChevronLeft,
  "check": Check,
  "plus": Plus,
  "minus": Minus,
  "arrow-up": ArrowUp,
  "arrow-down": ArrowDown,
  "reply": Reply,
  "play": Play,
  "pause": Pause,
  "stop": Square,
  "search": Search,
  "bell": Bell,
  "sidebar": PanelLeft,
  "sun": Sun,
  "globe": Globe,
  "moon": Moon,
  "sliders": SlidersHorizontal,
  "settings": Settings,
  "replace": Replace,
  "close": X,
  "copy": Copy,
  "trash": Trash,
  "download": Download,
  "mic": Mic,
  "lock": Lock,
  "layers": Layers,
  "document": FileText,
  "menu": Menu,
  "terminal": Terminal,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
  "maximize": Maximize2,
  "minimize": Minimize2,
  "github": GITHUB,
} satisfies Record<string, string>;

export type IconName = keyof typeof ICONS;

/** An icon in `tint`; `weight` is its stroke in Lucide's 24-unit box (2 by default). */
export function Icon(props: { name: IconName; size?: number; tint: string; weight?: number }) {
  // The icon draws in the text color, which any element takes.
  const style = (): TextStyle => ({ pointerEvents: "none", color: props.tint });
  return <SetIcon icon={ICONS[props.name]} size={props.size ?? 20} strokeWidth={props.weight} style={style()} />;
}
