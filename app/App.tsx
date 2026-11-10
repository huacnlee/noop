// noop chat client: one TSX app for the web (served by the hub), macOS, Linux and phones.
// Design: the NSH gallery's (~/work/nsh/examples/gallery): its theme tokens (theme.json is the
// gallery's), its shared UI layer (nsh-gallery-ui: palette, icons, tooltips, scroll bars), its
// sidebar + toolbar layout; sized up for reading a chat all day (16 pt text, 40 pt controls).
import { L, lang, LANGS } from "./i18n";

import {
  cleanup,
  createAnimatedValue,
  createMotion,
  colorScheme,
  computed,
  effect,
  host,
  Image,
  Overlay,
  keymap,
  lifecycle,
  locale,
  LayoutAnimation,
  List,
  type ListRef,
  mount,
  platform,
  reduceMotion,
  safeArea,
  Scroll,
  type Signal,
  setColorScheme,
  signal,
  Storage,
  Text,
  untracked,
  Video,
  View,
  windowSize, token, openUrl, keyboardFrame, Keyboard, Picker, Speech, Clipboard, Notifications } from "nsh";
import fs from "fs/promises";
import type { InputRef, JSX, ScrollRef, SpeechSession, ViewStyle } from "nsh";
import { Toast, ToastStack, Button as BaseButton, ContextMenu, Menu, MenuItem, Submenu, Input, NavPage, NavStack, Scrollbar, createNavStack } from "nsh/base";
import { isAvailable as hasWindow, titleBar, currentWindow } from "nsh/desktop";
import { checkForPackage, checkForUpdate, downloadPackage, downloadUpdate, installAndRestart, restartToPackage, runningPackage } from "nsh/updater";
import { SettingsToast } from "./settings-toast";
import { Avatar, displayName, Field, linkColor, MONO, pickLang, STATE_OF, surfaceEdge, systemHeader } from "./kit";
import { createHub, type Hub, hostCall, ipBlocked, KEYS, loadConfig, type Boot, type Config } from "./connection";
import { bindMarkdown, chipText, firstLine, reposIn, Rich } from "./markdown";
import { clearDocCache, type DocRef, reading, readerAt } from "./docs";
import { clearNotification, closeNotification, createPush, setBadge, showing, systemNotifications } from "./push";
import { createSettings } from "./settings-state";
import { latch, lazyComponent, lazyModule, lazyOverlay, PageLoading } from "./lazy";
import { CheckMark } from "./ui/icons";
import { attachmentName, isDoc } from "./files";
import { type Channel, channelDigest, sortChannels } from "./channels";
import { isRead, markRead, unreadEvents, toggleMessageRead, type MessageReadState as ReadState } from "./read";
import { setupTray, type TrayChat } from "./tray";
import { createTimelineWindow } from "./timeline";
import { CHECK_EVERY_MS, createUpdates, type UpdateState } from "./update";
import {
  alpha,
  avatarIdentity,
  avatarInitials,
  colors,
  fill,
  iosGlass,
  menuGlass,
  hovered,
  Icon,
  type IconName,
  isDark,
  radius,
  scrollbarTheme,
  Spinner,
  tints,
  Tooltip,
  Badge,
  Button,
  composerGlass,
  corner,
  Count,
  glass,
  IconButton,
  Indicator,
  type IndicatorStatus,
  Input as TextField,
  Kbd,
  size,
  touch,
  MenuRow,
  MenuSep,
  MenuPanel,
  PopIn,
  menuBox,
  menuRowHover,
  SidebarRow,
  PageHeader,
  pageContent,
  font,
  leading,
} from "./ui";
import {
  answeredIds,
  answerOf,
  choiceLabel,
  choicesOf,
  dayLabel,
  groupByDay,
  dayRangeLabel,
  greeting,
  type HubEvent,
  isAsk,
  isHub,
  isVideo,
  loadOf,
  mediaUrl,
  merge,
  normalizeUrl,
  osOf,
  recommended,
  type Attachment,
  attachProblem,
  filePath,
  imageType,
  rows,
  TAGS,
  timeOf,
  waiting,
  activityLine,
  type Row,
  type HostInfo,
  type CommandItem,
  commandItems,
  slashQuery,
  needsLabel,
  isQueued,
  taskConversation,
  type TaskInfo,
} from "./hub";
import { notificationFor, type NotifyRules } from "./notify";
// Interfaces opened now and then, loaded the first time they show (lazy.tsx): chunks of their own on the web.
const settingsPages = lazyModule(() => import("./settings-pages"));
const TeamSettings = lazyComponent(settingsPages, (m) => m.TeamSettings, PageLoading);
const PhoneSettings = lazyComponent(settingsPages, (m) => m.PhoneSettings, PageLoading);
const PhoneNotify = lazyComponent(settingsPages, (m) => m.PhoneNotify, PageLoading);
const PhoneMember = lazyComponent(settingsPages, (m) => m.PhoneMember, PageLoading);
const PhoneRoutine = lazyComponent(settingsPages, (m) => m.PhoneRoutine, PageLoading);
const RulesList = lazyComponent(settingsPages, (m) => m.RulesList, PageLoading);
const RuleDoc = lazyComponent(settingsPages, (m) => m.RuleDoc, PageLoading);
const DocPane = lazyComponent(lazyModule(() => import("./doc-reader")), (m) => m.DocPane, (s) => (
  <View style={{ flex: 1, backgroundColor: colors.background }}>
    <PageLoading failed={s.failed} retry={s.retry} onClose={s.props.onClose} />
  </View>
));
const LazyImagePreview = lazyOverlay(lazyModule(() => import("./image-preview")), (m) => m.ImagePreview, () => L("Couldn’t open the image", "大图打开失败"));
const HelpSheet = lazyOverlay(lazyModule(() => import("./help-sheet")), (m) => m.HelpSheet, () => L("Couldn’t open the keyboard shortcuts", "快捷键一览打开失败"));
const confirms = lazyModule(() => import("./confirms"));
const confirmEndTask = async (id: string, done: boolean, running: boolean) => (await confirms.load()).confirmEndTask(id, done, running);
const updateAllMachines = async (hub: Hub) => (await confirms.load()).updateAllMachines(hub);

// Email sign-in code length (cloud/src/index.ts CODE_LEN): letters and digits, case-insensitive.
const CODE_LEN = 8;

function toggleTheme() {
  const next = colorScheme() === "dark" ? "light" : "dark";
  setColorScheme(next);
  Storage.setItem(KEYS.theme, next);
}

// ---------------------------------------------------------------- small pieces (the gallery's idioms; shared ones in kit.tsx)

/** The app's mark: a dark square with a live dot (the hub). */
function Mark(props: { size?: number }) {
  const s = props.size ?? 24;
  return (
    <View style={{ width: s, height: s, borderRadius: s * 0.28, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: s * 0.38, height: s * 0.38, borderRadius: s, backgroundColor: colors.surface }} />
    </View>
  );
}


/** Puts an image (by URL) on the system clipboard as an image, not as its link. */
async function copyImage(src: string): Promise<void> {
  try {
    const r = await fetch(src);
    if (!r.ok) return;
    const bytes = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const type = r.headers.get("content-type")?.split(";")[0] || "image/png";
    await Clipboard.writeImage(`data:${type};base64,${btoa(bin)}`);
  } catch {
    // nothing to show: the menu has closed and the clipboard keeps what it had
  }
}

function Media(props: { hub: Hub; path: string; /** Every attachment of its message, to page through when zoomed. */ siblings?: string[] }) {
  const src = mediaUrl(props.hub.cfg.url, props.hub.cfg.token, props.path);
  const ratio = signal(16 / 10);
  const zoomed = signal(false);
  const previewed = latch(zoomed);
  const frame: ViewStyle = { borderRadius: radius.inset, backgroundColor: colors.inset };
  if (isDoc(props.path)) return <DocAttachment src={src} name={attachmentName(props.path)} />;
  if (isVideo(props.path)) return <Video src={src} controls paused style={{ ...frame, borderWidth: 1, borderColor: colors.border, width: "100%", maxWidth: 480, aspectRatio: 16 / 9 }} />;
  // a thumbnail that keeps the timeline readable; press it to see the full image
  const THUMB = 240;
  const size = () => (ratio() >= 1 ? { width: THUMB, height: THUMB / ratio() } : { width: THUMB * ratio(), height: THUMB });
  const gone = signal(false); // past the media retention (or otherwise unavailable)
  // the message's images, which the zoomed view pages through in a loop
  const images = () => (props.siblings ?? [props.path]).filter((p) => !isDoc(p) && !isVideo(p));
  return (
    <If
      when={!gone()}
      else={
        <View testID="media-gone" style={{ ...frame, width: THUMB, height: 72, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 13.5, color: colors.faint }}>{L("Image expired", "图片已过期")}</Text>
        </View>
      }
    >
      {/* right-click (long press on touch) copies the image itself */}
      <ContextMenu
        margin={8}
        popupStyle={menuBox()}
        trigger={
          <View accessibilityLabel={L("View full size", "查看大图")} onPress={() => zoomed.set(true)} style={{ cursor: "pointer" }}>
            <Image
              src={src}
              onLoad={({ size }) => size.width && size.height && ratio.set(size.width / size.height)}
              onError={() => gone.set(true)}
              style={{ ...frame, ...size(), objectFit: "cover" }}
            />
          </View>
        }
      >
        <MenuPanel><MenuRow testID="copy-image" icon="copy" label={L("Copy image", "复制图片")} onSelect={() => void copyImage(src)} /></MenuPanel>
      </ContextMenu>
      {/* mounted at the first opening, then kept so it animates closed */}
      <If when={previewed()}>
        <LazyImagePreview hub={props.hub} paths={images()} start={Math.max(0, images().indexOf(props.path))} open={zoomed()} onClose={() => zoomed.set(false)} />
      </If>
    </If>
  );
}

/** A Markdown report attached to a message: a file card that opens the report in the chat's reader pane. */
function DocAttachment(props: { src: string; name: string }) {
  const active = () => reading()?.src === props.src && reading()?.at === readerAt();
  const stem = () => props.name.replace(/\.(md|markdown)$/i, "");
  return (
    <View
      testID="doc-attachment"
      role="button"
      accessibilityLabel={L(`Open ${props.name}`, `打开 ${props.name}`)}
      accessibilityState={{ selected: active() }}
      onPress={() => reading.set(active() ? null : { src: props.src, name: props.name, at: readerAt() })}
      hoverStyle={active() ? undefined : { borderColor: colors.fieldBorder, backgroundColor: alpha(colors.text, 0.03) }}
      style={{
        flexDirection: "row", alignItems: "center", gap: 12, width: 344, maxWidth: "100%", padding: 14,
        borderRadius: radius.inset, borderCurve: "continuous", borderWidth: 1, cursor: "pointer",
        borderColor: active() ? alpha(colors.info, 0.35) : colors.border,
        backgroundColor: active() ? alpha(colors.info, 0.04) : colors.background,
      }}
    >
      <View style={{ width: 40, height: 44, flexShrink: 0, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", gap: 3 }}>
        <Icon name="document" size={18} tint={active() ? colors.info : colors.muted} />
        <Text style={{ fontFamily: MONO, fontSize: 8, fontWeight: "600", letterSpacing: 0.5, color: colors.faint }}>MD</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={{ fontSize: 14, lineHeight: 19, fontWeight: "600", color: colors.text, numberOfLines: 2 }}>{stem()}</Text>
        <Text style={{ fontSize: 12, lineHeight: 16, color: active() ? colors.info : colors.faint, numberOfLines: 1 }}>
          {active() ? L("Markdown · Reading", "Markdown · 正在阅读") : L("Markdown · Report", "Markdown · 报告")}
        </Text>
      </View>
      <Icon name="chevron" size={14} tint={active() ? colors.info : colors.faint} />
    </View>
  );
}


// ---------------------------------------------------------------- timeline

/** Messages the hub just confirmed: a quiet check beside their timestamp fades away. */
const justSent = signal<Set<string>>(new Set());
const SENT_CHECK_MS = 1600;
function markSent(id: string | undefined) {
  if (!id) return;
  justSent.update((s) => new Set(s).add(id));
  setTimeout(() => justSent.update((s) => { const n = new Set(s); n.delete(id); return n; }), SENT_CHECK_MS);
}

/** Delivery feedback shares the timestamp’s visual weight, without a badge or bounce. */
function SentCheck() {
  const still = reduceMotion();
  const fade = createAnimatedValue(still ? 1 : 0);
  if (!still) fade.timing(1, { duration: 150, easing: "easeOut" });
  const t = setTimeout(() => fade.timing(0, { duration: still ? 0 : 300, easing: "easeOut" }), SENT_CHECK_MS - 320);
  cleanup(() => clearTimeout(t));
  return (
    <View
      testID="sent-check"
      accessibilityLabel={L("Sent", "已发送")}
      style={{ width: 14, height: 16, alignItems: "center", justifyContent: "center", opacity: fade }}
    >
      <CheckMark size={14} weight={2.2} tint={colors.muted} />
    </View>
  );
}

/** A message the owner sent that the hub has not confirmed yet: it reads as sent unless delivery fails. */
type Outgoing = { id: string; ts: string; text: string; ref: string | null; files: Attachment[]; state: "held" | "sending" | "failed"; channel?: string };

/** From this window width on, the app lays out for a desktop or tablet rather than a phone. */
const WIDE = 860;


/** The label of an option button: the option's own text when the hub gives one ("B: 升级"). */
function optionText(e: HubEvent, c: string): string {
  if (c === "all" || c === "none") return choiceLabel(c);
  const full = (e.options ?? []).find((o) => new RegExp(`^\\s*${c}\\s*([:：.、)]|\\s)`).test(o));
  // a button can't hold a link: a GitHub PR / issue URL reads as "nsh#747"
  return full ? shortGitHubRefs(full.trim()) : choiceLabel(c);
}

/** Plain text that can't hold a link (buttons, notifications): a GitHub PR / issue URL reads as "nsh#747". */
function shortGitHubRefs(text: string): string {
  return text.replace(/https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/(?:pull|issues)\/(\d+)\/?/g, "$1#$2");
}

type Proposal = { n: string; title: string; agent: string; note: string };
/** The items of an approval batch, from either message format ("1. [agent] title (source)" or "1. 标题（agent）"). */
function proposalsOf(text: string): Proposal[] {
  const out: Proposal[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\\\s*$/, "").replace(/\*\*/g, "").trim();
    const m = line.match(/^(\d+)[.、]\s*(.+)$/);
    if (!m) continue;
    let rest = m[2], agent = "", note = "";
    const a = rest.match(/^\[([\w-]+)\]\s*/);
    if (a) { agent = a[1]; rest = rest.slice(a[0].length); }
    const src = rest.match(/\s*[(（]((?:routine|followup|approved)[^)）]*)[)）]\s*$/);
    if (src) {
      rest = rest.slice(0, src.index);
      const [kind, ref] = src[1].split(":");
      note = kind === "routine" ? L("Routines", "例行任务") : kind === "followup" && ref ? L(`Follow-up to ${ref}`, `接着 ${ref}`) : "";
    }
    const who = rest.match(/\s*[(（]([\w-]+)[)）]\s*$/);
    if (!agent && who) { agent = who[1]; rest = rest.slice(0, who.index); }
    rest = rest.replace(/\s*·\s*\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\s*$/, "").trim();
    out.push({ n: m[1], title: rest, agent, note });
  }
  return out;
}

/** The checklist items of a card: an approval batch from its text, a next-steps menu from its options. */
function menuItems(e: HubEvent): Proposal[] {
  return proposalsOf(e.kind === "menu" ? (e.options ?? []).join("\n") : e.text);
}

/** An approval batch as a checklist: tick what may start, then approve. */
function ProposalList(props: { event: HubEvent; selection: Map<string, Signal<Set<string>>>; done: boolean; onAnswer: (ref: string, choice: string) => void; onReply: (ref: string) => void }) {
  const e = props.event;
  // a next-steps menu is the same checklist: several items may start at once (D-0215 was answered by typing "1,2")
  const menu = e.kind === "menu";
  const items = menuItems(e);
  let picked = props.selection.get(e.id);
  if (!picked) { picked = signal<Set<string>>(new Set()); props.selection.set(e.id, picked); }
  const selection = picked;
  const toggle = (n: string) => selection.update((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const answer = (c: string) => props.onAnswer(e.ref!, c);
  return (
    <>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 }}>
        <Text style={{ fontSize: size.small, color: colors.muted }}>{menu ? L(`Next steps: check the ones to do (${items.length} options)`, `下一步做哪些？勾选要做的（共 ${items.length} 项）`) : L(`The team wants to do ${items.length} things. Check the ones to start:`, `团队想做这 ${items.length} 件事，勾选同意开始的：`)}</Text>
      </View>
      <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
        <Each of={items}>
          {(it) => {
            const on = () => selection().has(it().n);
            return (
              <View
                role="checkbox"
                accessibilityState={{ checked: on() }}
                accessibilityLabel={it().title}
                testID={`proposal-${e.ref}-${it().n}`}
                onPress={props.done ? undefined : () => toggle(it().n)}
                hoverStyle={props.done ? undefined : { backgroundColor: alpha(colors.text, 0.04) }}
                style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 8, cursor: props.done ? "default" : "pointer", opacity: props.done ? 0.5 : 1 }}
              >
                <View style={{ marginTop: 1, width: 16, height: 16, borderRadius: 4, borderWidth: on() ? 0 : 1.5, borderColor: colors.fieldBorder, backgroundColor: on() ? colors.accentFill : "transparent", alignItems: "center", justifyContent: "center" }}>
                  <If when={on()}><Icon name="check" size={12} tint={colors.onAccent} /></If>
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={{ numberOfLines: 2, fontSize: font.sm, lineHeight: leading.sm, color: colors.text, cursor: props.done ? "default" : "pointer" }}>{it().title}</Text>
                  <Text style={{ fontSize: size.tiny, color: colors.faint, cursor: props.done ? "default" : "pointer" }}>{[it().agent && displayName(it().agent), it().note].filter(Boolean).join(" · ")}</Text>
                </View>
              </View>
            );
          }}
        </Each>
      </View>
      <If when={!props.done}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 16 }}>
          <Button testID={`approve-${e.ref}`} label={selection().size ? L(`Approve selected (${selection().size})`, `批准所选（${selection().size}）`) : L("Approve selected", "批准所选")} variant="primary" disabled={!selection().size}
            onPress={() => answer([...selection()].sort((a, b) => +a - +b).join(","))} />
          <Button testID={`opt-${e.ref}-all`} label={L("Approve all", "全部批准")} variant="secondary" onPress={() => answer(menu ? "全部" : "all")} />
          <Button testID={`opt-${e.ref}-none`} label={L("None", "都不要")} variant="ghost" onPress={() => answer(menu ? "都不要" : "none")} />
          <View style={{ flex: 1 }} />
          <Button testID={`other-${e.ref}`} label={L("Other instructions…", "其他指示…")} variant="outline" onPress={() => props.onReply(e.ref!)} />
        </View>
      </If>
    </>
  );
}

/** An answer to a card, as plain words: "P-0002 6,7,8" → "批准 6、7、8". */
/** The answer that sets a question aside (the hub's decisions.IGNORE). */
const IGNORE = "忽略";

function answerText(t: string): string {
  const [, ref, rest] = t.match(/^([DLP]-[A-Z]?\d{4}) (.+)$/) ?? [, "", t];
  const a = rest.trim();
  if (ref.startsWith("P-") || /^\d+(\s*[,，]\s*\d+)+$/.test(a)) {
    if (/^(all|全部)$/i.test(a)) return L("Approve all", "全部批准");
    if (/^(none|都不要)$/i.test(a)) return L("None", "都不要");
    if (/^\d+(\s*[,，]\s*\d+)*$/.test(a)) { const items = a.split(/\s*[,，]\s*/); return L(`Approve ${items.join(", ")}`, `批准 ${items.join("、")}`); }
  }
  return a === IGNORE ? L("Ignored", "忽略") : L(`Chose ${a}`, `选 ${a}`);
}

/** The first line of a card's text, as plain words: what an answer replies to. */
function askLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`_]/g, "").replace(/\\$/, "").trim();
}

/** A message's quick actions under it (like ChatGPT's): copy its text, reply to what it is about. Shown on hover
 * on a desktop, always on a phone (no hover there). */
function MsgActions(props: { text: string; show: () => boolean; onReply?: () => void; align?: "flex-start" | "flex-end"; id: string; unread?: () => boolean; onToggleRead?: () => void }) {
  const copied = signal(false);
  let t: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(t));
  const copy = () => {
    void Clipboard.writeText(props.text.trim()).then(() => {
      copied.set(true);
      clearTimeout(t);
      t = setTimeout(() => copied.set(false), 1500);
    }, () => {});
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", alignSelf: props.align ?? "flex-start", gap: 6, height: touch ? 36 : 24, marginLeft: props.align === "flex-end" ? 0 : -4, opacity: props.show() || copied() ? 1 : 0, transitionProperty: "opacity", transitionDuration: 120 }}>
      <If when={props.onToggleRead}>
        <Button
          testID={`toggle-read-${props.id}`}
          size="sm"
          variant="ghost"
          accessibilityLabel={props.unread?.() ? L("Mark as read", "标为已读") : L("Mark as unread", "标为未读")}
          label={props.unread?.() ? L("Mark read", "标为已读") : L("Mark unread", "标为未读")}
          onPress={() => props.onToggleRead?.()}
        />
      </If>
      <IconButton testID={`copy-${props.id}`} icon={copied() ? "check" : "copy"} label={copied() ? L("Copied", "已复制") : L("Copy", "复制")} size="sm" tooltip={false} onPress={copy} />
      <If when={props.onReply}>
        <IconButton testID={`reply-${props.id}`} icon="reply" label={L("Reply", "回复")} size="sm" tooltip={false} onPress={() => props.onReply?.()} />
      </If>
    </View>
  );
}

function OwnerBubble(props: { hub: Hub; event: HubEvent; out?: Outgoing; onRetry?: () => void; onRecall?: () => void; onRef?: (ref: string) => void }) {
  const e = props.event;
  // an answer sent from the sidebar or a card ("D-0015 忽略") names its card in the text, not in `ref`
  const ref = e.ref ?? e.text.match(/^([DLP]-[A-Z]?\d{4}) \S/)?.[1];
  const over = signal(false);
  // a reply to an agent's message about a task quotes that message (the last one about it before this)
  const said = () => [...props.hub.events()].reverse().find((x) => x.ref === ref && x.ts <= e.ts && x.kind !== "owner" && !isHub(x.from));
  const asked = () => (ref ? askLine(props.hub.events().find((x) => x.ref === ref && isAsk(x))?.text ?? "") || (props.hub.status()?.decisions.find((d) => d.id === ref)?.question ?? "")
    || (/^T-/.test(ref) && said() ? `${displayName(said()!.from)}${L(": ", "：")}${firstLine(said()!.text)}` : "") : "");
  // "选 A" alone says little: the option's own words go under it, without the "A:" it already shows
  const chosen = () => {
    const card = ref && props.hub.events().find((x) => x.ref === ref && isAsk(x));
    const a = e.text.match(/^[DLP]-[A-Z]?\d{4} (\S+)$/)?.[1];
    if (!card || !a || !(card.options ?? []).length) return "";
    const t = optionText(card, a);
    return t === choiceLabel(a) ? "" : t.replace(new RegExp(`^\\s*${a}\\s*[:：.、)]?\\s*`, "i"), "");
  };
  return (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", paddingVertical: 8 }} onMouseEnter={() => over.set(true)} onMouseLeave={() => over.set(false)}>
      <View style={{ maxWidth: "82%", minWidth: 0, flexShrink: 1, alignItems: "flex-end", gap: 4 }}>
        <If
          when={props.out?.state === "failed"}
          else={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <If when={e.text.trim()}>
                <MsgActions id={e.id} text={/^[DLP]-[A-Z]?\d{4} \S/.test(e.text) && !e.text.includes("\n") ? answerText(e.text) : e.text} show={() => touch || over()} align="flex-end" />
              </If>
              {/* only while it can still be taken back; the row keeps its height when this goes */}
              <If when={props.out?.state === "held"}>
                <View role="button" testID="recall-send" accessibilityLabel={L("Undo", "撤回")} onPress={() => props.onRecall?.()} hoverStyle={hovered()} style={{ height: 28, paddingHorizontal: 6, borderRadius: 6, justifyContent: "center", cursor: "pointer" }}>
                  <Text style={{ fontSize: size.tiny, fontWeight: "600", color: colors.muted }}>{L("Undo", "撤回")}</Text>
                </View>
              </If>
              {/* The delivery mark floats left of the time, so it takes no room and never moves the header row. */}
              <View style={{ position: "relative", justifyContent: "center" }}>
                <If when={justSent().has(e.id)}><View style={{ position: "absolute", left: -18, top: 0, bottom: 0, justifyContent: "center" }}><SentCheck /></View></If>
                <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{timeOf(e.ts)}</Text>
              </View>
            </View>
          }
        >
          <View role="button" onPress={props.onRetry} accessibilityLabel={L("Retry sending", "重试发送")} style={{ flexDirection: "row", gap: 6 }}>
            <Text style={{ fontSize: size.tiny, color: colors.danger }}>{L("Couldn’t send", "发送失败")}</Text>
            <Text style={{ fontSize: size.tiny, fontWeight: "600", color: colors.danger }}>{L("Retry", "重试")}</Text>
          </View>
        </If>
        {/* what this answers, quoted above the bubble (press: back to the card) */}
        <If when={ref}>
          <View
            role="link"
            testID={`reply-to-${ref}`}
            onPress={() => props.onRef?.(ref!)}
            hoverStyle={{ opacity: 1 }}
            style={{ cursor: "pointer", opacity: 0.85, flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", paddingHorizontal: 4 }}
          >
            <Icon name="reply" size={13} tint={colors.faint} />
            <Text style={{ ...chipText, fontFamily: MONO, fontSize: 12, color: colors.muted }}>{ref}</Text>
            <If when={asked()}>
              <Text style={{ ...chipText, flexShrink: 1, numberOfLines: 1, fontSize: 13, color: colors.faint }}>{asked()}</Text>
            </If>
          </View>
        </If>
        <If when={e.attachments?.length}>
          <View testID="owner-images" style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "flex-end", gap: 6, opacity: props.out ? 0.65 : 1 }}>
            <Each of={e.attachments ?? []}>{(a) => <Media hub={props.hub} path={a()} siblings={e.attachments} />}</Each>
          </View>
        </If>
        <If when={e.text.trim() || e.ref}>
        <View
          style={{
            paddingHorizontal: 14,
            paddingVertical: 7,
            borderRadius: 18,
            borderBottomRightRadius: 6,
            backgroundColor: tints.accent,
            gap: 4,
            // long code lines wrap or scroll inside the bubble, never widen it past the column
            maxWidth: "100%",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {/^[DLP]-[A-Z]?\d{4} \S/.test(e.text) && !e.text.includes("\n")
            ? <>
                <Text style={{ fontSize: size.text, lineHeight: size.line, fontWeight: "600", color: colors.text, userSelect: "text" }}>{answerText(e.text)}</Text>
                <If when={chosen()}>
                  <Text testID={`answer-option-${ref}`} style={{ fontSize: size.small, lineHeight: 20, color: colors.muted, userSelect: "text" }}>{chosen()}</Text>
                </If>
              </>
            : <Rich text={e.text} />}
        </View>
        </If>
      </View>
    </View>
  );
}

function Message(props: {
  hub: Hub;
  event: HubEvent;
  answered: () => Set<string>;
  /** The pending ask the keyboard acts on. */
  target: () => string | null;
  onAnswer: (ref: string, choice: string) => void;
  onReply: (ref: string, note?: string) => void;
  selection?: Map<string, Signal<Set<string>>>;
  /** Unread on this device; the dot by the name and the action under the message. */
  unread?: () => boolean;
  onToggleRead?: () => void;
}) {
  const e = props.event;
  const selection = props.selection ?? new Map<string, Signal<Set<string>>>();
  const ask = isAsk(e);
  // an agent's message about a task can be replied to: the reply goes to that task
  const replyable = !ask && !isHub(e.from) && !!e.ref && /^T-\d{4,}$/.test(e.ref);
  const over = signal(false);
  const tag = TAGS()[e.kind];
  // what the message is about, for its bare "#746": the card's options, the task's title, the thread it belongs to
  const about = () => {
    if (!e.ref) return (e.options ?? []).join("\n");
    const s = props.hub.status();
    const task = [...(s?.active ?? []), ...(s?.recent ?? [])].find((t) => t.id === e.ref);
    return [...(e.options ?? []), task?.title ?? "", ...props.hub.events().filter((x) => x.ref === e.ref && x.id !== e.id).map((x) => x.text)].join("\n");
  };
  const body = (
    <View style={{ gap: 10 }}>
      <Rich text={ask ? e.text.replace(/\n*^(?:建议：|Recommended: ).*$/m, "").trimEnd() : e.text} muted={e.kind === "system" && isHub(e.from)} context={about()} />
      <If when={e.attachments?.length}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap: 10 }}>
          <Each of={e.attachments ?? []}>{(a) => <Media hub={props.hub} path={a()} siblings={e.attachments} />}</Each>
        </View>
      </If>
    </View>
  );
  const done = () => !!e.ref && props.answered().has(e.ref);
  const picked = () => (e.ref && done() ? answerOf(props.hub.events(), e.ref) : null);
  const targeted = () => ask && !done() && props.target() === e.ref;
  const rec = recommended(e);
  // a phone has no width to spare: the avatar sits in the name's row, and the message takes the whole column
  const wide = () => windowSize().width >= WIDE;
  if (isHub(e.from) && !ask && e.kind === "system" && !e.attachments?.length)
    // top-aligned on one shared line height: baseline alignment drifts once the text carries an inline chip
    return (
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 4, paddingLeft: wide() ? 50 : 0 }}>
        <Text style={{ fontSize: 12, lineHeight: 19, paddingTop: 1, color: colors.faint, fontVariant: ["tabular-nums"] }}>{timeOf(e.ts)}</Text>
        <View selectable style={{ flex: 1, minWidth: 0 }}><Rich text={e.text} quiet /></View>
      </View>
    );
  return (
    <View testID={`msg-${e.id}`} style={{ flexDirection: "row", gap: 14, paddingVertical: 10, paddingHorizontal: 10, marginHorizontal: -10, backgroundColor: props.unread?.() ? alpha(colors.info, 0.035) : "transparent", borderRadius: radius.card, transitionProperty: "backgroundColor", transitionDuration: 240 }} onMouseEnter={() => over.set(true)} onMouseLeave={() => over.set(false)}>
      <If when={wide()}><View style={{ position: "relative", alignSelf: "flex-start" }}><Avatar testID={`avatar-column-${e.id}`} from={e.from} /></View></If>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 22 }}>
          <If when={!wide()}><View style={{ position: "relative" }}><Avatar testID={`avatar-inline-${e.id}`} from={e.from} small /></View></If>
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>{displayName(e.from)}</Text>
          <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{timeOf(e.ts)}</Text>
          <If when={props.unread?.()}>
            <View testID={`unread-dot-${e.id}`} accessibilityLabel={L("Unread", "未读")} style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.info }} />
          </If>
          {tag && !ask ? <Badge label={tag} /> : null}
          <View style={{ flex: 1 }} />
          {/* with a pointer the actions sit in the header and show on hover; a phone keeps them under the message */}
          <If when={!touch && e.text.trim()}>
            <MsgActions id={e.id} text={e.text} show={() => touch || over()} unread={props.unread} onToggleRead={props.onToggleRead} onReply={e.ref && !(ask && !done()) ? () => props.onReply(e.ref!, replyable ? firstLine(e.text) : undefined) : undefined} align="flex-end" />
          </If>
        </View>
        {ask ? (
          <View
            style={{
              marginTop: 6,
              borderRadius: radius.card,
              backgroundColor: colors.surface,
              opacity: 1,
              overflow: "hidden",
              transitionProperty: "opacity",
              transitionDuration: 160,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 12 }}>
              <Badge label={tag ?? L("Needs you", "需要你")} variant={done() ? "neutral" : "warn"} />
              <Text style={{ fontFamily: MONO, fontSize: 13, color: colors.muted }}>{e.ref}</Text>
              <View style={{ flex: 1 }} />
              <If when={done()}>
                <View testID={`replied-${e.ref}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Icon name="check" size={14} tint={colors.up} />
                  <Text style={{ fontSize: 13, color: colors.up }}>{L("Replied", "已回复")}</Text>
                </View>
              </If>
            </View>
            {(e.kind === "proposals" || e.kind === "menu") && menuItems(e).length ? (
              <ProposalList event={e} selection={selection} done={done()} onAnswer={props.onAnswer} onReply={props.onReply} />
            ) : (
            <>
            <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14 }}>{body}</View>
            {/* one option per line: options are sentences, side by side they read as a jumble */}
            <View style={{ alignItems: "flex-start", gap: 8, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 16 }}>
              <Each of={choicesOf(e).slice(0, 12)}>
                {(c, i) => (
                  <Button
                    testID={`opt-${e.ref}-${c()}`}
                    label={optionText(e, c())}
                    variant="secondary"
                    note={rec === c() ? L("Recommended", "推荐") : undefined}
                    disabled={done()}
                    checked={done() && picked()?.toUpperCase() === c().toUpperCase()}
                    onPress={() => props.onAnswer(e.ref!, c())}
                  />
                )}
              </Each>
              {/* answered: the card is a record, not a second chance to send; a free-text answer shows as it was sent */}
              <If when={done() && picked() && !choicesOf(e).some((c) => c.toUpperCase() === picked()!.toUpperCase())}>
                <Text testID={`answer-${e.ref}`} style={{ fontSize: size.small, color: colors.muted }}>{L(`Your reply: ${answerText(`${e.ref} ${picked()}`)}`, `你的回复：${answerText(`${e.ref} ${picked()}`)}`)}</Text>
              </If>
              <If when={!done()}>
                <Button testID={`other-${e.ref}`} label={L("Other instructions…", "其他指示…")} variant="outline" onPress={() => props.onReply(e.ref!)} />
              </If>
              <If when={e.ref!.startsWith("D-") && !done()}>
                <Button testID={`ignore-${e.ref}`} label={L("Ignore", "忽略")} variant="outline" onPress={() => props.onAnswer(e.ref!, IGNORE)} />
              </If>
            </View>
            </>
            )}
          </View>
        ) : (
          body
        )}
        <If when={touch && e.text.trim()}>
          <MsgActions id={e.id} text={e.text} show={() => touch || over()} unread={props.unread} onToggleRead={props.onToggleRead} onReply={e.ref && !(ask && !done()) ? () => props.onReply(e.ref!, replyable ? firstLine(e.text) : undefined) : undefined} />
        </If>
      </View>
    </View>
  );
}

/** A task's state as a status dot: running blue, waiting yellow, done green, failed red, the rest grey. */
const TONE: Record<string, IndicatorStatus> = { active: "running", blocked: "waiting", failed: "error", done: "done", cancelled: "idle", inbox: "queued", waiting: "waiting", nohost: "waiting", parked: "waiting" };


/** A progress step's icon and color. */
const STEP_OF = (): Record<string, [IconName, string]> => ({
  chat: ["chat", colors.muted], start: ["play", colors.info], done: ["check", colors.up], fail: ["close", colors.danger],
  decision: ["pause", colors.warn], retry: ["replace", colors.muted], followup: ["plus", colors.muted],
  delegated: ["layers", colors.info], judge: ["sliders", colors.muted], edit: ["document", colors.muted],
});

/** "11-02 16:34", or "16:34" today. */
function clock(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? "" : `${p(d.getMonth() + 1)}-${p(d.getDate())} `}${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "3 分钟" since an ISO time (to now, or to `end`). */
function since(iso?: string, end?: string): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round(((end ? Date.parse(end) : Date.now()) - Date.parse(iso)) / 60000));
  return m < 1 ? L("just now", "刚刚") : m < 60 ? L(`${m} min`, `${m} 分钟`) : m < 1440 ? L(`${Math.floor(m / 60)} h`, `${Math.floor(m / 60)} 小时`) : L(`${Math.floor(m / 1440)} d`, `${Math.floor(m / 1440)} 天`);
}

const HISTORY_PAGE = 50;

/** One event read record, shared by all views on this device. The old chat watermark migrates once. */
function createMessageReads(hub: Hub) {
  const state = signal<ReadState>({ through: "", ids: [], marked: [] });
  const loaded = signal(false);
  const key = `hub.read:${hub.cfg.url}`;
  let saving = Promise.resolve();
  Promise.all([Storage.getItem(key), Storage.getItem(KEYS.seen), Storage.getItem("hub.markedUnread")]).then(([raw, old, marked]) => {
    let next: ReadState = { through: old ?? "", ids: [], marked: [] };
    try { const marks = JSON.parse(marked ?? "[]"); if (Array.isArray(marks)) next.marked = marks.filter((v: unknown) => typeof v === "string"); } catch {}
    try { const j = JSON.parse(raw ?? "null"); if (j && typeof j.through === "string" && Array.isArray(j.ids)) next = { through: j.through, ids: j.ids.filter((id: unknown) => typeof id === "string"), marked: Array.isArray(j.marked) ? j.marked.filter((v: unknown) => typeof v === "string") : next.marked }; } catch {}
    state.set(next); loaded.set(true);
  });
  const persist = (next: ReadState) => { state.set(next); saving = saving.then(async () => { await Storage.setItem(key, JSON.stringify(next)); await Storage.setItem("hub.markedUnread", JSON.stringify(next.marked ?? [])); }).catch(() => {}); };
  const read = (events: HubEvent[], explicit = false) => {
    if (!untracked(loaded)) return;
    const old = untracked(state);
    const marks = explicit ? (old.marked ?? []).filter((id) => !events.some((e) => e.id === id)) : old.marked;
    const base = marks?.length !== old.marked?.length ? { ...old, marked: marks } : old;
    const next = markRead(base, events);
    if (next !== old) persist(next);
  };
  const unread = computed(() => loaded() ? unreadEvents(hub.events(), state()) : []);
  // the main chat's own: what was said inside a channel is counted on that channel only
  const main = computed(() => unread().filter((e) => !e.channel));
  return { loaded, state, read, unread, main,
    ref: (id: string) => read(untracked(hub.events).filter((e) => e.ref === id), true),
    toggle: (e: HubEvent) => persist(toggleMessageRead(untracked(state), e)),
    all: () => persist({ through: untracked(hub.events).reduce((ts, e) => e.ts > ts ? e.ts : ts, untracked(state).through), ids: [], marked: [] }),
  };
}
type MessageReads = ReturnType<typeof createMessageReads>;

/** Channel snapshots refresh from pushed task/channel revisions, never on a timer. */
function createChannels(hub: Hub, reads: MessageReads) {
  const list = signal<Channel[]>([]);
  let generation = 0;
  const load = async () => {
    const mine = ++generation;
    const r = await hub.api("GET", "/api/channels").catch(() => null);
    if (mine === generation && r?.ok && Array.isArray(r.data.channels)) list.set(sortChannels(r.data.channels as Channel[]));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = "";
  effect(() => {
    const st = hub.status();
    const next = JSON.stringify([st?.channels_revision, st?.tasks, st?.decisions, st?.recent?.map((t) => [t.id, t.updated])]);
    if (next === revision) return;
    revision = next;
    clearTimeout(timer); timer = setTimeout(() => void load(), 150);
  });
  cleanup(() => { clearTimeout(timer); generation++; });
  return {
    list, load, reads,
    unread: (c: Channel) => {
      const refs = new Set(c.refs ?? c.items.filter((i) => i.kind !== "report").map((i) => i.id));
      // the same messages the channel shows, so opening it clears exactly what was counted
      return channelDigest(reads.unread(), [...refs], c.slug, Infinity).length;
    },
    async save(slug: string, patch: { name?: string; goal?: string; archived?: boolean }) {
      generation++;
      const r = await hub.api("POST", "/api/channels", { slug, ...patch });
      if (r.ok) list.set(sortChannels(untracked(list).map((c) => (c.slug === slug ? { ...c, ...(patch.name ? { name: patch.name } : {}), ...(patch.goal !== undefined ? { goal: patch.goal } : {}), ...(patch.archived !== undefined ? { status: patch.archived ? "archived" : "active" } : {}) } : c))));
      return r.ok;
    },
  };
}
type Channels = ReturnType<typeof createChannels>;

/** A page whose head has scrolled out of sight: what its title bar shows in the head's place, and how to bring the head back. */
type Folded = { title: string; detail: string; reveal: () => void };
/** How far a page scrolls before its head's title row is under the bar: past a channel's 44 pt mark and name, past a task's state row and title. */
const CHANNEL_HEAD = 52;
const TASK_HEAD = 72;

/** One channel: its goal (editable), archive, and the tasks and cards that belong to it, newest first. */
/** A channel's head above its conversation: name and purpose together, actions out of the way. The conversation itself is the main chat's. */
function ChannelHeader(props: { channels: Channels; slug: string }) {
  const ch = () => props.channels.list().find((c) => c.slug === props.slug);
  const editing = signal(false);
  const goal = signal("");
  const name = signal("");
  const busy = signal(false);
  const saveGoal = async () => {
    busy.set(true);
    const n = untracked(name).trim(), g = untracked(goal).trim(), c = ch()!;
    const patch = { ...(n && n !== c.name ? { name: n } : {}), ...(g !== c.goal ? { goal: g } : {}) };
    if (!Object.keys(patch).length || (await props.channels.save(props.slug, patch))) editing.set(false);
    busy.set(false);
  };
  return (
    <View testID="channel-page" style={{ paddingTop: 8, paddingBottom: 12 }}>
        <If when={ch()} else={<Text style={{ fontSize: 14, color: colors.faint }}>{L("Loading…", "读取中…")}</Text>}>
          {/* header: a channel reads like a room, name and purpose together, actions out of the way */}
          <View testID="channel-header" style={{ flexDirection: "row", alignItems: "flex-start", gap: 14, paddingBottom: 8 }}>
            <View style={{ width: 44, height: 44, borderRadius: radius.card, alignItems: "center", justifyContent: "center", backgroundColor: alpha(colors.accent, 0.12) }}>
              <Text style={{ fontSize: 22, fontWeight: "700", color: colors.accent }}>#</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ flexShrink: 1, fontSize: 20, fontWeight: "700", color: colors.text, numberOfLines: 1 }}>{ch()!.name}</Text>
                <If when={ch()!.status === "archived"}><View testID="channel-archived"><Badge label={L("Archived", "已归档")} variant="warn" /></View></If>
                <If when={ch()!.status === "active" && ch()!.stale}><View testID="channel-stale"><Badge label={L("Quiet 7 days", "7 天无动静")} /></View></If>
              </View>
              <If when={editing()} else={
                <Text testID="channel-goal" style={{ fontSize: 14.5, lineHeight: 21, color: ch()!.goal ? colors.muted : colors.faint, userSelect: "text" }}>{ch()!.goal || L("No goal yet", "还没有目标")}</Text>
              }>
                <View style={{ gap: 8, paddingTop: 4 }}>
                  <TextField
                    testID="channel-name-input"
                    value={name()}
                    onChange={name.set}
                    onSubmit={() => void saveGoal()}
                    placeholder={L("Channel name", "Channel 名称")}
                  />
                  <TextField
                    testID="channel-goal-input"
                    value={goal()}
                    onChange={goal.set}
                    onSubmit={() => void saveGoal()}
                    placeholder={L("What this channel is for: the team assigns work by it", "这个 channel 是做什么的，团队按它归类工作")}
                  />
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button testID="channel-save-goal" variant="primary" label={L("Save", "保存")} disabled={busy()} onPress={() => void saveGoal()} />
                    <Button testID="channel-cancel-goal" variant="ghost" label={L("Cancel", "取消")} onPress={() => editing.set(false)} />
                  </View>
                </View>
              </If>
            </View>
            <View style={{ flexDirection: "row", gap: 4 }}>
              <If when={!editing()}>
                <Button testID="channel-edit-goal" variant="ghost" label={L("Edit", "编辑")} onPress={() => { name.set(ch()!.name); goal.set(ch()!.goal); editing.set(true); }} />
              </If>
              <Button testID="channel-archive" variant="ghost" label={ch()!.status === "archived" ? L("Unarchive", "取消归档") : L("Archive", "归档")}
                onPress={() => void props.channels.save(props.slug, { archived: ch()!.status !== "archived" })} />
            </View>
          </View>
        </If>
    </View>
  );
}

/** 全部任务: every task the team has, newest first, a page at a time. */
function TaskHistory(props: { hub: Hub; wide: boolean; onTask: (id: string) => void }) {
  const tasks = signal<TaskInfo[]>([]);
  const total = signal<number | null>(null);
  const error = signal("");
  const loading = signal(false);
  const query = signal("");
  let asked = 0; // the newest request; an older answer that lands late is dropped
  async function load(reset: boolean) {
    const mine = ++asked;
    loading.set(true);
    const offset = reset ? 0 : untracked(tasks).length;
    const r = await props.hub.api("GET", `/api/tasks?limit=${HISTORY_PAGE}&offset=${offset}&q=${encodeURIComponent(untracked(query).trim())}`);
    if (mine !== asked) return;
    loading.set(false);
    if (!r.ok) { error.set(r.status ? L(`Couldn’t load (${r.status})`, `读取失败（${r.status}）`) : L("Can’t reach the server", "连不上服务器")); return; }
    error.set("");
    const page = (r.data.tasks as TaskInfo[] | undefined) ?? [];
    tasks.set(reset ? page : [...untracked(tasks), ...page]);
    total.set(Number(r.data.total ?? 0));
  }
  void load(true);
  return (
    <Scroll testID="task-history" style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 12, paddingHorizontal: props.wide ? 32 : 16, paddingVertical: 20 }}>
        {/* searched on the button or Enter, not on every keystroke: each search reads every task on the server */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TextField
            testID="task-search"
            value={query()}
            onChange={query.set}
            onSubmit={() => void load(true)}
            placeholder={L("Search by ID, title or member", "搜索编号、标题或成员")}
            style={{ flex: 1 }}
          />
          <Button testID="task-search-button" label={L("Search", "搜索")} variant="secondary" disabled={loading()} onPress={() => void load(true)} />
        </View>
        <If when={error()}><Text style={{ fontSize: 14, color: colors.danger }}>{error()}</Text></If>
        <If when={total() === 0 && !loading()}><Text style={{ fontSize: 14, color: colors.faint }}>{L("No matching tasks", "没有符合的任务")}</Text></If>
        <Each of={groupByDay(tasks(), (t) => t.updated ?? "")} key={(g) => g.key}>
          {(g) => (
        <View>
          <Text style={{ fontSize: 13, fontWeight: "500", color: colors.faint, marginTop: 8, marginBottom: 4 }}>{dayRangeLabel(g().newest, g().oldest)}</Text>
          <Each of={g().items} key={(t) => t.id}>
            {(t) => (
              <View
                role="button"
                accessibilityLabel={`${t().id} ${t().title}`}
                onPress={() => props.onTask(t().id)}
                hoverStyle={hovered()}
                style={{ minHeight: size.row, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, marginHorizontal: -10, borderRadius: 7 }}
              >
                <Indicator status={TONE[t().state ?? ""] ?? "idle"} />
                <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{t().id}</Text>
                <Text style={{ flex: 1, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>{t().title}</Text>
                <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${STATE_OF()[t().state ?? ""]?.[0] ?? ""} · ${clock(t().updated ?? "")}`}</Text>
              </View>
            )}
          </Each>
        </View>
          )}
        </Each>
        <If when={total() !== null && tasks().length < total()!}>
          <View style={{ alignSelf: "flex-start" }}>
            <Button testID="task-more" label={loading() ? L("Loading…", "读取中…") : L(`Load more (${total()! - tasks().length} left)`, `加载更多（还有 ${total()! - tasks().length} 个）`)} variant="secondary" disabled={loading()} onPress={() => void load(false)} />
          </View>
        </If>
      </View>
    </Scroll>
  );
}

function TaskDetail(props: { hub: Hub; id: string; wide: boolean; onFold?: (folded: Folded | null) => void }) {
  // a task past the status snapshot's newest few is read on its own
  const older = signal<(TaskInfo & { decisions?: string[]; events?: HubEvent[] }) | null>(null);
  const missing = signal(false);
  const t = () => {
    const s = props.hub.status();
    return [...(s?.active ?? []), ...(s?.recent ?? [])].find((x) => x.id === props.id) ?? older() ?? undefined;
  };
  // always read: the page shows the task's whole conversation, and the app only holds the newest events
  void props.hub.api("GET", `/api/tasks/get?id=${encodeURIComponent(props.id)}`).then((r) => {
    if (r.ok) older.set(r.data as TaskInfo); else missing.set(true);
  });
  const cancellable = () => ["active", "inbox", "nohost", "waiting", "parked", "blocked", "proposed"].includes(t()?.state ?? "");
  const cancelling = signal(false);
  async function cancel() {
    if (!(await confirmEndTask(props.id, false, t()?.state === "active"))) return;
    cancelling.set(true);
    try { await props.hub.api("POST", "/api/tasks/cancel", { id: props.id }); }
    catch { cancelling.set(false); }
  }
  // the owner already finished it himself (merged by hand, …): end it as done, not cancelled
  async function finish() {
    if (!(await confirmEndTask(props.id, true, t()?.state === "active"))) return;
    cancelling.set(true);
    try { await props.hub.api("POST", "/api/tasks/cancel", { id: props.id, done: true }); }
    catch { cancelling.set(false); }
  }
  // the task is its own conversation: what the owner and the team said about it, and a box to keep talking
  const saying = signal<HubEvent[]>([]);
  const talk = computed(() => {
    const refs = new Set([props.id, ...(older()?.decisions ?? []), ...(t()?.decision ? [t()!.decision!] : [])]);
    return merge(merge(older()?.events ?? [], props.hub.events()), saying()).filter((e) => !!e.ref && refs.has(e.ref) && (e.thread || !(isHub(e.from) && e.kind === "system")));
  });
  const conversation = computed(() => taskConversation({ ...older(), ...t(), id: props.id, title: t()?.title ?? "", agent: t()?.agent ?? "", request: older()?.request ?? t()?.request, runs: older()?.runs ?? t()?.runs }, talk()));
  const timeline = computed(() => rows(conversation()));
  const settled = computed(() => answeredIds(merge(props.hub.events(), talk())));
  const text = signal("");
  let taskComposer: InputRef | undefined;
  let taskCaret: { start: number; end: number } | null = null;
  const note = signal("");
  const hint = signal("");
  let said = 0;
  async function say() {
    const v = text().trim();
    if (!v) return;
    // reads as sent at once; only a failure brings the words back to the box, with the reason
    const id = `local:${++said}`;
    saying.update((l) => [...l, { id, ts: new Date().toISOString(), from: "owner", kind: "owner", ref: props.id, thread: true, text: v }]);
    text.set("");
    note.set("");
    try {
      await props.hub.send(v, props.id, [], true);
    } catch (e) {
      text.update((now) => (now.trim() ? `${v}\n${now}` : v));
      note.set(String((e as Error)?.message ?? e));
    }
    saying.update((l) => l.filter((x) => x.id !== id));
  }
  const composerHeight = signal(0);
  const showActivity = signal(false);
  const stateLabel = () => (t()!.state === "nohost" ? L(`Waiting for ${needsLabel(t()!.needs)}`, `等 ${needsLabel(t()!.needs)}`) : STATE_OF()[t()!.state ?? ""]?.[0] ?? t()!.state ?? "");
  // Once the title has scrolled under the page's bar, the bar carries it; back at the top, the head shows it again.
  let page: ScrollRef | undefined;
  const headPassed = signal(false);
  const foldTitle = computed(() => (headPassed() && t() ? t()!.title : null));
  const foldDetail = computed(() => (headPassed() && t() ? `${props.id} · ${stateLabel()}` : ""));
  effect(() => {
    const title = foldTitle(), detail = foldDetail();
    untracked(() => props.onFold?.(title === null ? null : { title, detail, reveal: () => page?.scrollTo({ y: 0, animated: !reduceMotion() }) }));
  });
  cleanup(() => props.onFold?.(null));
  return (
    <View style={{ flex: 1 }}>
    <Scroll
      testID="task-page"
      ref={(r) => { page = r; }}
      scrollEventThrottle={100}
      onScroll={(ev) => { const passed = ev.offset.y > TASK_HEAD; if (passed !== untracked(headPassed)) headPassed.set(passed); }}
      style={{ flex: 1 }}
      contentStyle={pageContent}
    >
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", paddingHorizontal: props.wide ? 32 : 16, paddingTop: 24, paddingBottom: composerHeight() + 24 }}>
        <If when={t()} else={<Text style={{ fontSize: 15, color: colors.muted }}>{missing() ? L(`Can’t find ${props.id}.`, `找不到 ${props.id}。`) : L("Loading…", "读取中…")}</Text>}>
          <PageHeader testID="task-head">
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Badge label={stateLabel()} variant={t()!.state === "failed" ? "danger" : t()!.state === "blocked" ? "warn" : "neutral"} />
              <Text style={{ fontFamily: MONO, fontSize: 13, color: colors.muted }}>{t()!.id}</Text>
              <View style={{ flex: 1 }} />
              <If when={cancellable() && !cancelling()}>
                <Button testID="finish-task" label={L("Done", "完成")} variant="ghost" icon="check" onPress={() => void finish()} />
                <Button testID="cancel-task" label={L("Cancel task", "取消任务")} variant="ghost" icon="close" onPress={() => void cancel()} />
              </If>
              <If when={cancelling()}>
                <Text style={{ fontSize: 13, color: colors.muted }}>{L("Working…", "处理中…")}</Text>
              </If>
            </View>
            <Text style={{ userSelect: "text", fontSize: 20, fontWeight: "600", color: colors.text }}>{t()!.title}</Text>
            <Text style={{ fontSize: 14, color: colors.muted }}>
              {[displayName(t()!.agent), t()!.host, t()!.activity?.model ?? t()!.model ?? t()!.cli,
                t()!.started ? L(`Started ${clock(t()!.started!)}`, `${clock(t()!.started!)} 开始`) : "",
                t()!.state === "active" ? L(`Running for ${since(t()!.started)}`, `已运行 ${since(t()!.started)}`) : t()!.finished ? L(`Took ${since(t()!.started, t()!.finished)}`, `用时 ${since(t()!.started, t()!.finished)}`) : "",
                Number(t()!.attempt ?? 1) > 1 ? L(`Attempt ${t()!.attempt}`, `第 ${t()!.attempt} 次`) : ""].filter(Boolean).join(" · ")}
            </Text>
          </PageHeader>
          <If when={t()!.state === "active" ? activityLine(t()!.activity) : null}>
            {(a) => (
              <Text testID="task-activity" style={{ marginTop: 10, fontSize: 13.5, lineHeight: 19, color: a().quiet ? colors.warn : colors.muted }}>{a().text}</Text>
            )}
          </If>
          <If when={t()!.state === "nohost"}>
            <View testID="task-nohost" style={{ marginTop: 16, paddingHorizontal: 14, paddingVertical: 11, borderRadius: radius.inset, backgroundColor: tints.warn }}>
              <Text style={{ fontSize: 14, lineHeight: 21, color: colors.text }}>
                {L(`No ${needsLabel(t()!.needs)} is online, and other idle machines can’t take it. It starts automatically once one comes online; cancel it if you no longer need it.`, `现在没有在线的 ${needsLabel(t()!.needs)}，其他机器闲着也接不了它。有 ${needsLabel(t()!.needs)} 上线后会自动开始；用不上的话可以取消。`)}
              </Text>
            </View>
          </If>
          <View testID="task-talk" style={{ gap: 14, marginTop: 24 }}>
            <Each of={timeline()} key={(row) => row.key}>
              {(item) => {
                const row = item();
                if ("day" in row) return <Text style={{ alignSelf: "center", fontSize: 13, color: colors.faint, marginVertical: 8 }}>{dayLabel(row.day)}</Text>;
                const e = row.event;
                if (e.from === "owner") return <OwnerBubble hub={props.hub} event={e} />;
                return <Message hub={props.hub} event={e} answered={settled} target={() => null}
                  onAnswer={(ref, choice) => void props.hub.send(`${ref} ${choice}`, ref, [], true).catch((err) => note.set(String((err as Error)?.message ?? err)))}
                  onReply={() => hint.set(L("Write your instructions in the box below.", "在下面的输入框继续说。"))} />;
              }}
            </Each>
          </View>
          <If when={t()!.steps?.length}>
            <View style={{ marginTop: 24, gap: 6 }}>
              <Button label={L("Activity", "运行记录")} variant="ghost" onPress={() => showActivity.set(!showActivity())} />
              <If when={showActivity()}><Each of={t()!.steps ?? []}>{(st) => <Text style={{ fontSize: 13, lineHeight: 20, color: colors.muted }}>{`${st().day ?? ""} ${st().time ?? ""}  ${st().text}`}</Text>}</Each></If>
            </View>
          </If>
        </If>
      </View>
    </Scroll>
    <If when={t()}>
      <View
        onLayout={({ bounds }) => composerHeight.set(bounds.size.height)}
        style={{ position: "absolute", bottom: 0, width: "100%", maxWidth: size.column, alignSelf: "center", gap: 6, paddingHorizontal: props.wide ? 32 : 10, paddingTop: 4, paddingBottom: 12, pointerEvents: "box-none" }}
      >
        <If when={note()}>
          <Text style={{ fontSize: 13, color: colors.danger }}>{note()}</Text>
        </If>
        <If when={hint() && !note()}>
          <Text style={{ fontSize: 13, color: colors.muted }}>{hint()}</Text>
        </If>
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, paddingLeft: 16, paddingRight: 8, paddingVertical: 8, ...composerGlass() }}>
          <Input
            testID="task-composer"
            ref={(r) => (taskComposer = r)}
            onSelectionChange={({ start, end }) => (taskCaret = { start, end })}
            multiline
            value={text()}
            onChange={({ value }) => text.set(value)}
            submitBehavior={touch ? "newline" : "submit"}
            onSubmit={() => void say()}
            placeholder={L(`Continue in ${props.id}…`, `在 ${props.id} 里继续说…`)}
            class="placeholder:text-faint"
            style={{ flex: 1, minHeight: 36, maxHeight: 160, paddingVertical: 8, fontSize: 15, lineHeight: 21, color: colors.text, borderWidth: 0, backgroundColor: "transparent" }}
          />
          <IconButton variant="primary" icon="arrow-up" label={L("Send", "发送")} shortcut="Enter" testID="task-send" disabled={!text().trim()} onPress={() => void say()} />
        </View>
      </View>
    </If>
    </View>
  );
}

/** A short horizontal meter: how full something is, 0..100. */
function Meter(props: { pct: number; tone?: "up" | "warn" | "danger" }) {
  const fill = () => ({ up: colors.up, warn: colors.warn, danger: colors.danger })[props.tone ?? "up"];
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.raised, overflow: "hidden" }}>
      <View style={{ width: `${Math.max(0, Math.min(100, props.pct))}%`, height: 6, borderRadius: 3, backgroundColor: fill() }} />
    </View>
  );
}

const ACCOUNT_STATE = (): Record<string, [string, "neutral" | "warn" | "danger"]> => ({ ok: [L("Available", "可用"), "neutral"], cooldown: [L("Cooling down", "冷却中"), "warn"], login: [L("Sign-in needed", "需要登录"), "danger"] });

const ago = (iso?: string) => { const s = since(iso); return s === L("just now", "刚刚") || !s ? s : L(`${s} ago`, `${s}前`); };

function MachineDetail(props: { hub: Hub; host: string; wide: boolean; onTask: (id: string) => void }) {
  const h = () => props.hub.status()?.hosts.find((x) => x.host === props.host);
  const section = (title: string) => (
    <Text role="header" style={{ fontSize: 13, fontWeight: "600", color: colors.muted, marginTop: 24, marginBottom: 8 }}>{title}</Text>
  );
  const stat = (label: string, value: string, pct: number, tone: "up" | "warn" | "danger") => (
    <View style={{ flex: 1, minWidth: 140, gap: 6, padding: 12, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line }}>
      <Text style={{ fontSize: 13, color: colors.muted }}>{label}</Text>
      <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text, fontVariant: ["tabular-nums"] }}>{value}</Text>
      <Meter pct={pct} tone={tone} />
    </View>
  );
  const load = () => loadOf(h()!);
  const memUsed = () => 100 - (h()!.stats?.memFreePct ?? 100);
  const diskUsed = () => 100 - (h()!.stats?.diskFreePct ?? 100);
  const toneOf = (pct: number): "up" | "warn" | "danger" => (pct >= 90 ? "danger" : pct >= 70 ? "warn" : "up");
  const row = (id: string, title: string, right: string, mark?: JSX.Element) => (
    <View
      role="button"
      accessibilityLabel={`${id} ${title}`}
      onPress={() => props.onTask(id)}
      hoverStyle={hovered()}
      style={{ minHeight: size.row, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, marginHorizontal: -10, borderRadius: 7 }}
    >
      {mark}
      <Text style={{ fontFamily: MONO, fontSize: 12.5, color: colors.faint }}>{id}</Text>
      <Text style={{ flex: 1, minWidth: 0, fontSize: 14.5, color: colors.text, numberOfLines: 1 }}>{title}</Text>
      <Text style={{ maxWidth: "50%", minWidth: 0, flexShrink: 1, numberOfLines: 1, fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{right}</Text>
    </View>
  );
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", paddingHorizontal: props.wide ? 32 : 16, paddingVertical: 24 }}>
        <If when={h()} else={<Text style={{ fontSize: 15, color: colors.muted }}>{L(`${props.host} is offline.`, `${props.host} 现在不在线。`)}</Text>}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Indicator status="online" />
              <Text style={{ userSelect: "text", fontSize: 20, fontWeight: "600", color: colors.text }}>{h()!.host}</Text>
            </View>
            <Text style={{ fontSize: 14, color: colors.muted }}>
              {[L("Online", "在线"), [h()!.os ?? osOf(h()!), h()!.arch].filter(Boolean).join(" "), h()!.seen ? L(`Seen ${ago(h()!.seen)}`, `心跳 ${ago(h()!.seen)}`) : "", L(`${h()!.busy ?? 0} running`, `${h()!.busy ?? 0} 个运行中`)].filter(Boolean).join(" · ")}
            </Text>
            <If when={h()!.rev}>
              <RevLink host={h()!} />
            </If>
          </View>
          {section(L("Resources", "资源"))}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {stat(L("Load", "负载"), `${load()}%${h()!.stats?.cores ? L(` · ${h()!.stats!.cores} cores`, ` · ${h()!.stats!.cores} 核`) : ""}`, load(), toneOf(load()))}
            {stat(L("Memory", "内存"), h()!.stats?.memFreePct != null ? L(`${memUsed()}% used`, `已用 ${memUsed()}%`) : L("Unknown", "未知"), memUsed(), toneOf(memUsed()))}
            {stat(L("Disk", "磁盘"), L(`${h()!.stats?.diskFreeGB ?? "?"} GB free`, `剩余 ${h()!.stats?.diskFreeGB ?? "?"} GB`), diskUsed(), toneOf(diskUsed()))}
          </View>
          <If when={h()!.clis?.length || h()!.accounts?.length}>
            {section(L("Tools & accounts", "工具与账号"))}
            <View style={{ gap: 8 }}>
              <If when={h()!.clis?.length}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  <Each of={h()!.clis ?? []}>{(c) => <Badge label={c()} />}</Each>
                </View>
              </If>
              <Each of={h()!.accounts ?? []}>
                {(a) => (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <Text style={{ flex: 1, fontSize: 14.5, color: colors.text }}>{[a().cli, a().name, a().model].filter(Boolean).join(" · ")}</Text>
                    <Badge label={`${ACCOUNT_STATE()[a().state]?.[0] ?? a().state}${a().until ? L(` until ${a().until!.slice(11, 16)}`, ` 至 ${a().until!.slice(11, 16)}`) : ""}`} variant={ACCOUNT_STATE()[a().state]?.[1] ?? "neutral"} />
                  </View>
                )}
              </Each>
            </View>
          </If>
          {section(L("Running", "运行中"))}
          <If when={h()!.running?.length} else={<Text style={{ fontSize: 14, color: colors.faint }}>{L("Idle", "空闲")}</Text>}>
            <View>
              <Each of={h()!.running ?? []} key={(t) => t.id}>
                {(t) => row(t().id, t().title, [displayName(t().agent), t().activity?.model, since(t().started), activityLine(t().activity)?.text].filter(Boolean).join(" · "), <Indicator status="running" />)}
              </Each>
            </View>
          </If>
          {section(L("Recent", "最近"))}
          <If when={h()!.recent?.length} else={<Text style={{ fontSize: 14, color: colors.faint }}>{L("No finished tasks yet", "还没有完成的任务")}</Text>}>
            <View>
              <Each of={h()!.recent ?? []} key={(t) => t.id}>
                {(t) => row(t().id, t().title, t().finished ? ago(t().finished) : "",
                  <Text style={{ width: 14, fontSize: 13, color: STATE_OF()[t().state ?? ""]?.[1] ?? colors.faint }}>{STATE_OF()[t().state ?? ""]?.[2] ?? "·"}</Text>)}
              </Each>
            </View>
          </If>
        </If>
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- sidebar

/** A section heading; pass `open` to make the section collapsible by clicking the heading. */
function SideHeading(props: { title: string; count?: number | string; accent?: boolean; open?: Signal<boolean>; testID?: string }) {
  const o = props.open;
  return (
    <View testID={props.testID} onPress={o ? () => o.set(!o()) : undefined} role={o ? "button" : undefined} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6, cursor: o ? "pointer" : undefined }}>
      <Text style={{ flexShrink: 1, fontSize: 12, fontWeight: "600", color: colors.muted, letterSpacing: 0.4 }}>{props.title}</Text>
      <If when={o}><Icon name={o?.() ? "chevron-up" : "chevron-down"} size={12} tint={colors.faint} /></If>
      <View style={{ flex: 1 }} />
      <If when={props.count}>
        <If when={props.accent} else={<Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{String(props.count)}</Text>}>
          <Count value={props.count!} />
        </If>
      </If>
    </View>
  );
}

function SideEmpty(props: { text: string }) {
  return <Text style={{ fontSize: 13.5, color: colors.faint, paddingHorizontal: 20, paddingVertical: 6 }}>{props.text}</Text>;
}


/** How far the wide layout's floating sidebar sits from the window's edges. */
const sidebarInset = 8;

function Sidebar(props: {
  hub: Hub;
  target: () => string | null;
  onPick: (ref: string) => void;
  /** Set a question aside: it leaves 待你决定 and is not asked again. */
  onIgnore: (ref: string) => void;
  task: () => string | null;
  onTask: (id: string) => void;
  machine: () => string | null;
  onMachine: (host: string) => void;
  onSettings: () => void;
  rules: () => boolean;
  onRules: () => void;
  tasks: () => boolean;
  onTasks: () => void;
  channels: Channels;
  channel: () => string | null;
  onChannel: (slug: string) => void;
  onHelp: () => void;
  onClose?: () => void;
  chrome?: boolean;
  onCollapse?: () => void;
  home: () => boolean;
  onHome: () => void;
  /** Unread messages in the channel on this device, and reading them all. */
  unread: () => number;
  onReadAll: () => void;
  onRestart: () => void;
}) {
  /** Archived channels stay folded under one row; the open one stays in place so the selection doesn't vanish. */
  const showArchived = signal(false);
  const archivedChannels = () => props.channels.list().filter((c) => c.status === "archived" && c.slug !== props.channel());
  const s = () => props.hub.status();
  // the hub closes a decision on its next tick: one the channel already shows answered leaves the list now
  // 排队 starts open and 最近 collapsed; the heading toggles each (owner, T-0987; 排队 open by default, T-1097).
  const queuedOpen = signal(true);
  const recentOpen = signal(false);
  // Channels fold like Slack sections: folded, only the open channel and ones with unread stay (owner, T-9158).
  const channelsOpen = signal(true);
  const waits = computed(() => { const done = answeredIds(props.hub.events()); return waiting(s()).filter((d) => !done.has(d.id)); });
  // the sidebar's right-click menu: end a task that can't go on without opening it
  const endTask = async (id: string, done: boolean) => {
    const running = (s()?.active ?? []).some((a) => a.id === id);
    if (await confirmEndTask(id, done, running)) await props.hub.api("POST", "/api/tasks/cancel", done ? { id, done: true } : { id }).catch(() => {});
  };
  const taskItems = (id: string) => [
    <MenuRow testID={`side-done-${id}`} icon="check" label={L("Mark as done", "标记完成")} onSelect={() => void endTask(id, true)} />,
    <MenuRow testID={`side-cancel-${id}`} icon="close" danger label={L("Cancel task", "取消任务")} onSelect={() => void endTask(id, false)} />,
  ];
  const queue = () => {
    const q = s()?.tasks;
    return [
      [L("To approve", "待批准"), q?.proposed],
      [L("Queued", "排队"), q?.inbox],
      [L("Blocked", "阻塞"), q?.blocked],
      [L("Failed", "失败"), q?.failed],
      [L("Done", "完成"), q?.done],
    ] as const;
  };
  const rowText = () => ({ flex: 1, minWidth: 0, fontSize: 14.5, color: colors.text, numberOfLines: 1 }) as const;
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <View
        desktop={{ windowDrag: true }}
        // the floating panel starts below the window's top: its row stays centered on the title bar, level with the window controls
        style={{ height: props.chrome ? size.bar - sidebarInset : size.bar, paddingBottom: props.chrome ? sidebarInset : 0, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: (props.chrome && hasWindow ? Math.max(0, titleBar().left - sidebarInset) : 0) + 18, paddingRight: 10 }}
      >
        <Text style={{ flex: 1, fontSize: 16, fontWeight: "600", color: colors.text }}>Noop</Text>
        <If when={props.onClose}>
          <IconButton icon="close" label={L("Close menu", "收起菜单")} onPress={() => props.onClose?.()} />
        </If>
        <If when={props.onCollapse}>
          <IconButton icon="sidebar" label={L("Hide sidebar", "隐藏侧栏")} tooltip={false} onPress={() => props.onCollapse?.()} />
        </If>
      </View>
      <Scroll testID="sidebar-scroll" style={{ flex: 1, minWidth: 0 }}>
        {/* Keep intrinsic text widths from expanding the scrollable content. */}
        <View style={{ width: "100%", minWidth: 0, overflow: "hidden", paddingBottom: 16 }}>
          <View style={{ paddingTop: 8 }}>
            <SidebarRow onPress={props.onHome} selected={props.home()} title={L("Channel", "主会话")} menu={<>
              <MenuRow testID="read-all" disabled={!props.unread()} label={L("Mark all as read", "全部标为已读")} onSelect={props.onReadAll} />
            </>}>
              <Icon name="chat" size={17} tint={props.home() ? colors.text : colors.muted} />
              <Text style={{ ...rowText(), fontWeight: "600" }}>{L("Channel", "主会话")}</Text>
              <If when={waits().length && !props.unread()}>
                <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{L(`${waits().length} to decide`, `${waits().length} 待决定`)}</Text>
              </If>
              <If when={props.unread()}>
                <Count testID="channel-unread" accessibilityLabel={L(`${props.unread()} unread`, `${props.unread()} 条未读`)} value={props.unread()} />
              </If>
            </SidebarRow>
            <SidebarRow onPress={props.onRules} selected={props.rules()} title={L("Memory", "记忆")}>
              <Icon name="scroll" size={17} tint={props.rules() ? colors.text : colors.muted} />
              <Text style={rowText()}>{L("Memory", "记忆")}</Text>
            </SidebarRow>
          </View>
          <SideHeading title={L("Needs your decision", "待你决定")} count={waits().length || undefined} accent />
          <Each of={waits()} key={(d) => d.id}>
            {(d) => (
              <SidebarRow onPress={() => props.onPick(d().id)} title={d().id} menu={<>
                <MenuRow testID={`side-ignore-${d().id}`} label={L("Ignore, you decide", "忽略，你来定")} onSelect={() => props.onIgnore(d().id)} />
                {d().task ? taskItems(d().task!) : null}
              </>}>
                <Indicator status="waiting" />
                <Text style={rowText()}>{d().question || d().id}</Text>
                <Text style={{ fontFamily: MONO, fontSize: 12, color: colors.faint }}>{d().id}</Text>
              </SidebarRow>
            )}
          </Each>
          <If when={!waits().length}>
            <SideEmpty text={L("Nothing to do. The team is on it.", "没有待办，团队在自己推进")} />
          </If>

          <SideHeading title={L("In progress", "进行中")} count={s()?.active.length || undefined} />
          <Each of={s()?.active ?? []} key={(a) => a.id}>
            {(a) => (
                              <SidebarRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${a().agent}${a().host ? ` @ ${a().host}` : ""}`} menu={taskItems(a().id)}>
                  <Indicator status="running" />
                  <Text style={rowText()}>{a().title}</Text>
                  <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{since(a().started)}</Text>
                </SidebarRow>
            )}
          </Each>
          <If when={!s()?.active.length}>
            <SideEmpty text={L("Idle", "空闲")} />
          </If>

          <If when={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state)).length}>
            <SideHeading testID="side-queued" open={queuedOpen} title={L("Queued", "排队")} count={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state)).length} />
            <Each of={queuedOpen() ? (s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && isQueued(t.state)) : []} key={(a) => a.id}>
              {(a) => (
                                <SidebarRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${STATE_OF()[a().state ?? ""]?.[0] ?? ""}`} menu={taskItems(a().id)}>
                  <Indicator status={TONE[a().state ?? ""] ?? "idle"} />
                  <Text style={{ ...rowText(), color: colors.muted }}>{a().title}</Text>
                  <Text style={{ maxWidth: "50%", minWidth: 0, flexShrink: 1, numberOfLines: 1, fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{a().state === "waiting" ? L("Waiting on subtasks", "等子任务") : a().state === "parked" ? L("Waiting", "等待") : a().state === "nohost" ? L(`Waiting for ${needsLabel((a() as { needs?: string }).needs)}`, `等 ${needsLabel((a() as { needs?: string }).needs)}`) : L("Queued", "排队中")}</Text>
                </SidebarRow>
              )}
            </Each>
          </If>
          <If when={(s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && !isQueued(t.state)).slice(0, 6).length}>
            <SideHeading testID="side-recent" open={recentOpen} title={L("Recent", "最近")} />
            <Each of={!recentOpen() ? [] : (s()?.recent ?? []).filter((t) => !(s()?.active ?? []).some((a) => a.id === t.id) && !isQueued(t.state)).slice(0, 6)} key={(a) => a.id}>
              {(a) => (
                <SidebarRow onPress={() => props.onTask(a().id)} selected={props.task() === a().id} title={`${a().id} · ${STATE_OF()[a().state ?? ""]?.[0] ?? ""}`}>
                  <Indicator status={TONE[a().state ?? ""] ?? "idle"} />
                  <Text style={{ ...rowText(), color: colors.muted }}>{a().title}</Text>
                  <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{since(a().updated)}</Text>
                </SidebarRow>
              )}
            </Each>
          </If>

          <If when={props.channels.list().length}>
            <SideHeading testID="side-channels" open={channelsOpen} title={L("Channels", "Channels")} count={props.channels.list().reduce((n, c) => n + props.channels.unread(c), 0) || undefined} accent />
            <Each of={props.channels.list().filter((c) => (c.status !== "archived" || c.slug === props.channel()) && (channelsOpen() || c.slug === props.channel() || props.channels.unread(c) > 0))} key={(c) => c.slug}>
              {(c) => (
                <SidebarRow onPress={() => props.onChannel(c().slug)} selected={props.channel() === c().slug} title={c().goal || c().name}>
                  <Text style={{ width: 17, textAlign: "right", fontSize: 15, color: colors.faint }}>#</Text>
                  <Text testID={`side-channel-${c().slug}`} style={{ ...rowText(), color: c().status === "archived" || c().stale ? colors.faint : props.channels.unread(c()) ? colors.text : colors.muted, fontWeight: props.channels.unread(c()) ? "600" : "400" }}>{c().name}</Text>
                  <If when={props.channels.unread(c())} else={
                    <If when={c().status !== "archived" && c().stale}>
                      <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Quiet 7d", "7 天无动静")}</Text>
                    </If>
                  }>
                    <Text testID={`side-channel-unread-${c().slug}`} style={{ fontSize: 12.5, fontWeight: "600", color: colors.accent, fontVariant: ["tabular-nums"] }}>{String(props.channels.unread(c()))}</Text>
                  </If>
                </SidebarRow>
              )}
            </Each>
            <If when={channelsOpen() && archivedChannels().length}>
              <SidebarRow onPress={() => showArchived.set(!showArchived())} title={L("Archived channels", "已归档的 Channel")}>
                <View style={{ width: 17, alignItems: "flex-end" }}><Icon name={showArchived() ? "chevron-down" : "chevron"} size={12} tint={colors.faint} /></View>
                <Text testID="side-channels-archived" style={{ ...rowText(), color: colors.faint }}>{L("Archived", "已归档")}</Text>
                <Text style={{ fontSize: 12.5, color: colors.faint, fontVariant: ["tabular-nums"] }}>{String(archivedChannels().length)}</Text>
              </SidebarRow>
              <If when={showArchived()}>
                <Each of={archivedChannels()} key={(c) => c.slug}>
              {(c) => (
                <SidebarRow onPress={() => props.onChannel(c().slug)} selected={props.channel() === c().slug} title={c().goal || c().name}>
                  <Text style={{ width: 17, textAlign: "right", fontSize: 15, color: colors.faint }}>#</Text>
                  <Text testID={`side-channel-${c().slug}`} style={{ ...rowText(), color: c().status === "archived" || c().stale ? colors.faint : props.channels.unread(c()) ? colors.text : colors.muted, fontWeight: props.channels.unread(c()) ? "600" : "400" }}>{c().name}</Text>
                  <If when={props.channels.unread(c())} else={
                    <If when={c().status !== "archived" && c().stale}>
                      <Text style={{ fontSize: 12.5, color: colors.faint }}>{L("Quiet 7d", "7 天无动静")}</Text>
                    </If>
                  }>
                    <Text testID={`side-channel-unread-${c().slug}`} style={{ fontSize: 12.5, fontWeight: "600", color: colors.accent, fontVariant: ["tabular-nums"] }}>{String(props.channels.unread(c()))}</Text>
                  </If>
                </SidebarRow>
              )}
                </Each>
              </If>
            </If>
          </If>

          <SidebarRow onPress={props.onTasks} selected={props.tasks()} title={L("All tasks", "全部任务")}>
            <Icon name="layers" size={17} tint={colors.muted} />
            <Text style={{ ...rowText(), color: colors.muted }}>{L("All tasks", "全部任务")}</Text>
          </SidebarRow>

          <SideHeading title={L("Machines", "机器")} count={s()?.hosts.length || undefined} />
          <Each of={s()?.hosts ?? []} key={(h) => h.host}>
            {(h) => (
              <SidebarRow onPress={() => props.onMachine(h().host)} selected={props.machine() === h().host} title={L(`Load ${loadOf(h())}% · Disk ${h().stats?.diskFreeGB ?? "?"} GB free · ${h().busy ?? 0} running`, `负载 ${loadOf(h())}% · 磁盘 ${h().stats?.diskFreeGB ?? "?"}GB · ${h().busy ?? 0} 个运行中`)}>
                <Indicator status="online" />
                <Text style={rowText()}>{h().host}</Text>
                <If when={(h().busy ?? 0) > 0}>
                  <Text style={{ fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>{L(`${h().busy} running`, `${h().busy} 运行中`)}</Text>
                </If>
              </SidebarRow>
            )}
          </Each>
          <If when={!s()?.hosts.length}>
            <SideEmpty text={L("No machines online", "没有在线机器")} />
          </If>

          <If when={queue().some((q) => q[1] && q[0] !== L("Done", "完成") && q[0] !== L("To approve", "待批准"))}>
            <Text style={{ fontSize: 13, color: colors.faint, paddingHorizontal: 20, paddingTop: 18, fontVariant: ["tabular-nums"] }}>
              {queue().filter((q) => q[1] && q[0] !== L("Done", "完成") && q[0] !== L("To approve", "待批准")).map((q) => `${q[0]} ${q[1]}`).join(" · ")}
            </Text>
          </If>
        </View>
      </Scroll>
      <UpdateRow onRestart={props.onRestart} />
      <View
        style={{
          minHeight: 56,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 10,
          paddingBottom: touch ? safeArea().bottom : 0,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <UserMenu hub={props.hub} onSettings={props.onSettings} reads={props.channels.reads} />
        </View>
      </View>
    </View>
  );
}

/** The sidebar account, opening the user menu (settings, appearance, language). */
function UserMenu(props: { hub: Hub; onSettings: () => void; reads: MessageReads }) {
  /** The signed-in account: its email, shown as the local part; the server address stays out of the UI. */
  const email = signal("");
  void Storage.getItem(KEYS.email).then((e) => email.set(e ?? ""));
  const account = () => email().split("@")[0] ?? "";
  // A pointer gets a compact popup at the trigger; a finger gets the sheet at the bottom with rows it can hit.
  const touch = platform.os === "ios" || platform.os === "android";
  const m = touch
    ? { row: 52, padX: 16, gap: 12, icon: 20, label: 16, value: 14, avatar: 44, name: 20, mail: 14, seg: 44, segH: 44, sepX: 12 }
    : { row: 30, padX: 8, gap: 10, icon: 15, label: 13.5, value: 13, avatar: 30, name: 13.5, mail: 12, seg: 28, segH: 22, sepX: 8 };
  const sheet = (): ViewStyle => ({ left: 12, right: 12, bottom: Math.max(12, safeArea().bottom), padding: 12 });
  const surface = (): ViewStyle => platform.os === "ios"
    // iOS: the sheet is Liquid Glass (a blurred, nearly opaque fallback before iOS 26), its groups quiet fills on it.
    ? { ...menuGlass(colors.raised, corner.sheet), ...sheet() }
    : touch
    // Android: opaque, as the sheet sits over the sidebar's own rows.
    ? { backgroundColor: colors.raised, borderRadius: corner.sheet, borderCurve: "continuous", boxShadow: "0 10px 40px rgba(0,0,0,0.18)", ...sheet() }
    // No minWidth here: the language submenu takes this same style and should fit its rows; the menu gets its width from its header.
    : { ...glass(colors.surface, 12), padding: 5 };
  const row = (): ViewStyle => ({ flexDirection: "row", alignItems: "center", gap: m.gap, ...(touch ? { minHeight: m.row, paddingVertical: 12 } : { height: m.row }), paddingHorizontal: m.padX, borderRadius: touch ? 12 : 7, borderCurve: "continuous" });
  const label = (text: string) => <Text style={{ flex: 1, minWidth: 0, fontSize: m.label, color: colors.text, ...(touch ? {} : { numberOfLines: 1 }) }}>{text}</Text>;
  const lead = (name: IconName) => <Icon name={name} size={m.icon} tint={colors.muted} />;
  const sep = () => <MenuSep />;
  /** A group of rows on the sheet: a quiet fill on glass, which an opaque one would cover; the surface elsewhere. */
  const group = () => (iosGlass ? alpha(colors.text, fill.rest) : colors.surface);
  const initials = () => avatarInitials(account());
  /** The account's identity: its initials on a soft tint of its own stable hue, with a hairline of the same hue. */
  const avatar = (box: number, testID?: string) => (
    <View testID={testID} style={{ width: box, height: box, borderRadius: box / 2, flexShrink: 0, alignItems: "center", justifyContent: "center",
      borderWidth: 1, borderColor: avatarIdentity(account() || "?").border, backgroundColor: avatarIdentity(account() || "?").background }}>
      <Text style={{ fontSize: Math.round(box * (initials().length > 1 ? 0.38 : 0.44)), fontWeight: "600", color: avatarIdentity(account() || "?").foreground }}>{initials()}</Text>
    </View>
  );
  /** One of the two appearances, as a segment whose raised thumb marks the current one. */
  const appearance = (dark: boolean, title: string, icon: IconName) => (
    <MenuItem testID={dark ? "theme-dark" : "theme-light"} accessibilityLabel={title}
      role="menuitemradio" checked={isDark() === dark} closeOnSelect={false}
      onSelect={() => { if (isDark() !== dark) toggleTheme(); }}
      activeStyle={hovered()}
      style={{ ...(touch ? { flex: 1, minHeight: m.segH, flexDirection: "row", gap: 8, padding: 8 } : { width: m.seg, height: m.segH }), alignItems: "center", justifyContent: "center", borderRadius: touch ? 8 : 6, borderCurve: "continuous",
        ...(isDark() === dark ? { backgroundColor: colors.field, boxShadow: "0 1px 2px rgba(0,0,0,0.14)" } : {}) }}>
      <Icon name={icon} size={touch ? 20 : 14} tint={isDark() === dark ? colors.text : colors.muted} />
      <If when={touch}><Text style={{ fontSize: 16, color: isDark() === dark ? colors.text : colors.muted }}>{title}</Text></If>
    </MenuItem>
  );
  const radio = (text: string, on: () => boolean, pick: () => void, testID: string) => (
    <MenuItem testID={testID} role="menuitemradio" checked={on()} onSelect={() => !on() && pick()} hoverStyle={menuRowHover()} activeStyle={menuRowHover()} style={{ ...row(), ...(touch ? { backgroundColor: group(), marginTop: 4 } : { minWidth: 136 }) }}>
      {label(text)}
      <View style={{ width: m.icon }}>
        <If when={on()}>
          <Icon name="check" size={m.icon - 2} tint={colors.text} />
        </If>
      </View>
    </MenuItem>
  );
  return (
    <Menu
      align="start"
      // Opening the account menu (settings, theme, language) on a phone hides the keyboard first.
      onOpenChange={(open) => { if (open) Keyboard.dismiss(); }}
      offset={6}
      margin={8}
      // On a desktop the surface rides on a `PopIn` inside the bare popup, so it comes in with a short pop each opening.
      popupStyle={touch ? surface() : menuBox()}
      backdropClass="bg-scrim"
      trigger={
        <View
          role="button"
          testID="user-menu"
          accessibilityLabel={L("Account menu", "用户菜单")}
          hoverStyle={hovered()}
          style={{ width: "100%", flexDirection: "row", alignItems: "center", gap: 8, minHeight: touch ? 44 : 40, paddingLeft: 8, paddingRight: 10, borderRadius: radius.control, borderCurve: "continuous" }}
        >
          {avatar(touch ? 28 : 24, "user-avatar")}
          <Text testID="user-account" style={{ flex: 1, fontSize: 13, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{account() || L("Account", "账户")}</Text>
          <Icon name="chevron-up" size={12} tint={colors.faint} />
        </View>
      }
    >
      <PopIn side="top" style={touch ? {} : surface()}>
      <View style={{ ...(touch ? {} : { minWidth: 254 }), flexDirection: "row", alignItems: "center", gap: touch ? 12 : 10, paddingHorizontal: m.padX, paddingTop: touch ? 12 : 6, paddingBottom: touch ? 24 : 7 }}>
        {avatar(m.avatar, "user-menu-avatar")}
        <View style={{ flex: 1, minWidth: 0, gap: touch ? 4 : 1 }}>
          <Text style={{ fontSize: m.name, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{account() || L("Account", "账户")}</Text>
          <If when={email()}>
            <Text style={{ fontSize: m.mail, color: colors.muted, numberOfLines: 1 }}>{email()}</Text>
          </If>
        </View>
      </View>
      <If when={!touch}>{sep()}</If>
      <View style={touch ? { backgroundColor: group(), borderRadius: 12, borderCurve: "continuous" } : {}}>
        <MenuItem testID="mark-all-read" disabled={!props.reads.main().length} onSelect={props.reads.all} hoverStyle={menuRowHover()} activeStyle={menuRowHover()} disabledStyle={{ opacity: 0.4 }} style={row()}>
          {lead("check")}{label(L("Mark all as read", "全部已读"))}
        </MenuItem>
        <MenuItem testID="settings" onSelect={props.onSettings} hoverStyle={menuRowHover()} activeStyle={menuRowHover()} style={row()}>
          {lead("settings")}
          {label(L("Settings…", "设置…"))}
          <If when={touch} else={<Text style={{ fontSize: 12, color: colors.faint }}>{keymap.label("mod+,")}</Text>}><Icon name="chevron" size={14} tint={colors.faint} /></If>
        </MenuItem>
        <Submenu offset={4}
          trigger={<View testID="menu-language" hoverStyle={menuRowHover()} activeStyle={menuRowHover()} style={row()}>
            {lead("globe")}
            {label(L("Language", "语言"))}
            <Text style={{ fontSize: m.value, color: colors.muted }}>{LANGS.find((l) => l.id === lang())?.label ?? "English"}</Text>
            <Icon name="chevron" size={touch ? 14 : 12} tint={colors.faint} />
          </View>}
          back={<View testID="menu-language-back" activeStyle={hovered()} style={row()}><Icon name="back" size={m.icon} tint={colors.muted} />{label(L("Back", "返回"))}</View>}>
          <PopIn side="right" style={touch ? {} : surface()}>
            <Each of={LANGS}>{(l) => radio(l().label, () => lang() === l().id, () => pickLang(l().id), `menu-lang-${l().id}`)}</Each>
          </PopIn>
        </Submenu>
      </View>
      <View style={touch ? { gap: 8, paddingTop: 16, paddingHorizontal: 4 } : { ...row(), height: 34 }}>
        <If when={!touch}>{lead(isDark() ? "moon" : "sun")}</If>
        <Text style={{ ...(touch ? { paddingHorizontal: 12 } : { flex: 1 }), fontSize: touch ? 14 : m.label, color: touch ? colors.muted : colors.text }}>{L("Appearance", "外观")}</Text>
        <View style={{ flexDirection: "row", gap: touch ? 4 : 2, padding: touch ? 4 : 2, borderRadius: touch ? 12 : 8, borderCurve: "continuous", backgroundColor: alpha(colors.text, 0.07) }}>
          {appearance(false, L("Light", "浅色"), "sun")}
          {appearance(true, L("Dark", "深色"), "moon")}
        </View>
      </View>
      </PopIn>
    </Menu>
  );
}

// ---------------------------------------------------------------- app updates

const appUpdate = signal<UpdateState>({ kind: "none" });
const updates = createUpdates(
  {
    check: checkForUpdate, download: () => downloadUpdate(), install: installAndRestart,
    // OTA: a signed package of the app's code. Phones cannot restart an app, so there it runs from the next launch.
    packages: { check: checkForPackage, download: () => downloadPackage(), restart: platform.os === "ios" || platform.os === "android" ? null : restartToPackage, running: runningPackage },
  },
  (state) => appUpdate.set(state),
);
/** The first check waits for the app to settle; nsh/updater answers null where apps do not update (the web, a dev run). */
function watchUpdates() {
  const first = setTimeout(() => void updates.check(), 5000);
  const timer = setInterval(() => void updates.check(), CHECK_EVERY_MS);
  cleanup(() => { clearTimeout(first); clearInterval(timer); });
}

/** Above the sidebar's footer, only when there is something to press. */
function UpdateRow(props: { onRestart: () => void }) {
  const state = () => appUpdate();
  const version = () => { const u = state(); return u.kind === "none" ? "" : u.version; };
  const label = () => {
    const u = state();
    if (u.kind === "link") return L(`Download ${u.version}`, `下载新版本 ${u.version}`);
    if (u.kind === "installing") return L("Updating…", "正在更新…");
    if (u.kind === "failed") return L("Update failed. Click to retry.", "更新失败，点此重试");
    return L(`Restart to update to ${version()}`, `重启以更新到 ${version()}`);
  };
  const press = () => {
    const u = state();
    if (u.kind === "link") void openUrl(u.url).catch(() => {});
    else if (u.kind !== "installing") props.onRestart();
  };
  return (
    <If when={state().kind !== "none" && state().kind !== "staged"}>
      <View
        role="button"
        testID="app-update"
        accessibilityLabel={label()}
        onPress={press}
        class="active:bg-raised"
        style={{ minHeight: touch ? 44 : 36, justifyContent: "center", gap: 2, paddingHorizontal: 18, paddingVertical: 6, borderTopWidth: 1, borderTopColor: alpha(colors.text, 0.08) }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <If when={state().kind === "installing"}>
            <Spinner size={12} tint={colors.muted} />
          </If>
          <Text style={{ flexShrink: 1, fontSize: 13.5, color: state().kind === "installing" ? colors.muted : colors.info, numberOfLines: 1 }}>{label()}</Text>
        </View>
        <If when={state().kind === "failed"}>
          <Text style={{ fontSize: 12, lineHeight: 16, color: colors.muted, numberOfLines: 2 }}>{(state() as { message?: string }).message}</Text>
        </If>
      </View>
    </If>
  );
}


/** The code a machine runs: the short commit, a link to it on GitHub. */
function RevLink(props: { host: HostInfo }) {
  const short = () => (props.host.rev ?? "").slice(0, 7);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text style={{ fontSize: 14, color: colors.muted }}>{L("Version", "版本")}</Text>
      <Text
        role={props.host.rev_url ? "link" : undefined}
        testID={`rev-${props.host.host}`}
        accessibilityLabel={L(`Version ${short()}`, `版本 ${short()}`)}
        onPress={props.host.rev_url ? () => void openUrl(props.host.rev_url!).catch(() => {}) : undefined}
        style={{ fontFamily: MONO, fontSize: 13, color: props.host.rev_url ? linkColor() : colors.muted }}
      >
        {short()}
      </Text>
    </View>
  );
}


// ---------------------------------------------------------------- commands ("/" in the composer)

/** The commands a "/" draft matches, above the composer. While it shows, Up / Down (and Ctrl+P / Ctrl+N) move the
 * pick, Tab or Return runs it, Escape closes the list (clearing the "/"). */
function CommandList(props: {
  items: CommandItem[];
  selected: number;
  touch: boolean;
  onHover: (i: number) => void;
  onMove: (delta: number) => void;
  onRun: (c: CommandItem) => void;
  onClose: () => void;
  onManage: () => void;
}) {
  const run = () => { const c = props.items[props.selected]; if (c) props.onRun(c); };
  keymap.bind(
    { up: () => props.onMove(-1), down: () => props.onMove(1), "ctrl+p": () => props.onMove(-1), "ctrl+n": () => props.onMove(1), tab: run, escape: props.onClose },
    { when: "always", repeat: true },
  );
  return (
    <View
      testID="commands"
      role="menu"
      accessibilityLabel={L("Commands", "指令")}
      style={{ width: "100%", maxWidth: 380, borderRadius: radius.card, borderCurve: "continuous", borderWidth: 1, borderColor: surfaceEdge(), backgroundColor: colors.surface, padding: 4, overflow: "hidden" }}
    >
      <Each of={props.items} key={(c) => c.id}>
        {(c, i) => (
          <View
            testID={`command-${c().id}`}
            role="menuitem"
            accessibilityLabel={c().name}
            accessibilityState={{ selected: i() === props.selected }}
            onPress={() => props.onRun(c())}
            onMouseEnter={() => props.onHover(i())}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 34, paddingHorizontal: 10, borderRadius: 8, backgroundColor: i() === props.selected ? colors.raised : undefined }}
          >
            <Text style={{ flexShrink: 0, maxWidth: 180, fontSize: 14.5, fontWeight: "500", color: colors.text, numberOfLines: 1 }}>{`/${c().name}`}</Text>
            <Text style={{ flex: 1, minWidth: 0, fontSize: 13, color: colors.faint, numberOfLines: 1 }}>{c().detail}</Text>
            <If when={i() === props.selected && !props.touch}>
              <Text style={{ fontSize: 12, color: colors.faint }}>↵</Text>
            </If>
          </View>
        )}
      </Each>
      <If when={!props.items.length}>
        <Text style={{ paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.muted }}>{L("No matching commands", "没有匹配的指令")}</Text>
      </If>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 30, paddingHorizontal: 10, marginTop: 2, borderTopWidth: 0.5, borderTopColor: surfaceEdge() }}>
        <If when={!props.touch}>
          <Text style={{ flex: 1, fontSize: 12, color: colors.faint }}>{L("↑↓ Select · ↵ Run · Esc Close", "↑↓ 选择 · ↵ 执行 · Esc 关闭")}</Text>
        </If>
        <View testID="manage-commands" role="button" onPress={props.onManage} style={{ marginLeft: props.touch ? 0 : undefined }}>
          <Text style={{ fontSize: 12.5, color: colors.accent }}>{L("Manage…", "管理…")}</Text>
        </View>
      </View>
    </View>
  );
}


// ---------------------------------------------------------------- chat

/** The pages of the stack: the channel, what the sidebar opens, and settings with the pages it pushes on phones. */
type Route =
  | { name: "channel" }
  | { name: "team" }
  | { name: "task"; id: string }
  | { name: "host"; host: string }
  | { name: "notify" }
  | { name: "member"; id: string }
  | { name: "routine"; routine: string }
  | { name: "rules" }
  | { name: "tasks" }
  | { name: "doc"; path: string };
const CHANNEL: Route = { name: "channel" };

function Chat(props: { hub: Hub; openRef?: string | null; onConnection: () => void; onDisconnect: () => void; onTray?: (chat: TrayChat | null) => void }) {
  const hub = props.hub;
  const settings = createSettings(hub);
  const push = createPush(hub, settings.toast.show);
  const reads = createMessageReads(hub);
  const channels = createChannels(hub, reads);
  const wide = () => windowSize().width >= WIDE;
  const drawer = signal(false);
  const drawerDragging = signal(false);
  const drawerVisible = signal(false);
  let drawerHideTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(drawerHideTimer));
  const drawerX = createAnimatedValue(0);
  const drawerWidth = () => Math.min(size.sidebar + 16, windowSize().width * 0.86);
  const drawerTranslate = () => drawerX.interpolate({ inputRange: [0, drawerWidth()], outputRange: [0, drawerWidth()] });
  const animateDrawer = (open: boolean) => {
    if (reduceMotion()) drawerX.set(open ? drawerWidth() : 0);
    else drawerX.timing(open ? drawerWidth() : 0, { duration: 200, easing: "easeOut" });
  };
  effect(() => {
    if (wide()) return;
    const open = drawer();
    clearTimeout(drawerHideTimer);
    // Opening the sidebar is leaving the composer: hide the keyboard, as native apps do.
    if (open) { Keyboard.dismiss(); drawerVisible.set(true); }
    else drawerHideTimer = setTimeout(() => drawerVisible.set(false), reduceMotion() ? 0 : 200);
    animateDrawer(open);
  });
  const finishDrawerPan = (e: { cancelled: boolean; translation: { x: number } }) => {
    const wasOpen = untracked(drawer);
    const next = e.cancelled ? wasOpen : wasOpen ? e.translation.x > -45 : e.translation.x > 45;
    drawerDragging.set(false);
    if (next === wasOpen) animateDrawer(next);
    else drawer.set(next);
  };
  const sidebarOpen = signal(true);
  const setSidebarOpen = (open: boolean) => {
    if (open === untracked(sidebarOpen)) return;
    if (!reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut"));
    sidebarOpen.set(open);
  };
  const help = signal(false);
  const helpOpened = latch(help);
  // The pages: the channel at the bottom, what the sidebar, a link or settings opened above it.
  const nav = createNavStack<Route>([CHANNEL]);
  const top = () => { const r = nav.routes(); return r[r.length - 1]; };
  // Any page change (settings, a task, back) takes the keyboard down with the input it served.
  let lastTop: Route | undefined;
  effect(() => { const t = top(); if (lastTop !== undefined && t !== lastTop) Keyboard.dismiss(); lastTop = t; });
  const onChannel = () => nav.routes().length === 1;
  /** The channel the conversation is narrowed to (a Slack-like topic), or null for the main chat. Same view, same composer. */
  const scope = signal<string | null>(null);
  effect(() => { const r = top(); readerAt.set(r.name === "task" ? `task:${r.id}` : r.name === "channel" ? `channel:${scope() ?? ""}` : r.name); });
  const scoped = () => { const slug = scope(); return slug ? channels.list().find((c) => c.slug === slug) : undefined; };
  const openScope = (slug: string | null) => { drawer.set(false); nav.popToRoot(); scope.set(slug); };
  // a channel's history beyond what this device holds; what is said there arrives live like the main chat's
  const channelFeed = signal<HubEvent[]>([]);
  effect(() => {
    const slug = scope();
    scoped()?.last_activity;
    if (!slug) { channelFeed.set([]); return; }
    void hub.api("GET", `/api/channels/feed?slug=${encodeURIComponent(slug)}`).then((r) => {
      if (untracked(scope) === slug && r?.ok && Array.isArray(r.data.events)) channelFeed.set(r.data.events as HubEvent[]);
    }).catch(() => {});
  });
  /** Shows a page over the channel, in place of the one shown (the sidebar's pages are siblings). */
  const show = (...routes: Route[]) => { drawer.set(false); nav.setRoutes([CHANNEL, ...routes]); };
  const openHost = (h: string) => show({ name: "host", host: h });
  /** A task: from a machine's page it goes on top (back returns to the machine), else in place. */
  const openTask = (id: string) => {
    const t = untracked(top);
    if (t.name === "host" || t.name === "tasks" || (t.name === "channel" && untracked(scope))) { drawer.set(false); nav.push({ name: "task", id }); }
    else show({ name: "task", id });
  };
  const repos = computed(() => { const m = new Map<string, string>(); for (const e of props.hub.events()) reposIn(`${e.text}\n${(e.options ?? []).join("\n")}`, m); return m; });
  bindMarkdown({
    taskLink: openTask,
    knownRepos: repos,
    taskState: (id) => { const s = props.hub.status(); return [...(s?.active ?? []), ...(s?.recent ?? [])].find((t) => t.id === id)?.state ?? (s?.active.some((t) => t.id === id) ? "active" : undefined); },
  });
  /** A card being scrolled to (picked from the sidebar, a notification): entering the channel leaves the scroll to it. */
  let jumping: string | null = null;
  // Entering the channel (first load, back from a task or settings) shows the latest messages.
  effect(() => { if (onChannel() && !jumping) { atEnd.set(true); unseen.set(0); toEnd(); } });
  const draft = signal("");
  const replyTo = signal<string | null>(null);
  /** What the reply answers, for the chip ("Kai：nsh #812 主要修的是…"); none for a decision (its id says it). */
  const replyNote = signal<string | null>(null);
  const focused = signal(false);
  const inputHeight = signal(28);
  const outbox = signal<Outgoing[]>([]);
  const atEnd = signal(true);
  /** The channel's head (name, goal, actions) has scrolled under the bar. */
  const headPassed = signal(false);
  const unseen = signal(0);
  const chosen = signal<string | null>(null);

  // The server can accept a message even when the POST response is lost (e.g. iOS
  // suspends the app). A streamed/replayed event is also a delivery receipt.
  effect(() => {
    const receipts = new Set(hub.events().filter((e) => e.kind === "owner").map((e) => e.client_id));
    const pending = untracked(outbox);
    const remaining = pending.filter((o) => !receipts.has(o.id));
    if (remaining.length !== pending.length) outbox.set(remaining);
  });

  /** The timeline: the hub's events and the messages on their way. */
  const shown = computed(() => {
    const slug = scope();
    const outgoing = outbox().filter((o) => (o.channel ?? null) === slug).map((o) => ({
      id: o.id, ts: o.ts, from: "owner", kind: "owner" as const, text: o.text, ref: o.ref ?? undefined, channel: o.channel,
      attachments: o.files.length ? o.files.map((f) => f.preview) : undefined,
    }));
    if (slug) {
      const ch = untracked(scoped);
      const refs = scoped()?.refs ?? ch?.items.filter((i) => i.kind !== "report").map((i) => i.id) ?? [];
      return merge(channelDigest(merge(channelFeed(), hub.events()), refs, slug, Infinity), outgoing);
    }
    return merge(hub.events().filter((e) => !e.thread && !e.channel && !(e.kind === "system" && e.text.startsWith("⚙️ 设置已更新"))), outgoing);
  });
  // one answer state for every view: the owner may answer a card in the main chat that a channel also shows
  const answered = computed(() => answeredIds(merge(hub.events(), shown())));
  /** The newest Markdown report in this conversation: the reader opens it by itself when it arrives. */
  const latestDoc = computed((): DocRef | null => {
    const list = shown();
    for (let i = list.length - 1; i >= 0; i--) {
      const path = [...(list[i].attachments ?? [])].reverse().find(isDoc);
      if (path) return { src: mediaUrl(hub.cfg.url, hub.cfg.token, path), name: attachmentName(path) };
    }
    return null;
  });
  let autoDoc: string | undefined;
  effect(() => {
    const d = latestDoc();
    if (d?.src === autoDoc) return;
    autoDoc = d?.src;
    untracked(() => reading.set(d && { ...d, at: `channel:${scope() ?? ""}` }));
  });
  // a different hub or a sign-out starts with no reports kept from the last one
  cleanup(clearDocCache);
  const readerWide = signal(false);
  /** Room for the chat beside the reader; below it the reader covers the chat like a sheet. */
  const chatRoom = () => windowSize().width - (wide() && sidebarOpen() ? size.sidebar : 0);
  const readerSide = () => wide() && chatRoom() >= 860;
  const readerWidth = () => (readerWide() ? Math.round(chatRoom() * 0.62) : Math.min(460, Math.round(chatRoom() * 0.42)));
  const shownDoc = () => { const d = reading(); return d && d.at === readerAt() ? d : null; };
  /** The reader beside a page that has one (the channel, a task), from the window's top edge. */
  const docSide = () => !!shownDoc() && readerSide() && (top().name === "channel" || top().name === "task");
  const readerPane = () => {
    const d = shownDoc();
    if (!d) return null;
    return <DocPane doc={d} wide={readerSide()} expanded={readerWide()} onExpand={() => { if (!reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.create(180, "easeInEaseOut")); readerWide.set(!readerWide()); }} onClose={() => reading.set(null)} />;
  };
  const visibleMessages = signal<HubEvent[]>([]);
  effect(() => {
    if (!reads.loaded() || lifecycle() !== "active") return;
    const route = top();
    if (onChannel()) {
      // Reading is top-down: everything at or above the newest row on screen counts as read, so rows the
      // reader scrolled past (or jumped over to the bottom) don't pop back as unread later.
      const seen = visibleMessages();
      const newest = seen.reduce((ts, e) => (e.ts > ts ? e.ts : ts), "");
      reads.read(newest ? untracked(shown).filter((e) => e.ts <= newest) as HubEvent[] : seen);
    }
    else if (route.name === "task") { hub.events(); reads.ref(route.id); }
  });
  // "以下为新消息": above the first unread message when entering a view, from the one read record the
  // main chat and every channel share; fixed for the visit so reading on doesn't move it.
  const divider = signal<string | null | undefined>(undefined);
  let dividerScope: string | null | undefined;
  effect(() => {
    const slug = scope();
    if (!hub.loaded() || !reads.loaded()) return;
    if (slug && !scoped()) return;
    if (dividerScope === slug && untracked(divider) !== undefined) return;
    dividerScope = slug;
    divider.set(untracked(shown).find((e) => e.kind !== "owner" && !isRead(e, untracked(reads.state)))?.id ?? null);
  });
  // List diffs its items by identity: rebuilt rows would read as all replaced on every new message,
  // losing their measurements and the reader's place. Reuse each row while its event is the same.
  type TimelineRow = Row | { key: string; unread: true } | { key: string; more: number } | { key: string; head: string };
  /** The newest messages shown; older ones wait behind 「加载更早的消息」 so the list stays short. */
  const PAGE = 200;
  const limit = signal(PAGE);
  let built = new Map<string, TimelineRow>();
  let timelineWindow = createTimelineWindow(PAGE);
  const UNREAD: TimelineRow = { key: "unread", unread: true };
  const timeline = computed((): TimelineRow[] => {
    const d = divider();
    const next = new Map<string, TimelineRow>();
    const out: TimelineRow[] = [];
    const all = shown();
    const hidden = timelineWindow.update(all, hub.loaded(), limit(), untracked(atEnd) && untracked(onChannel));
    // a channel's head stays the first row, above any older history still to load, so its name, goal and actions are always at the top
    const slug = scope();
    if (slug) {
      const key = `head:${slug}`;
      const head = built.get(key) ?? { key, head: slug };
      next.set(key, head);
      out.push(head);
    }
    if (hidden) {
      const old = built.get("more");
      const more = old && "more" in old && old.more === hidden ? old : { key: "more", more: hidden };
      next.set("more", more);
      out.push(more);
    }
    for (const row of rows(hidden ? all.slice(hidden) : all)) {
      if ("event" in row && row.event.id === d) out.push(UNREAD);
      const old = built.get(row.key);
      const keep = old && ("event" in row ? "event" in old && old.event === row.event : "day" in old);
      const r = keep ? old : row;
      next.set(r.key, r);
      out.push(r);
    }
    built = next;
    return out;
  });
  const pending = computed(() => hub.events().filter((e) => isAsk(e) && !answered().has(e.ref!)));
  /** The pending ask the keys act on: the one picked (J / K, the sidebar), else the newest. */
  const target = computed(() => {
    const p = pending();
    const c = chosen();
    return p.find((e) => e.ref === c)?.ref ?? p[p.length - 1]?.ref ?? null;
  });
  const proposalSelection = new Map<string, Signal<Set<string>>>();
  let scroller: ListRef | undefined;
  let composer: InputRef | undefined;

  let count = 0;
  const toEnd = (animated = false) => setTimeout(() => scroller?.scrollToEnd({ animated }), 40);
  // Switching between the main chat and a channel (or channel to channel) is entering too: start at the latest message.
  effect(() => { scope(); if (untracked(onChannel) && !jumping) { atEnd.set(true); unseen.set(0); toEnd(); } });
  // A channel's history arrives after the switch; land on its end unless the reader has scrolled up meanwhile.
  effect(() => { channelFeed(); if (untracked(atEnd) && !jumping) toEnd(); });
  // The list follows its end by itself (alignment="bottom"); scrolled further up than AT_END, it stays put and this counts what came below.
  const AT_END = 24;
  effect(() => {
    const n = shown().length;
    const grew = n > count;
    count = n;
    if (grew && !untracked(atEnd)) unseen.update((u) => u + 1);
  });
  /** What the floating composer covers at the bottom of the timeline. */
  const composerHeight = signal(0);
  // Keep every explicit timeline jump short, including off-screen decision cards.
  // Stage the target one viewport away, let recycled rows lay out, then use the
  // platform's smooth scroll for the final screen instead of traversing the history.
  let firstVisibleRow = -1;
  let lastVisibleRow = -1;
  let timelineHeight = 600;
  let jumpVersion = 0;
  const cancelJump = () => { jumpVersion++; };
  cleanup(cancelJump);
  function scrollTimeline(index: number, end = false) {
    const list = scroller;
    if (!list || index < 0) return;
    const version = ++jumpVersion;
    const animated = !reduceMotion();
    const finish = () => {
      if (version !== jumpVersion || scroller !== list) return;
      if (end) list.scrollToEnd({ animated });
      else list.scrollToIndex({ index, viewOffset: 24, animated });
    };
    const far = firstVisibleRow >= 0 && (index < firstVisibleRow - 1 || index > lastVisibleRow + 1);
    if (!animated || !far) { finish(); return; }
    const direction = index > lastVisibleRow ? 1 : -1;
    list.scrollToIndex({
      index, viewPosition: end ? 1 : 0,
      viewOffset: (end ? 0 : 24) + direction * timelineHeight,
      animated: false,
    });
    requestAnimationFrame(() => requestAnimationFrame(finish));
  }
  const jumpToEnd = () => {
    unseen.set(0);
    scrollTimeline(untracked(timeline).length - 1, true);
  };
  // another channel is another conversation: its own window, its own page of history, opened at its latest
  let windowScope: string | null = null;
  effect(() => {
    const slug = scope();
    if (slug === windowScope) return;
    windowScope = slug;
    timelineWindow = createTimelineWindow(PAGE);
    built = new Map();
    limit.set(PAGE);
    headPassed.set(false);
    atEnd.set(true); unseen.set(0); count = untracked(shown).length; toEnd();
  });
  // Pages whose head has scrolled under the bar, which then carries a compact title instead; back at the head it unfolds.
  const taskFolds = signal<Record<string, Folded | null>>({});
  const folded = (r: Route): Folded | null => {
    if (r.name === "task") return taskFolds()[r.id] ?? null;
    if (r !== CHANNEL || !headPassed() || !scope()) return null;
    const c = scoped();
    return { title: `# ${c?.name ?? scope()}`, detail: c?.goal ?? "", reveal: () => scrollTimeline(0) };
  };

  const reply = (ref: string, note?: string) => {
    replyNote.set(note ?? null);
    replyTo.set(ref);
    if (!untracked(onChannel)) nav.popToRoot();
    composer?.focus();
  };

  // A message reads as sent at once but leaves a few seconds later, so 撤回 (or Mod+Z) can still take it back.
  const UNDO_MS = 5000;
  const holds = new Map<string, ReturnType<typeof setTimeout>>();
  function send(text: string, ref: string | null, id = `local:${crypto.randomUUID()}`, files: Attachment[] = [], silent = false) {
    const ts = new Date().toISOString();
    const channel = untracked(scope) ?? undefined;
    outbox.update((o) => [...o.filter((x) => x.id !== id), { id, ts, text, ref, files, state: "held", channel }]);
    // answering a card is a quiet act: the reader stays where the card is
    if (!silent) jumpToEnd();
    holds.set(id, setTimeout(() => { holds.delete(id); void deliver(id); }, UNDO_MS));
  }
  function deliverHeld() {
    return [...holds].map(([id, hold]) => {
      clearTimeout(hold);
      holds.delete(id);
      return deliver(id);
    });
  }
  // Leaving the app must not strand a message that already looks sent.
  effect(() => {
    if (lifecycle() !== "active") deliverHeld();
  });
  // An update restarts the app: what looks sent leaves first, and what is being typed comes back.
  async function restartToUpdate() {
    await Promise.allSettled(deliverHeld());
    if (draft()) await Storage.setItem(KEYS.draft, draft());
    await updates.install();
    await Storage.removeItem(KEYS.draft); // the install failed: this run still holds the draft
  }
  Storage.getItem(KEYS.draft).then((v) => {
    if (!v) return;
    if (!untracked(draft)) draft.set(v);
    void Storage.removeItem(KEYS.draft);
  });
  function undo(id?: string) {
    const o = id ? outbox().find((x) => x.id === id) : [...outbox()].reverse().find((x) => x.state === "held");
    if (!o || !holds.has(o.id)) return false;
    clearTimeout(holds.get(o.id));
    holds.delete(o.id);
    outbox.update((list) => list.filter((x) => x.id !== o.id));
    if (!/^[DLP]-[A-Z]?\d{4} \S+$/.test(o.text) || o.ref || o.files.length) {
      draft.set(o.text);
      replyNote.set(null);
      replyTo.set(o.ref);
      attachments.update((a) => [...o.files, ...a]);
      composer?.focus();
    }
    return true;
  }
  async function deliver(id: string) {
    const o = outbox().find((x) => x.id === id);
    if (!o || o.state === "sending") return;
    const { text, ref, files, channel } = o;
    outbox.update((l) => l.map((x) => (x.id === id ? { ...x, state: "sending" } : x)));
    try {
      markSent(await hub.send(text, ref, files, false, id, channel));
      outbox.update((o) => o.filter((x) => x.id !== id));
    } catch {
      outbox.update((o) => o.map((x) => (x.id === id ? { ...x, state: "failed" } : x)));
    }
  }
  // Commands: a draft of "/<query>" lists the built-in and saved commands; Return runs the first one.
  const slash = () => slashQuery(draft());
  const commands = () => { const q = slash(); return q == null ? [] : commandItems(settings.view(), q).slice(0, 8); };
  /** The command Return runs: Up and Down move it, a new query starts it over at the first. */
  const cmdSel = signal(0);
  effect(() => { slash(); cmdSel.set(0); });
  const pickedCommand = () => commands()[Math.min(cmdSel(), commands().length - 1)];
  effect(() => { if (slash() != null && !untracked(settings.view)) settings.load(); });
  function runCommand(c: CommandItem) {
    draft.set("");
    inputHeight.set(28);
    if (c.action === "update-fleet") void updateAllMachines(hub);
    else if (c.text) void send(c.text, null);
  }

  function submit() {
    if (speech() !== "off") stopDictation(true);
    if (slash() != null && commands().length && !attachments().length) return runCommand(pickedCommand()!);
    const v = draft().trim();
    const files = attachments();
    if (!v && !files.length) return;
    // A bare choice ("1", "B", "1,3", "全部") answers the decision the keyboard is on, never becomes a new task.
    const r = replyTo() ?? (!files.length && /^([1-9](\s*[,，]\s*[1-9])*|[A-Za-z]|全部|都不要)$/.test(v) ? target() : null);
    draft.set("");
    replyTo.set(null);
    attachments.set([]);
    attachNote.set(null);
    inputHeight.set(28);
    send(v, r, undefined, files);
  }

  // Images the owner attaches: pasted, dropped on the window, or picked.
  const attachments = signal<Attachment[]>([]);
  const attachNote = signal<string | null>(null);
  // A file drag over the window: null when none, else the offered files (empty until the shell reports them).
  const dropping = signal<string[] | null>(null);
  let attachSeq = 0;
  function attach(file: Blob, name: string, fromPicker = false) {
    // the photo picker only returns images, but phones often give them no type or extension; the server reads the bytes
    const type = imageType(file.type, name) ?? (fromPicker ? "image/jpeg" : null);
    const problem = attachProblem(type, file.size, attachments().length);
    if (problem) return attachNote.set(problem);
    attachNote.set(null);
    const typed = file.type === type ? file : new Blob([file], { type: type! });
    const preview = URL.createObjectURL(typed);
    attachments.update((a) => [...a, { id: `a${++attachSeq}`, name: name || `image-${attachSeq}.png`, type: type!, size: file.size, file: typed, preview }]);
  }
  function unattach(id: string) {
    const a = attachments().find((x) => x.id === id);
    if (a) URL.revokeObjectURL(a.preview);
    attachments.update((list) => list.filter((x) => x.id !== id));
    attachNote.set(null);
  }
  /** Local files (`file:` URLs from a drop or a file manager's copy): read the images among them. */
  async function attachUris(uris: string[]) {
    for (const u of uris) {
      const path = filePath(u);
      const name = path.split(/[\\/]/).pop() ?? "image";
      if (!imageType(undefined, name)) { attachNote.set(L("Only images can be sent", "只能发送图片")); continue; }
      try {
        const bytes = await fs.readFile(path);
        attach(new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
      } catch {
        attachNote.set(L(`Can’t read ${name}`, `读不到 ${name}`));
      }
    }
  }
  async function pickImages() {
    try {
      const picked = await Picker.pickImages({ multiple: true, limit: 10 });
      for (const p of picked) attach(p.file, p.file.name, true);
    } catch {
      attachNote.set(L("Can’t pick images on this device", "这台设备上不能选择图片"));
    }
    composer?.focus();
  }
  // Dictation (语音输入): nsh's Speech in the native apps, the browser's speech recognition (through
  // host.js) on the web. Its words land in the composer where the caret was (or at the end), live as
  // they are heard; nothing is sent. Where there is neither, there is no button.
  const canDictate = signal(false);
  const speech = signal<"off" | "on" | "stopping">("off");
  let native = false;
  let session: SpeechSession | null = null;
  void Speech.available()
    .catch(() => false)
    .then(async (ok) => {
      native = ok;
      canDictate.set(ok || !!(await hostCall<{ supported: boolean }>("speechState"))?.supported);
    });
  let caret: { start: number; end: number } | null = null;
  let before = "";
  let after = "";
  let dictated = ""; // the draft as dictation last left it: anything else is the owner typing
  /** The recognizer's language: the device's Chinese, else Mandarin (the team is written to in Chinese). */
  const speechLang = () => {
    const l = String(locale() ?? "");
    return /^zh\b/i.test(l) ? l : "zh-CN";
  };
  const speechError = (e: string) =>
    e === "not-allowed" || e === "service-not-allowed" ? (native ? L("No microphone or speech recognition permission. Allow it in System Settings.", "没有麦克风或语音识别权限，请在系统设置里允许") : L("No microphone permission. Allow the microphone in your browser settings.", "没有麦克风权限，请在浏览器设置里允许使用麦克风"))
      : e === "no-speech" ? L("Didn’t hear anything", "没有听到声音")
      : e === "audio-capture" ? L("No microphone found", "找不到麦克风")
      : e === "network" ? L("Speech recognition needs a network connection", "语音识别需要联网")
      : e === "language-not-supported" ? L("This device doesn’t support Chinese speech recognition", "这台设备不支持中文语音识别")
      : e === "unavailable" ? L("Voice input isn’t available on this device", "这台设备不能语音输入")
      : L("Voice input failed", "语音输入出错了");
  /** The whole transcript so far (final and still-being-heard words). */
  const heard = (text: string) => {
    if (untracked(speech) === "off") return;
    const words = text.trim();
    // a space between Latin words, none in Chinese
    const gap = /[A-Za-z0-9.,!?;:]$/.test(before) && /^[A-Za-z0-9]/.test(words) ? " " : "";
    const head = before + gap + words;
    dictated = head + after;
    draft.set(dictated);
    composer?.setSelection(head.length, head.length);
  };
  const ended = (error?: string | null) => {
    if (untracked(speech) === "off") return;
    speech.set("off");
    if (error) attachNote.set(speechError(error));
  };
  async function startDictation() {
    const v = draft();
    const start = Math.min(caret?.start ?? v.length, v.length);
    const end = Math.min(Math.max(caret?.end ?? v.length, start), v.length);
    before = v.slice(0, start);
    after = v.slice(end);
    dictated = v;
    attachNote.set(null);
    speech.set("on");
    if (native) {
      try {
        const s = Speech.start({ lang: speechLang() });
        session = s;
        s.on("result", (r) => session === s && heard(r.text));
        s.on("end", (e) => {
          if (session !== s) return;
          session = null;
          ended(e.error);
        });
      } catch {
        session = null;
        speech.set("off");
        attachNote.set(L("Couldn’t start voice input", "无法开始语音输入"));
      }
      return;
    }
    if (!(await hostCall("speechStart", { lang: speechLang() })) && untracked(speech) === "on") {
      speech.set("off");
      attachNote.set(L("Couldn’t start voice input", "无法开始语音输入"));
    }
  }
  /** Stop listening: the words still being heard arrive first, unless `drop` (the draft was sent or edited). */
  function stopDictation(drop = false) {
    if (drop) {
      speech.set("off");
      if (session) { const s = session; session = null; s.abort(); }
      else void hostCall("speechAbort");
    } else {
      speech.set("stopping");
      if (session) session.stop();
      else void hostCall("speechStop");
    }
  }
  /** The mic / stop button: start, stop (keeping the words), and if the recognizer hangs while finishing, a second press ends it. */
  const toggleDictation = () => (speech() === "off" ? void startDictation() : stopDictation(speech() === "stopping"));
  if (host.available()) {
    host.on("speech", (p) => heard(String((p as { text?: string })?.text ?? "")));
    host.on("speechEnd", (p) => ended((p as { error?: string })?.error));
  }
  cleanup(() => {
    if (untracked(speech) !== "off") stopDictation(true);
  });

  const canSend = () => !!draft().trim() || attachments().length > 0;
  const compactComposer = () => !focused() && !draft() && !attachments().length && !replyTo() && speech() === "off";
  const answer = (ref: string, c: string) => {
    clearNotification(ref);
    return send(`${ref} ${c}`, null, undefined, [], true);
  };

  function pick(ref: string) {
    drawer.set(false);
    // set before the channel comes back: entering it would otherwise scroll to the latest messages, over this card
    jumping = ref;
    atEnd.set(false);
    const back = !untracked(onChannel);
    nav.popToRoot();
    if (untracked(scope) && !untracked(shown).some((e) => e.ref === ref)) scope.set(null);
    chosen.set(ref);
    clearNotification(ref);
    // back from another page the channel lays out first
    setTimeout(() => toCard(ref, 4), back ? 120 : 0);
  }
  /** Virtualized cards can be off screen; locate the row by identity instead of measuring a view. */
  function toCard(ref: string, tries: number) {
    const at = shown().findIndex((e) => e.ref === ref && isAsk(e));
    if (at >= 0 && shown().length - at > untracked(limit)) limit.set(shown().length - at); // older than the page: show it
    const index = timeline().findIndex((row) => "event" in row && row.event.ref === ref && isAsk(row.event));
    if (index >= 0 && scroller) {
      scrollTimeline(index);
      if (jumping === ref) jumping = null;
    } else if (tries > 0 && !scroller) {
      setTimeout(() => toCard(ref, tries - 1), 80);
    } else {
      if (jumping === ref) jumping = null;
      if (pending().some((e) => e.ref === ref)) reply(ref);
    }
  }

  // Opened from a notification (`?ref=`), or one clicked while the app is open: show that event.
  let openRef = props.openRef ?? null;
  effect(() => {
    const loaded = hub.loaded();
    if (!openRef || !loaded) return;
    const ref = openRef;
    openRef = null;
    setTimeout(() => pick(ref), 300);
  });
  if (host.available()) {
    host.on("open", (p) => {
      const ref = (p as { ref?: string | null } | null)?.ref;
      if (ref) setTimeout(() => pick(ref), 50);
    });
  }
  // The app's badge and the page's title count the decisions waiting. iOS needs the permission, so it follows that too.
  effect(() => {
    const n = pending().length;
    push.info();
    if (hub.loaded()) setBadge(n);
  });
  if (systemNotifications()) {
    // A press can start the app; before the timeline loads the effect above opens it.
    cleanup(Notifications.on("press", ({ id }) => {
      if (id.startsWith("noop:")) return;
      if (untracked(hub.loaded)) setTimeout(() => pick(id), 50);
      else openRef = id;
    }));
    // Back in the app: the owner may have changed the permission in the system's settings.
    effect(() => {
      if (lifecycle() === "active") void push.refresh();
    });
    // While the app is not in front, what would reach a browser as Web Push shows as a system notification.
    let latest: string | null = null;
    effect(() => {
      const evs = hub.events();
      if (!hub.loaded()) return;
      const last = evs[evs.length - 1]?.ts ?? "";
      if (latest === null) {
        latest = last;
        return;
      }
      const since: string = latest;
      const fresh = evs.filter((e) => e.ts > since);
      if (!fresh.length) return;
      latest = last;
      if (untracked(lifecycle) === "active" || !untracked(push.info)?.subscribed) return;
      void hub.api("GET", "/api/settings").then((r) => {
        const prefs = (r.data.current as { notify_prefs?: NotifyRules } | undefined)?.notify_prefs ?? {};
        // Waking from sleep can bring many: the latest few say enough, the badge counts the rest.
        for (const e of fresh.slice(-5)) {
          const note = notificationFor(e, { ...prefs, lang: lang() });
          if (!note) continue;
          const id = e.ref ?? `noop:${e.kind}`;
          showing.add(id);
          void Notifications.show({ id, ...note, silent: true }); // Noop is quiet: the notification alone, no sound
        }
      });
    });
    // Answered, here or on another device: the notification has done its job.
    effect(() => {
      const done = answered();
      for (const id of [...showing]) if (done.has(id)) closeNotification(id);
    });
  }
  // A new decision while the app is open: a quiet toast and a short vibration.
  const toast = signal<{ ref: string; text: string } | null>(null);
  let known: Set<string> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(toastTimer));
  effect(() => {
    const asks = pending();
    if (!hub.loaded()) return;
    if (!known) {
      known = new Set(asks.map((e) => e.ref!));
      return;
    }
    const fresh = asks.filter((e) => !known!.has(e.ref!));
    for (const e of asks) known.add(e.ref!);
    if (!fresh.length) return;
    const e = fresh[fresh.length - 1];
    toast.set({ ref: e.ref!, text: e.text.split("\n")[0].replace(/[*`]/g, "").slice(0, 80) });
    hostCall("vibrate");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.set(null), 6000);
  });
  /** J / K: the next or the previous pending ask, scrolled into view. */
  function step(by: number) {
    const p = pending();
    if (!p.length) return;
    const at = p.findIndex((e) => e.ref === target());
    const next = p[Math.max(0, Math.min(p.length - 1, (at < 0 ? p.length - 1 : at) + by))];
    pick(next.ref!);
  }
  function choose(n: number) {
    const ref = target();
    const e = pending().find((x) => x.ref === ref);
    if (!e || !onChannel()) return;
    const c = choicesOf(e)[n];
    if (c) answer(e.ref!, c);
  }
  /** 记忆: from the sidebar in place; from settings on top (back returns to settings). */
  const openRules = (fromSettings = false) => {
    if (fromSettings) { drawer.set(false); nav.push({ name: "rules" }); }
    else show({ name: "rules" });
  };
  const openTeam = () => {
    if (untracked(top).name === "team") { drawer.set(false); nav.popToRoot(); }
    else show({ name: "team" });
  };
  // The tray menu counts the decisions waiting and opens the one the keys act on, or the team settings.
  effect(() => props.onTray?.({ pending: pending().length, review: () => { const ref = untracked(target); if (ref) pick(ref); }, settings: openTeam }));
  cleanup(() => props.onTray?.(null));

  // Shortcuts. Single keys never fire while typing (`notEditing`).
  keymap.bind("mod+enter", submit, { when: "always" });
  keymap.bind("mod+k", () => composer?.focus(), { when: "always" });
  keymap.bind("mod+z", () => { if (!draft()) undo(); }, { when: "always" });
  keymap.bind("mod+,", openTeam, { when: "always" });
  keymap.bind("mod+b", () => setSidebarOpen(!untracked(sidebarOpen)), { when: "always" });
  keymap.bind("mod+shift+l", toggleTheme, { when: "always" });
  keymap.bind(
    {
      "/": () => composer?.focus(),
      "shift+/": () => help.set(!untracked(help)),
      j: () => step(1),
      k: () => step(-1),
      r: () => target() && reply(target()!),
      g: jumpToEnd,
      "shift+g": jumpToEnd,
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), () => choose(i)])),
    },
    { when: "notEditing" },
  );
  // The same moves with Alt work while typing, so the cursor never has to leave the composer.
  keymap.bind(
    {
      "alt+j": () => step(1),
      "alt+k": () => step(-1),
      "alt+r": () => target() && reply(target()!),
      "alt+g": jumpToEnd,
      ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`alt+${i + 1}`, () => choose(i)])),
    },
    { when: "always" },
  );
  keymap.bind("escape", () => {
    if (help()) help.set(false);
    else if (drawer()) drawer.set(false);
    else if (replyTo()) replyTo.set(null);
    else if (focused()) composer?.blur();
    else if (nav.routes().length > 1) nav.pop();
  }, { when: "always" });

  const sidebar = (inDrawer: boolean) => (
    <Sidebar
      onRestart={() => void restartToUpdate()}
      hub={hub}
      target={target}
      onPick={pick}
      onIgnore={(ref) => void answer(ref, IGNORE)}
      task={() => { const t = top(); return t.name === "task" ? t.id : null; }}
      onTask={openTask}
      machine={() => { const t = top(); return t.name === "host" ? t.host : null; }}
      onMachine={openHost}
      onSettings={openTeam}
      rules={() => { const n = top().name; return n === "rules" || n === "doc"; }}
      onRules={() => openRules()}
      tasks={() => top().name === "tasks"}
      onTasks={() => show({ name: "tasks" })}
      channels={channels}
      channel={() => (onChannel() ? scope() : null)}
      onChannel={(slug) => openScope(slug)}
      onHelp={() => help.set(true)}
      onClose={inDrawer ? () => drawer.set(false) : undefined}
      chrome={!inDrawer}
      onCollapse={inDrawer ? undefined : () => setSidebarOpen(false)}
      home={() => onChannel() && !scope()}
      unread={() => reads.main().length}
      onReadAll={reads.all}
      onHome={() => openScope(null)}
    />
  );
  // Only a touchscreen swipes the sidebar in: a pan handler takes every mouse press on the web,
  // so dragging over a message would select nothing.
  const swipeDrawer = () => touch && !wide() && !drawer();
  /** The channel: the timeline and the composer. */
  const channelPage = () => (
    <View style={{ flex: 1, flexDirection: "row", minWidth: 0 }}>
      <View testID="channel-swipe" pan={swipeDrawer() ? { x: drawerX } : undefined}
        onPanStart={swipeDrawer() ? () => { Keyboard.dismiss(); drawerDragging.set(true); } : undefined}
        onPanEnd={swipeDrawer() ? finishDrawerPan : undefined}
        style={{ flex: 1, backgroundColor: colors.background, paddingBottom: keyboardFrame().height }}>
          <View
            testID="composer-area"
            style={{ flex: 1 }}
          >
            <List
              testID="timeline"
              each={timeline()}
              viewabilityConfig={{ minimumViewTime: 300 }}
              onViewableItemsChange={({ viewableItems }) => {
                firstVisibleRow = viewableItems.reduce((m, t) => Math.min(m, t.index ?? Infinity), Infinity);
                lastVisibleRow = viewableItems.reduce((m, t) => Math.max(m, t.index ?? -1), -1);
                visibleMessages.set(viewableItems.flatMap((t) => "event" in t.item ? [t.item.event] : []));
              }}
              alignment="bottom"
              maintainVisibleContentPosition={{ autoscrollToBottomThreshold: AT_END }}
              estimatedItemSize={120}
              contentStyle={{ paddingTop: wide() ? 24 : 12, paddingBottom: composerHeight() + 16 }}
              keyExtractor={(row) => row.key}
              ref={(r) => { scroller = r; }}
              onLayout={({ bounds }) => { timelineHeight = Math.max(1, bounds.size.height); }}
              onTouchStartCapture={() => { cancelJump(); if (platform.os === "macos" && focused()) composer?.blur(); }}
              style={{ flex: 1 }}
              scrollEventThrottle={100}
              keyboardShouldPersistTaps="handled"
              onScroll={(ev) => {
                const end = ev.contentSize.height - ev.offset.y - ev.size.height <= AT_END;
                if (end !== untracked(atEnd)) atEnd.set(end);
                if (end) unseen.set(0);
                const passed = ev.offset.y > (wide() ? 24 : 12) + CHANNEL_HEAD;
                if (passed !== untracked(headPassed)) headPassed.set(passed);
              }}
              empty={() => <View style={{ width: "100%", maxWidth: size.column + gutter() * 2, alignSelf: "center", paddingHorizontal: gutter(), paddingTop: wide() ? 24 : 12, paddingBottom: composerHeight() + 16 }}>
                <If when={!hub.loaded()}>
                  <View style={{ alignItems: "center", paddingTop: 120, gap: 14 }}>
                    <Spinner size={22} tint={colors.muted} />
                    <Text style={{ fontSize: 15, color: colors.muted }}>{L("Loading channel…", "正在载入频道…")}</Text>
                  </View>
                </If>
                <If when={hub.loaded() && shown().length === 0}>
                  <View style={{ alignItems: "center", paddingTop: wide() ? 120 : 64, paddingBottom: 32, gap: 12 }}>
                    <Mark size={44} />
                    <Text style={{ fontSize: 30, fontWeight: "600", color: colors.text, letterSpacing: -0.4 }}>{greeting()}</Text>
                    <Text style={{ fontSize: 16, lineHeight: 24, color: colors.muted, textAlign: "center" }}>{L("The team works in the background. Decisions that need you appear here.", "团队在后台运转。需要你拍板的事会出现在这里。")}</Text>
                    <If when={!touch}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
                        <Kbd keys="/" />
                        <Text style={{ fontSize: 14, color: colors.faint }}>{L("Start typing", "开始输入")}</Text>
                        <View style={{ width: 12 }} />
                        <Kbd keys="?" />
                        <Text style={{ fontSize: 14, color: colors.faint }}>{L("All shortcuts", "全部快捷键")}</Text>
                      </View>
                    </If>
                  </View>
                </If>
              </View>}
            >
              {(item) => (
                <View style={{ width: "100%", maxWidth: size.column + gutter() * 2, alignSelf: "center", paddingHorizontal: gutter() }}>
                <Each of={[item()]} key={(r) => r.key}>
                  {(r) => {
                    const row = r();
                    if ("head" in row) {
                      return (
                        <View>
                          <ChannelHeader channels={channels} slug={row.head} />
                          <If when={shown().length === 0}>
                            <View testID="channel-empty" style={{ gap: 6, paddingVertical: 16 }}>
                              <Text style={{ fontSize: 16, fontWeight: "600", color: colors.text }}>{L(`This is the start of #${scoped()?.name ?? row.head}`, `这里是 #${scoped()?.name ?? row.head} 的开始`)}</Text>
                              <Text style={{ fontSize: 14, lineHeight: 21, color: colors.muted }}>{L("Results and decisions for this topic land here. What you say here stays here, out of the main chat.", "这个话题的结果和决策会出现在这里。在这里说的话只留在这里，不进主会话。")}</Text>
                            </View>
                          </If>
                        </View>
                      );
                    }
                    if ("more" in row) {
                      return (
                        <View style={{ alignItems: "center", marginTop: 16, marginBottom: 4 }}>
                          <Button testID="timeline-more" label={L(`Load earlier messages (${row.more})`, `加载更早的消息（还有 ${row.more} 条）`)} variant="secondary" onPress={() => limit.set(untracked(limit) + PAGE)} />
                        </View>
                      );
                    }
                    if ("unread" in row) {
                      return (
                        <View testID="unread" style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16, marginBottom: 4 }}>
                          <View style={{ flex: 1, height: 1, backgroundColor: alpha(colors.danger, 0.14) }} />
                          <Text style={{ fontSize: 12, fontWeight: "500", color: alpha(colors.danger, 0.8) }}>{L("New messages", "以下为新消息")}</Text>
                          <View style={{ flex: 1, height: 1, backgroundColor: alpha(colors.danger, 0.14) }} />
                        </View>
                      );
                    }
                    if ("day" in row) {
                      return (
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 24, marginBottom: 8 }}>
                          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
                          <Text style={{ fontSize: 13, fontWeight: "500", color: colors.faint }}>{dayLabel(row.day)}</Text>
                          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
                        </View>
                      );
                    }
                    const arriving = timelineWindow.takeArrival(row.event.id) && !reduceMotion();
                    if (row.event.kind === "owner") {
                      const out = () => outbox().find((o) => o.id === row.event.id);
                      // Just sent from the composer below: the bubble rises out of the input into its place.
                      const sent = arriving && untracked(out) !== undefined;
                      const entrance = arriving ? createMotion({
                        enter: sent
                          ? { keyframes: { opacity: [0, 1], translateY: [Math.min(composerHeight(), 120), 0], scale: [0.92, 1] }, duration: 260, easing: "easeOut" }
                          : { keyframes: { opacity: [0, 1], translateY: [8, 0] }, duration: 180, easing: "easeOut" },
                      }) : undefined;
                      return <View testID={sent ? "sent-entrance" : undefined} style={[entrance?.style ?? null, { transformOrigin: "right bottom" }]}><OwnerBubble hub={hub} event={row.event} out={out()} onRetry={() => void deliver(row.event.id)} onRecall={() => undo(row.event.id)} onRef={pick} /></View>;
                    }
                    const entrance = arriving ? createMotion({
                      enter: { keyframes: { opacity: [0, 1], translateY: [8, 0] }, duration: 180, easing: "easeOut" },
                    }) : undefined;
                    return (
                      <View style={entrance?.style}>
                        <Message
                          hub={hub}
                          event={row.event}
                          answered={answered}
                          target={target}
                          onAnswer={answer}
                          onReply={reply}
                          selection={proposalSelection}
                          unread={() => reads.loaded() && !isRead(row.event, reads.state())}
                          onToggleRead={() => reads.toggle(row.event)}
                        />
                      </View>
                    );
                  }}
                </Each>
                </View>
              )}
            </List>

            <If when={!atEnd() && shown().length > 0}>
              <View style={{ position: "absolute", left: 0, right: 0, bottom: composerHeight() + 4, paddingVertical: 4, alignItems: "center", pointerEvents: "box-none" }}>
                <View
                  role="button"
                  accessibilityLabel={L("Back to bottom", "回到底部")}
                  onPress={jumpToEnd}
                  hoverStyle={{ opacity: 0.92 }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    height: 38,
                    paddingHorizontal: 16,
                    ...glass(unseen() ? colors.accentFill : colors.surface, 19),
                    backgroundColor: platform.os === "linux" || (platform.os === "android" && Number(platform.version) < 31)
                      ? (unseen() ? colors.accentFill : colors.surface)
                      : (unseen() ? alpha(colors.accentFill, 0.85) : alpha(colors.surface, 0.25)),
                    borderWidth: platform.os === "ios" || platform.os === "macos" ? 0 : 1,
                    boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
                  }}
                >
                  <Icon name="arrow-down" size={15} tint={unseen() ? colors.onAccent : colors.text} />
                  <Text style={{ fontSize: 14, fontWeight: "600", color: unseen() ? colors.onAccent : colors.text }}>
                    {unseen() ? L(`${unseen()} new messages`, `${unseen()} 条新消息`) : L("Back to bottom", "回到底部")}
                  </Text>
                  <If when={!touch}>
                    <Text style={{ fontSize: 12, color: unseen() ? alpha(colors.onAccent, 0.7) : colors.faint }}>G</Text>
                  </If>
                </View>
              </View>
            </If>

          {/* The composer floats over the timeline, which scrolls on under its glass. */}
          <View
            onLayout={({ bounds }) => composerHeight.set(bounds.size.height)}
            style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: wide() ? 32 : 10, paddingTop: 4, paddingBottom: keyboardFrame().height > 0 ? 8 : Math.max(12, safeArea().bottom + 8), pointerEvents: "box-none" }}
          >
            <View style={{ width: "100%", maxWidth: size.column, alignSelf: "center", gap: 8, pointerEvents: "box-none" }}>
              <If when={hub.conn() === "blocked"}>
                <View style={{ gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.inset, backgroundColor: colors.surface, backgroundImage: `linear-gradient(${tints.danger}, ${tints.danger})` }}>
                  <Text style={{ fontSize: 14, color: colors.danger }}>
                    {L(`This device's public IP ${hub.blockedIp()} isn't on the Worker's allow-list (HUB_ALLOW_IPS). Add it on the host; Noop reconnects by itself.`,
                      `这台设备的出口 IP ${hub.blockedIp()} 不在允许名单（HUB_ALLOW_IPS）里。在主机上把它加进去，Noop 会自动重连。`)}
                  </Text>
                  <View style={{ flexDirection: "row" }}>
                    <Button label={L("Copy IP", "复制 IP")} onPress={() => void Clipboard.writeText(hub.blockedIp())} />
                  </View>
                </View>
              </If>
              <If when={hub.conn() === "offline" || hub.conn() === "unauthorized"}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: radius.inset,
                    // over the timeline: the tint needs a solid base, or the messages show through
                    backgroundColor: colors.surface,
                    backgroundImage: `linear-gradient(${hub.conn() === "unauthorized" ? tints.danger : tints.warn}, ${hub.conn() === "unauthorized" ? tints.danger : tints.warn})`,
                  }}
                >
                  <Text style={{ flex: 1, fontSize: 14, color: hub.conn() === "unauthorized" ? colors.danger : colors.warn }}>
                    {hub.conn() === "unauthorized" ? L("Your session expired. Please sign in again.", "登录已过期，请重新登录。") : L("Lost connection to Noop. Reconnecting…", "与 Noop 的连接断开了，正在自动重连…")}
                  </Text>
                  <If when={hub.conn() === "unauthorized"}>
                    <Button label={L("Sign in again", "重新登录")} variant="danger" onPress={props.onConnection} />
                  </If>
                </View>
              </If>
              <If when={slash() != null}>
                <CommandList
                  items={commands()}
                  selected={commands().indexOf(pickedCommand()!)}
                  touch={touch}
                  onHover={(i) => cmdSel.set(i)}
                  onMove={(d) => { const n = untracked(commands).length; if (n) cmdSel.set((untracked(cmdSel) + d + n) % n); }}
                  onRun={(c) => runCommand(c)}
                  onClose={() => draft.set("")}
                  onManage={() => { draft.set(""); openTeam(); }}
                />
              </If>
              <View
                style={{
                  flexDirection: "column",
                  alignItems: "stretch",
                  overflow: "hidden",
                  gap: 6,
                  paddingTop: compactComposer() ? 4 : 12,
                  paddingBottom: compactComposer() ? 4 : (touch ? 44 : 36) + 14,
                  paddingLeft: 18,
                  paddingRight: 8,
                  ...composerGlass(focused()),
                  ...(dropping() && onChannel() ? { borderColor: colors.accent, borderStyle: "dashed" as const } : {}),
                }}
              >
                <If when={replyTo()}>
                  {(ref) => (
                    <View testID="reply-chip" style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%", height: 30, paddingLeft: 10, paddingRight: 4, borderRadius: 8, backgroundColor: tints.accent }}>
                      <Text style={{ ...chipText, flexShrink: 1, numberOfLines: 1, fontSize: 14, fontWeight: "500", color: colors.accent }}>{firstLine(replyNote() ?? shown().findLast((e) => e.ref === ref())?.text ?? ref()).replace(/\s+/g, " ").trim()}</Text>
                      <View
                        onPress={() => replyTo.set(null)}
                        role="button"
                        accessibilityLabel={L("Cancel reply", "取消回复")}
                        tooltip={<Tooltip label={L("Cancel reply", "取消回复")} shortcut="Esc" />}
                        hoverStyle={hovered()}
                        style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}
                      >
                        <Icon name="close" size={13} tint={colors.accent} />
                      </View>
                    </View>
                  )}
                </If>
                <If when={attachments().length}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 2 }}>
                    <Each of={attachments()} key={(a) => a.id}>
                      {(a) => (
                        <View testID="attachment" accessibilityLabel={a().name} style={{ width: 64, height: 64 }}>
                          <Image
                            src={a().preview}
                            style={{ width: 64, height: 64, borderRadius: radius.inset, backgroundColor: colors.inset, objectFit: "cover" }}
                          />
                          <View
                            testID="remove-attachment"
                            role="button"
                            accessibilityLabel={L(`Remove ${a().name}`, `移除 ${a().name}`)}
                            tooltip={touch ? undefined : <Tooltip label={L("Remove", "移除")} />}
                            onPress={() => unattach(a().id)}
                            hoverStyle={{ opacity: 0.85 }}
                            style={{
                              position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 11,
                              alignItems: "center", justifyContent: "center",
                              backgroundColor: colors.text,
                            }}
                          >
                            <Icon name="close" size={10} tint={colors.background} />
                          </View>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
                <If when={attachNote()}>
                  {(note) => <Text testID="attach-note" style={{ fontSize: 13, color: colors.danger }}>{note()}</Text>}
                </If>
                <Input
                  testID="composer"
                  ref={(r) => (composer = r)}
                  multiline
                  submitBehavior={touch ? "newline" : "submit"}
                  onSubmit={submit}
                  value={draft()}
                  onChange={({ value }) => {
                    draft.set(value);
                    if (untracked(speech) !== "off" && value !== dictated) stopDictation(true);
                  }}
                  onSelectionChange={({ start, end }) => (caret = { start, end })}
                  onPaste={({ files, uris }) => {
                    for (const f of files) attach(f, f.name);
                    if (uris.length) void attachUris(uris);
                  }}
                  onFocus={() => {
                    if (compactComposer() && !reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.create(180, "easeInEaseOut", "opacity"));
                    focused.set(true);
                  }}
                  onBlur={() => {
                    if (!draft() && !attachments().length && !replyTo() && !reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.create(180, "easeInEaseOut", "opacity"));
                    focused.set(false);
                  }}
                  onContentSizeChange={({ size: s }) => inputHeight.set(Math.min(220, Math.max(28, s.height)))}
                  placeholder={replyTo() ? L(`Reply to ${replyTo()}…`, `回复 ${replyTo()}…`) : scope() ? L(`Message #${scoped()?.name ?? scope()}`, `在 #${scoped()?.name ?? scope()} 里讨论…`) : wide() ? L("Tell the team what to do, e.g. review the open pull requests", "给团队下指令，例如：审查一遍待处理的 PR") : L("Tell the team what to do…", "给团队下指令…")}
                  class={platform.os === "ios" ? "placeholder:text-muted-foreground" : "placeholder:text-faint"}
                  style={{
                    height: compactComposer() ? (touch ? 44 : 36) : inputHeight(),
                    marginLeft: compactComposer() ? (touch ? 44 : 36) - 2 : 0,
                    marginRight: compactComposer() && canDictate() ? (touch ? 44 : 36) + 8 : 0,
                    minWidth: 0, fontSize: size.text, lineHeight: 24, color: colors.text,
                    paddingVertical: compactComposer() ? (touch ? 10 : 6) : 2,
                  }}
                />
                {/* Keep the toolbar and its buttons in one place in the tree as the field expands. */}
                <View style={{ position: "absolute", left: 18, right: 8, bottom: compactComposer() ? 4 : 8, flexDirection: "row", alignItems: "center", gap: 8, pointerEvents: "box-none" }}>
                  <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0, pointerEvents: "box-none" }}>
                    <View
                      testID="attach"
                      role="button"
                      accessibilityLabel={L("Add image", "添加图片")}
                      tooltip={touch ? undefined : <Tooltip label={L("Add image (or paste or drop)", "添加图片（也可粘贴或拖入）")} />}
                      onPress={() => void pickImages()}
                      hoverStyle={hovered()}
                      style={{ width: touch ? 44 : 36, height: touch ? 44 : 36, marginLeft: -8, borderRadius: touch ? 22 : 18, alignItems: "center", justifyContent: "center" }}
                    >
                      <Icon name="plus" size={touch ? 22 : 18} tint={colors.text} />
                    </View>
                    <If when={speech() !== "off"}>
                      <Text testID="dictating" style={{ fontSize: 13, color: colors.accent, numberOfLines: 1 }}>
                        {speech() === "on" ? L("Listening…", "正在听…") : L("Recognizing…", "正在识别…")}
                      </Text>
                    </If>
                  </View>
                  <If when={canDictate()}>
                    {/* a large round target beside send, unfilled so it does not compete with send; while listening it becomes a red stop in the same place */}
                    <View
                      testID="dictate"
                      role="button"
                      accessibilityLabel={speech() === "off" ? L("Voice input", "语音输入") : L("Stop voice input", "停止语音输入")}
                      accessibilityState={{ selected: speech() !== "off" }}
                      tooltip={touch ? undefined : <Tooltip label={speech() === "off" ? L("Voice input", "语音输入") : L("Stop voice input", "停止语音输入")} />}
                      onPress={toggleDictation}
                      hoverStyle={speech() === "off" ? hovered() : { opacity: 0.9 }}
                      style={{
                        width: touch ? 44 : 36,
                        height: touch ? 44 : 36,
                        borderRadius: touch ? 22 : 18,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: speech() === "off" ? undefined : tints.danger,
                        transitionProperty: "background-color",
                        transitionDuration: 120,
                      }}
                    >
                      <Icon name={speech() === "off" ? "mic" : "stop"} size={speech() === "off" ? (touch ? 22 : 19) : (touch ? 18 : 16)} tint={speech() === "off" ? colors.text : colors.danger} />
                    </View>
                  </If>
                  <If when={!compactComposer()}>
                    <IconButton variant="primary" icon="arrow-up" label={L("Send", "发送")} shortcut="Enter" testID="send" disabled={!canSend()} onPress={submit} />
                  </If>
                </View>
              </View>
            </View>
          </View>
          </View>
      </View>
    </View>
  );
  /** Any page with report cards (the channel, a task) gets the same reader beside it, or over it on a phone. */
  const withReader = (page: JSX.Element) => (
    <View style={{ flex: 1, flexDirection: "row", minWidth: 0 }}>
      {page}
      {/* room for the reader, which `docSide` draws over the page's bar up to the window's top edge */}
      <If when={shownDoc() && readerSide()}>
        <View style={{ width: readerWidth() }} />
      </If>
      <If when={shownDoc() && !readerSide()}>
        <View testID="doc-sheet" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, paddingBottom: safeArea().bottom, backgroundColor: colors.background }}>{readerPane()}</View>
      </If>
    </View>
  );

  const gutter = () => (wide() ? 32 : 16);
  const titleOf = (r: Route): string => {
    switch (r.name) {
      case "channel": return scope() ? `# ${scoped()?.name ?? scope()}` : L("Channel", "主会话");
      case "team": return wide() ? L("Team settings", "团队设置") : L("Settings", "设置");
      case "task": return L(`Task ${r.id}`, `任务 ${r.id}`);
      case "tasks": return L("All tasks", "全部任务");
      case "host": return L(`Machine ${r.host}`, `机器 ${r.host}`);
      case "notify": return L("Notifications", "通知");
      case "member": return displayName(r.id);
      case "routine": return r.routine;
      case "rules": return L("Memory", "记忆");
      case "doc": return r.path.split("/").pop()!.replace(/\.md$/i, "");
    }
  };
  /** The back button's label, the page below's short name. */
  const backTitle = (r: Route | undefined) => (!r ? "" : r.name === "channel" ? L("Channel", "主会话") : r.name === "team" ? L("Settings", "设置") : r.name === "host" ? L("Machines", "机器") : r.name === "rules" ? L("Memory", "记忆") : r.name === "tasks" ? L("All tasks", "全部任务") : titleOf(r));
  const below = (r: Route) => { const rs = nav.routes(); const i = rs.indexOf(r); return i > 0 ? rs[i - 1] : undefined; };
  /** A folded page's compact title in its bar: pressing it scrolls back to the head. Centered in two lines in a phone's system header. */
  const FoldedTitle = (p: { folded: Folded; stacked?: boolean }) => (
    <View
      testID="page-title-folded"
      role="button"
      accessibilityLabel={L(`${p.folded.title}, back to the top`, `${p.folded.title}，回到顶部`)}
      onPress={() => p.folded.reveal()}
      style={p.stacked
        ? { minWidth: 0, maxWidth: "100%", alignItems: platform.os === "ios" ? "center" : "flex-start" }
        : { flexShrink: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}
    >
      <Text style={{ flexShrink: 1, minWidth: 0, maxWidth: "100%", fontSize: 16, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{p.folded.title}</Text>
      <If when={p.folded.detail}>
        <Text testID="page-title-detail" style={{ flexShrink: 4, minWidth: 0, maxWidth: "100%", fontSize: p.stacked ? 12.5 : 13.5, color: colors.muted, numberOfLines: 1 }}>{p.folded.detail}</Text>
      </If>
    </View>
  );
  /** The page header on desktops and the web; phones use the system header. */
  const Bar = (p: { route: Route }) => (
    <View
      desktop={{ windowDrag: true }}
      onTouchStartCapture={() => { if (platform.os === "macos" && focused()) composer?.blur(); }}
      style={{
        height: size.bar,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingLeft: (wide() && sidebarOpen() ? 0 : hasWindow ? titleBar().left : 0) + (wide() ? 24 : 8),
        // the reader beside the chat takes the bar's right end and the window buttons with it
        paddingRight: (docSide() ? readerWidth() : hasWindow ? titleBar().right : 0) + (wide() ? 16 : 8),
        borderBottomWidth: 0.5,
        borderBottomColor: surfaceEdge(),
        backgroundColor: colors.background,
      }}
    >
      <If when={!wide() && p.route === CHANNEL}>
        <IconButton icon="menu" label={L("Menu", "菜单")} onPress={() => drawer.set(true)} />
      </If>
      <If when={wide() && !sidebarOpen()}>
        <IconButton icon="sidebar" label={L("Show sidebar", "显示侧栏")} shortcut={keymap.label("mod+b")} onPress={() => setSidebarOpen(true)} />
      </If>
      <If when={below(p.route)}>
        {(b) => (
          <View
            role="button"
            accessibilityLabel={L(`Back to ${backTitle(b())}`, `返回${backTitle(b())}`)}
            onPress={() => nav.pop()}
            hoverStyle={hovered()}
            style={{ height: touch ? 44 : 32, flexDirection: "row", alignItems: "center", gap: 2, paddingLeft: 4, paddingRight: 10, borderRadius: radius.control, borderCurve: "continuous" }}
          >
            <Icon name="back" size={18} tint={colors.accent} />
            <Text style={{ fontSize: 15, fontWeight: "500", color: colors.accent }}>{backTitle(b())}</Text>
          </View>
        )}
      </If>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
        <If when={folded(p.route)} else={<Text testID="page-title" style={{ fontSize: 16, fontWeight: "600", color: colors.text, numberOfLines: 1 }}>{titleOf(p.route)}</Text>}>
          {(f) => <FoldedTitle folded={f()} />}
        </If>
      </View>
      <If when={p.route === CHANNEL && !shownDoc() && latestDoc()}>
        <IconButton icon="document" label={L("Open latest report", "打开最新报告")} onPress={() => { const d = latestDoc(); reading.set(d && { ...d, at: readerAt() }); }} testID="doc-reopen" />
      </If>
      <If when={!wide() && p.route === CHANNEL}>
        <IconButton icon="sliders" label={L("Settings", "设置")} onPress={openTeam} testID="settings-top" />
      </If>
    </View>
  );
  const content = (r: Route) => {
    switch (r.name) {
      case "channel": return withReader(channelPage());
      case "task": return withReader(<TaskDetail hub={hub} id={r.id} wide={wide()} onFold={(f) => taskFolds.update((m) => ({ ...m, [r.id]: f }))} />);
      case "tasks": return <TaskHistory hub={hub} wide={wide()} onTask={openTask} />;
      case "host": return <MachineDetail hub={hub} host={r.host} wide={wide()} onTask={openTask} />;
      case "team":
        return (
          <If
            when={wide()}
            else={<PhoneSettings hub={hub} push={push} settings={settings} onOpen={(x) => nav.push(x)} onDisconnect={props.onDisconnect} />}
          >
            <TeamSettings hub={hub} push={push} settings={settings} wide={wide()} onRules={() => openRules(true)} onConnection={props.onConnection} onDisconnect={props.onDisconnect} />
          </If>
        );
      case "notify": return <PhoneNotify push={push} settings={settings} />;
      case "member": return <PhoneMember id={r.id} settings={settings} />;
      case "routine": return <PhoneRoutine name={r.routine} settings={settings} />;
      case "rules": return <RulesList hub={hub} onOpen={(path) => nav.push({ name: "doc", path })} />;
      case "doc": return <RuleDoc hub={hub} path={r.path} wide={wide()} />;
    }
  };

  return (
    <View
      testID="drop-window"
      onFileDragEnter={(e?: { uris?: string[] }) => dropping.set(e?.uris ?? [])}
      onFileDragLeave={() => dropping.set(null)}
      onFileDrop={({ uris }) => {
        dropping.set(null);
        // files land in the chat composer: from a task or doc page, go back to the chat first
        if (!onChannel()) nav.popToRoot();
        void attachUris(uris);
      }}
      style={{ flex: 1, flexDirection: "row", backgroundColor: colors.sidebar, overflow: "hidden" }}
    >
      <If when={platform.os === "macos" && wide() && sidebarOpen()}>
        <View style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: size.sidebar + 20, ...glass(colors.sidebar, 0), backgroundColor: alpha(colors.sidebar, 0.25), borderWidth: 0, boxShadow: "none", pointerEvents: "none" }} />
      </If>
      <If when={wide() && sidebarOpen()}>
        <View onTouchStartCapture={() => { if (platform.os === "macos" && focused()) composer?.blur(); }} style={{ width: size.sidebar, paddingTop: sidebarInset }}>{sidebar(false)}</View>
      </If>
      <If when={!wide()}>
        <View testID="drawer" pan={drawer() ? { x: drawerX } : undefined} onPanStart={() => { Keyboard.dismiss(); drawerDragging.set(true); }} onPanEnd={finishDrawerPan} style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: drawerWidth(), paddingTop: touch ? safeArea().top : 0, visibility: drawerVisible() || drawerDragging() ? "visible" : "hidden", pointerEvents: drawer() ? "auto" : "none" }}>{sidebar(true)}</View>
      </If>
      <View style={{ flex: 1, minWidth: 0, backgroundColor: colors.background, borderTopLeftRadius: wide() && sidebarOpen() ? 20 : 0, borderBottomLeftRadius: wide() && sidebarOpen() ? 20 : 0, borderCurve: "continuous", borderLeftWidth: !wide() && (drawer() || drawerDragging()) ? 1 : 0, borderLeftColor: colors.line, overflow: "hidden", translate: [wide() ? 0 : drawerTranslate(), 0], boxShadow: wide() && sidebarOpen() ? "-3px 0 18px rgba(0,0,0,0.08)" : undefined }}>
      <NavStack state={nav} testID="pages" style={{ flex: 1, minWidth: 0 }}>
        {(route, index) => (
          <NavPage
            testID={`page-${route.name}`}
            // with the sidebar beside it, a page picked there replaces the view at once; only a page opened from a page slides in
            animation={wide() && index() <= 1 ? "none" : "default"}
            title={titleOf(route)}
            header={systemHeader ? undefined : <Bar route={route} />}
            headerBackTitle={backTitle(route)}
            headerLeft={systemHeader && route === CHANNEL && !wide() ? <IconButton icon="menu" label={L("Menu", "菜单")} onPress={() => drawer.set(true)} /> : undefined}
            ios={{ headerLeftSymbol: "sidebar.left", headerRightSymbol: "gearshape" }}
            headerTitle={
              // phones: a folded page's compact title replaces the system title until its head is back in sight
              systemHeader && folded(route) ? <FoldedTitle folded={folded(route)!} stacked /> : undefined
            }
            headerRight={systemHeader && route === CHANNEL ? <IconButton icon="sliders" label={L("Settings", "设置")} onPress={openTeam} testID="settings-top" /> : undefined}
            style={{ backgroundColor: colors.background }}
          >
            {content(route)}
          </NavPage>
        )}
      </NavStack>
      <If when={docSide()}>
        <View testID="doc-side" style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: readerWidth(), borderLeftWidth: 0.5, borderColor: surfaceEdge(), backgroundColor: colors.background }}>{readerPane()}</View>
      </If>
      <If when={!wide() && drawer()}>
        <View testID="drawer-dismiss" role="button" accessibilityLabel={L("Close sidebar", "关闭侧栏")} onPress={() => drawer.set(false)} pan={{ x: drawerX }} onPanStart={() => { Keyboard.dismiss(); drawerDragging.set(true); }} onPanEnd={finishDrawerPan} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.08)" }} />
      </If>
      </View>

      <SettingsToast state={settings.toast} />
      <If when={toast()}>
        {(t) => (
          <Overlay style={{ top: touch ? safeArea().top + 8 : size.bar + 10, left: 0, right: 0, alignItems: "center", paddingHorizontal: 12, pointerEvents: "box-none" }}>
            <ToastStack placement="topCenter" onCancel={() => toast.set(null)}
              motion={reduceMotion() ? { duration: 0 } : undefined}
              style={{ width: "100%", maxWidth: 520 }}>
              <Toast testID="decision-notification" transitionStatus="present" swipeDirection="up"
                accessibilityLabel={L(`New decision ${t().ref}: ${t().text}`, `新决策 ${t().ref}：${t().text}`)}
                onDismissRequest={() => toast.set(null)}
                style={{ width: "100%", flexDirection: "row", alignItems: "flex-start", borderRadius: radius.card,
                  borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.12)" }}>
                <BaseButton testID="toast" accessibilityLabel={L(`View ${t().ref}`, `查看 ${t().ref}`)}
                  class="focus-visible:ring-2 focus-visible:ring-ring active:opacity-70"
                  onPress={() => {
                    const ref = t().ref;
                    toast.set(null);
                    pick(ref);
                  }}
                  style={{ flex: 1, minWidth: 0, minHeight: 44, padding: 12, alignItems: "stretch", gap: 4 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Indicator status="waiting" />
                    <Text style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: "600", color: colors.muted, numberOfLines: 1 }}>
                      {L(`New decision ${t().ref}`, `新决策 ${t().ref}`)}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 16, color: colors.text, numberOfLines: 2 }}>{shortGitHubRefs(t().text)}</Text>
                </BaseButton>
                <BaseButton testID="dismiss-decision-notification" accessibilityLabel={L("Dismiss notification", "关闭通知")}
                  onPress={() => toast.set(null)} class="focus-visible:ring-2 focus-visible:ring-ring active:opacity-70"
                  style={{ width: 44, height: 44, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
                  <Icon name="close" size={16} tint={colors.muted} />
                </BaseButton>
              </Toast>
            </ToastStack>
          </Overlay>
        )}
      </If>

      <If when={helpOpened()}>
        <HelpSheet open={help()} onClose={() => help.set(false)} />
      </If>
      <If when={dropping()}>
        {(files) => <DropTarget files={files()} />}
      </If>
    </View>
  );
}

/** What a file drag over the window shows: the whole window becomes the target, saying what the drop will do. */
function DropTarget(props: { files: string[] }) {
  const names = () => props.files.map((u) => { const n = u.split(/[\\/]/).pop() ?? ""; try { return decodeURIComponent(n); } catch { return n; } });
  const images = () => names().filter((n) => imageType(undefined, n)).length;
  const detail = () => {
    const n = names().length;
    if (n === 0) return L("Images are added to the message", "图片会添加到消息中");
    if (images() === 0) return L("Only images can be sent", "只能发送图片");
    if (images() < n) return L(`${images()} of ${n} files are images`, `${n} 个文件中有 ${images()} 张图片`);
    return n === 1 ? names()[0] : L(`${n} images`, `${n} 张图片`);
  };
  const ok = () => names().length === 0 || images() > 0;
  return (
    <View testID="drop-target" style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, padding: 12, pointerEvents: "none" }}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, borderRadius: 20, borderCurve: "continuous", borderWidth: 2, borderStyle: "dashed", borderColor: ok() ? colors.accent : colors.faint, backgroundColor: alpha(colors.background, 0.88) }}>
        <View style={{ width: 56, height: 56, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: ok() ? tints.accent : colors.raised }}>
          <Icon name="image" size={28} tint={ok() ? colors.accent : colors.muted} />
        </View>
        <Text style={{ fontSize: 17, fontWeight: "600", color: colors.text }}>{L("Drop to attach", "松开以添加附件")}</Text>
        <Text testID="drop-detail" style={{ fontSize: 14, color: colors.muted, numberOfLines: 1, maxWidth: 360 }}>{detail()}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- connect


const RESEND = 60;

async function postJson(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("unreachable");
  }
  let data: Record<string, unknown> = {};
  try {
    data = ((await r.json()) ?? {}) as Record<string, unknown>;
  } catch {
    /* no body */
  }
  return { status: r.status, data };
}

/** Login: the email gets a one-time code. On the web served by the hub the server is the page's own origin. */
function Login(props: { url: string; served: boolean; email: string; notice?: string; onLogin: (c: Config) => void }) {
  const url = signal(props.url);
  const editUrl = signal(!props.served);
  const email = signal(props.email);
  const code = signal("");
  const totp = signal(""); // the authenticator app's 6 digits: every sign-in needs it (bound on the host: noop 2fa setup)
  const step = signal<"email" | "code">("email");
  const error = signal(props.notice ?? "");
  const busy = signal(false);
  const wait = signal(0);
  let timer: ReturnType<typeof setInterval> | undefined;
  cleanup(() => clearInterval(timer));
  const server = () => normalizeUrl(url());
  const unreachable = () => L(`Can’t reach ${server()}. Check the address and your network.`, `连不上服务器 ${server()}，请检查地址和网络`);

  const viaCli = signal(false); // email not set up yet: the code is shown by `noop login` on the owner's machine
  async function sendCode() {
    const e = email().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return error.set(L("Enter a valid email address", "请填写有效的邮箱地址"));
    if (!server()) return error.set(L("Enter the server address", "请填写服务器地址"));
    busy.set(true);
    error.set("");
    try {
      const r = await postJson(`${server()}/api/auth/start`, { email: e });
      if (r.status === 429) throw new Error(String(r.data.error ?? L("Too many requests. Try again later.", "请求太频繁，请稍后再试")));
      const ip = ipBlocked(r.status, r.data);
      if (ip) throw new Error(L(`This device's public IP ${ip} isn't on the allow-list (HUB_ALLOW_IPS). Add it on the host, then try again.`, `这台设备的出口 IP ${ip} 不在允许名单（HUB_ALLOW_IPS）里，在主机上加进去后再试。`));
      if (r.data.error === "totp_not_setup") throw new Error(L("Two-step verification isn’t set up yet, so nobody can sign in. Run noop 2fa setup on your host first.", "还没有绑定两步验证，任何人都无法登录：先在你的主机上运行 noop 2fa setup"));
      if (r.status === 403) throw new Error(L("This email isn’t allowed to sign in", "这个邮箱不允许登录"));
      if (r.status === 503) throw new Error(L("The server can’t send email yet, so email sign-in isn’t available", "服务器还没有配置发信，暂时无法用邮箱登录"));
      if (r.status >= 400) throw new Error(L(`The server returned ${r.status}. This address may not be a noop server.`, `服务器返回 ${r.status}，这个地址可能不是 noop`));
      await Storage.setItem(KEYS.email, e);
      viaCli.set(r.data.delivery === "cli");
      code.set("");
      step.set("code");
      wait.set(RESEND);
      clearInterval(timer);
      timer = setInterval(() => {
        wait.update((w) => Math.max(0, w - 1));
        if (untracked(wait) === 0) clearInterval(timer);
      }, 1000);
    } catch (err) {
      error.set(err instanceof Error && err.message !== "unreachable" ? err.message : unreachable());
    } finally {
      busy.set(false);
    }
  }

  async function verify() {
    const c = code().toUpperCase().replace(/[^A-Z0-9]/g, ""), t = totp().replace(/\D/g, "");
    if (c.length !== CODE_LEN || t.length !== 6 || busy()) return;
    busy.set(true);
    error.set("");
    try {
      const r = await postJson(`${server()}/api/auth/verify`, { email: email().trim(), code: c, totp: t });
      if (r.status === 401) throw new Error(typeof r.data.error === "string" ? r.data.error : L("The code is wrong or expired. Enter it again.", "验证码不对或已过期，请重新输入"));
      if (r.status === 403 && typeof r.data.error === "string") throw new Error(r.data.error);
      if (r.status === 429) throw new Error(String(r.data.error ?? L("Too many attempts. Try again later.", "尝试太频繁，请稍后再试")));
      if (r.status >= 400 || typeof r.data.session !== "string") throw new Error(L(`The server returned ${r.status}`, `服务器返回 ${r.status}`));
      await Storage.setItem(KEYS.url, server());
      await Storage.setItem(KEYS.token, r.data.session);
      props.onLogin({ url: server(), token: r.data.session });
    } catch (err) {
      totp.set(""); // a TOTP is good for 30 s: retype it; the email code stays (it survives a wrong TOTP)
      error.set(err instanceof Error && err.message !== "unreachable" ? err.message : unreachable());
    } finally {
      busy.set(false);
    }
  }
  const onCode = (v: string) => {
    const c = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);
    code.set(c);
    if (c.length === CODE_LEN && totp().length === 6) verify();
  };
  const onTotp = (v: string) => {
    const t = v.replace(/\D/g, "").slice(0, 6);
    totp.set(t);
    if (t.length === 6 && code().length === CODE_LEN) verify();
  };

  return (
    <Scroll style={{ flex: 1, backgroundColor: colors.background }} keyboardShouldPersistTaps="handled">
      <View style={{ minHeight: windowSize().height - (touch ? safeArea().top : 0), alignItems: "center", justifyContent: "center", paddingHorizontal: 16, paddingTop: 48, paddingBottom: 48 }}>
        <View style={{ width: "100%", maxWidth: 440, gap: 24 }}>
          <View style={{ alignItems: "center", gap: 12 }}>
            <Mark size={48} />
            <Text style={{ fontSize: 28, fontWeight: "600", color: colors.text, letterSpacing: -0.3 }}>{L("Sign in to Noop", "登录 Noop")}</Text>
            <Text style={{ fontSize: 15.5, lineHeight: 23, color: colors.muted, textAlign: "center" }}>
              {step() === "email" ? L("Sign in with email. We’ll send you an 8-character code.", "用邮箱登录：我们会发一个 8 位验证码给你（字母和数字）。") : viaCli() ? L("Email isn’t set up yet. Run noop login in your host’s terminal to see the code.", "还没配置发信邮箱：在你的主机终端运行 noop login 查看验证码。") : L(`We sent a code to ${email().trim()}. Check your email.`, `验证码已发到 ${email().trim()}，请查收邮件。`)}
            </Text>
          </View>
          <View style={{ gap: 18, padding: 22, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
            <If
              when={step() === "code"}
              else={
                <>
                  <Field
                    label={L("Email", "邮箱")}
                    value={email()}
                    onChange={(v) => email.set(v)}
                    onSubmit={sendCode}
                    placeholder="you@example.com"
                    keyboardType="email-address"
                    autoComplete="email"
                    autoFocus
                    testID="email"
                  />
                  <If
                    when={editUrl()}
                    else={
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Indicator status="online" />
                        <Text style={{ flex: 1, fontSize: 14, color: colors.muted, numberOfLines: 1 }}>{L(`Server: ${server()}`, `服务器：${server()}`)}</Text>
                        <View role="button" accessibilityLabel={L("Change server", "更改服务器")} onPress={() => editUrl.set(true)} hoverStyle={hovered()} style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}>
                          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.accent }}>{L("Change", "更改")}</Text>
                        </View>
                      </View>
                    }
                  >
                    <Field label={L("Server address", "服务器地址")} value={url()} onChange={(v) => url.set(v)} onSubmit={sendCode} placeholder={L("https://noop.<your-account>.workers.dev", "https://noop.<你的账号>.workers.dev")} keyboardType="url" testID="url" hint={L("Your noop address. It’s shown after install, or run noop status --brief on the host.", "你的 noop 地址：安装完成时显示，也可以在主机上运行 noop status --brief 查看")} />
                  </If>
                </>
              }
            >
              <Field
                label={L("Code", "验证码")}
                value={code()}
                onChange={onCode}
                onSubmit={verify}
                placeholder="········"
                autoComplete="one-time-code"
                autoFocus
                big
                testID="code"
              />
              <Field
                label={L("Authenticator code", "两步验证码（验证器 App）")}
                value={totp()}
                onChange={onTotp}
                onSubmit={verify}
                placeholder="······"
                keyboardType="number-pad"
                big
                testID="totp"
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View role="button" accessibilityLabel={L("Use another email", "换个邮箱")} onPress={() => { step.set("email"); error.set(""); }} hoverStyle={hovered()} style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}>
                  <Text style={{ fontSize: 14, color: colors.muted }}>{L("‹ Use another email", "‹ 换个邮箱")}</Text>
                </View>
                <View style={{ flex: 1 }} />
                <View
                  role="button"
                  testID="resend"
                  accessibilityLabel={L("Resend", "重新发送")}
                  accessibilityState={{ disabled: wait() > 0 }}
                  onPress={() => wait() === 0 && !busy() && sendCode()}
                  hoverStyle={wait() ? undefined : hovered()}
                  style={{ height: 30, justifyContent: "center", paddingHorizontal: 8, borderRadius: 6 }}
                >
                  <Text style={{ fontSize: 14, fontWeight: "500", color: wait() ? colors.faint : colors.accent, fontVariant: ["tabular-nums"] }}>
                    {wait() ? L(`Resend (${wait()}s)`, `重新发送（${wait()}s）`) : L("Resend", "重新发送")}
                  </Text>
                </View>
              </View>
            </If>
            <If when={error()}>
              <View style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.control, backgroundColor: tints.danger }}>
                <Text testID="login-error" style={{ fontSize: 14, lineHeight: 20, color: colors.danger }}>{error()}</Text>
              </View>
            </If>
            <If
              when={step() === "code"}
              else={<Button testID="send-code" label={busy() ? L("Sending…", "发送中…") : L("Send code", "发送验证码")} variant="primary" loading={busy()} grow onPress={sendCode} />}
            >
              <Button testID="verify" label={busy() ? L("Signing in…", "登录中…") : L("Sign in", "登录")} variant="primary" loading={busy()} disabled={code().length !== CODE_LEN || totp().length !== 6} grow onPress={verify} />
            </If>
          </View>
        </View>
      </View>
    </Scroll>
  );
}

// ---------------------------------------------------------------- app

function Connected(props: { config: Config; openRef: string | null; onExpired: () => void; onLogout: () => void; onTray: (chat: TrayChat | null) => void }) {
  const hub = createHub(props.config);
  cleanup(hub.dispose);
  // The service worker answers decisions from notifications with the session.
  hostCall("setSession", { session: props.config.token, origin: props.config.url });
  // A 401 on any call: the session is gone, back to the login.
  effect(() => {
    if (hub.conn() === "unauthorized") props.onExpired();
  });
  return (
    <Chat
      hub={hub}
      openRef={props.openRef}
      onConnection={props.onExpired}
      onTray={props.onTray}
      onDisconnect={async () => {
        const off = await hostCall<{ endpoint: string | null }>("pushDisable");
        if (off?.endpoint) await hub.api("POST", "/api/push/unsubscribe", { endpoint: off.endpoint });
        await hostCall("setSession", { session: null });
        for (const id of [...showing]) closeNotification(id);
        setBadge(0);
        await hub.logout();
        clearDocCache();
        props.onLogout();
      }}
    />
  );
}

function App() {
  if (hasWindow) {
    currentWindow().set({ title: "Noop", titleBar: { style: "hidden", height: size.bar } });
  }
  Scrollbar.setTheme(scrollbarTheme);
  watchUpdates();
  const trayChat = signal<TrayChat | null>(null);
  setupTray(trayChat);
  const ready = signal(false);
  const config = signal<Config | null>(null);
  const url = signal("");
  const served = signal(false);
  const email = signal("");
  const notice = signal("");
  let openRef: string | null = null;
  loadConfig().then((r) => {
    openRef = r.ref;
    config.set(r.config);
    url.set(r.config?.url ?? r.suggested);
    served.set(r.served);
    email.set(r.email);
    ready.set(true);
  });
  async function forget(message: string) {
    await Storage.removeItem(KEYS.token);
    email.set((await Storage.getItem(KEYS.email)) ?? untracked(email));
    notice.set(message);
    config.set(null);
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: touch && !(systemHeader && config()) ? safeArea().top : 0 }}>
      <If when={ready()}>
        <If
          when={config()}
          else={
            <Login
              url={url()}
              served={served()}
              email={email()}
              notice={notice()}
              onLogin={(c) => {
                notice.set("");
                url.set(c.url);
                config.set(c);
              }}
            />
          }
        >
          {(c) => <Connected config={c()} openRef={openRef} onExpired={() => forget(L("Your session expired. Please sign in again.", "登录已过期，请重新登录"))} onLogout={() => forget("")} onTray={(chat) => trayChat.set(chat)} />}
        </If>
      </If>
    </View>
  );
}

mount(App);
