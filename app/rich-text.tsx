// Message Markdown: the hub's text made into a TextView document (task chips, GitHub refs as links).
import { openUrl, Text, token, View, type ViewStyle } from "nsh";
import { TextView, type MarkdownExtension, type TextViewBlock, type TextViewCustomNode, type TextViewInline } from "nsh/base";
import { L } from "./i18n";
import { alpha, colors, corner, size } from "./ui";
import { linkColor, MONO, STATE_OF } from "./kit";
import { hubMarkdown } from "./markdown";

/** Opens a task's page from a T-0000 in any text (set by the channel). */
let taskLink: (id: string) => void = () => {};

/** A task's state from the hub's status (set by the channel), for the chips' dots. */
let taskState: (id: string) => string | undefined = () => undefined;

/** The app's syntax in messages (`extensions`, `pattern`): task ids and decision / proposal ids, shown by `renderCustom`. */
const EXTENSIONS: MarkdownExtension[] = [
  // ids minted on a non-primary host carry its letter (T-M0001, D-H0002)
  { name: "task", pattern: "\\bT-[A-Z]?\\d{4}\\b" },
  { name: "item", pattern: "\\b[DP]-[A-Z]?\\d{4}\\b" },
];
/**
 * An id inside a file path ("tasks/done/T-0930.md", "T-0930/notes") names the file, not the task: it stays plain
 * text, so the path reads and copies whole. The patterns cannot see past the match (Rust's `regex` has no
 * lookaround), so this looks at the text on either side of each chip.
 */
function pathInlines(inlines: TextViewInline[]): TextViewInline[] {
  const out: TextViewInline[] = [];
  const text = (t: string) => {
    const prev = out[out.length - 1];
    if (prev?.type === "text") out[out.length - 1] = { ...prev, text: prev.text + t };
    else out.push({ type: "text", text: t });
  };
  inlines.forEach((i, k) => {
    if (i.type === "custom" && (i.name === "task" || i.name === "item")) {
      const prev = out[out.length - 1];
      const next = inlines[k + 1];
      const before = prev?.type === "text" ? prev.text : "";
      const after = next?.type === "text" ? next.text : "";
      if (/[\w.-]\/$/.test(before) || /^(\.\w|\/[\w.-])/.test(after)) return text(i.text ?? "");
    }
    if (i.type === "text") return text(i.text);
    out.push("content" in i && Array.isArray(i.content) ? ({ ...i, content: pathInlines(i.content) } as TextViewInline) : i);
  });
  return out;
}
const GH = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)\/?$/;

/** A bare GitHub PR or issue link reads as "nsh#747": still a plain link, not a chip (GFM autolinks bare URLs). */
function ghInlines(inlines: TextViewInline[]): TextViewInline[] {
  return inlines.map((i): TextViewInline => {
    if (i.type === "link") {
      const m = i.url.match(GH);
      const bare = i.content.length === 1 && i.content[0].type === "text" && i.content[0].text.replace(/\/$/, "") === i.url.replace(/\/$/, "");
      return m && bare ? { ...i, content: [{ type: "text", text: `${m[2]}#${m[4]}` }] } : i;
    }
    return "content" in i && Array.isArray(i.content) ? ({ ...i, content: ghInlines(i.content) } as TextViewInline) : i;
  });
}
/** A link's target, so ".../pull/12" and ".../issues/12" (what "nsh #12" links to) count as the same one. */
const linkKey = (url: string) => { const m = url.match(GH); return m ? `${m[1]}/${m[2]}#${m[4]}`.toLowerCase() : url.replace(/\/$/, ""); };
const inlineText = (i: TextViewInline): string => ("text" in i && typeof i.text === "string" ? i.text : "content" in i && Array.isArray(i.content) ? i.content.map(inlineText).join("") : "");
/**
 * A paragraph gives each link once: a later link to the same target is dropped when it is only the bare URL
 * ("NSH #1394 https://github.com/longbridge/nsh/pull/1394"), and otherwise keeps its words as plain text.
 */
function onceInlines(inlines: TextViewInline[], seen = new Set<string>()): TextViewInline[] {
  const out: TextViewInline[] = [];
  for (const i of inlines) {
    if (i.type === "link") {
      const key = linkKey(i.url);
      if (!seen.has(key)) { seen.add(key); out.push(i); continue; }
      const words = inlineText(i);
      if (words.replace(/\/$/, "") === i.url.replace(/\/$/, "")) {
        // drop the repeat with the space that joined it
        const prev = out[out.length - 1];
        if (prev?.type === "text") out[out.length - 1] = { ...prev, text: prev.text.replace(/[ \t]+$/, "") };
        continue;
      }
      out.push(...i.content);
      continue;
    }
    out.push("content" in i && Array.isArray(i.content) ? ({ ...i, content: onceInlines(i.content, seen) } as TextViewInline) : i);
  }
  return out;
}
function ghBlocks(blocks: TextViewBlock[]): TextViewBlock[] {
  return blocks.map((b): TextViewBlock => {
    const x = { ...b } as Record<string, unknown>;
    if (Array.isArray(x.content)) x.content = ghInlines(onceInlines(pathInlines(x.content as TextViewInline[])));
    if (Array.isArray(x.children)) x.children = ghBlocks(x.children as TextViewBlock[]);
    if (Array.isArray(x.items)) x.items = (x.items as { children: TextViewBlock[] }[]).map((it) => ({ ...it, children: ghBlocks(it.children) }));
    return x as TextViewBlock;
  });
}

/** Repositories the channel has linked so far, by name ("nsh" → "longbridge/nsh"; set by the channel). */
let knownRepos: () => Map<string, string> = () => new Map();

/** Every repository a GitHub link in `text` names, by lower-cased name. */
export function reposIn(text: string, into = new Map<string, string>()): Map<string, string> {
  for (const m of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/\d+/g)) into.set(m[2].toLowerCase(), `${m[1]}/${m[2]}`);
  return into;
}

const REF = /(^|[^\w\/\[#&])(?:([A-Za-z][\w.-]*)( ?))?#(\d+)\b/g;
/** A word before "#N" naming a repository, not what the ref is: "docs#3", "video-tool #2" (not "PR #3", "and #4"). */
const repoWord = (name: string, sp: string) => !/^(pr|issue)s?$/i.test(name) && (!sp || /[-_.\d]/.test(name));
/** A line's or clause's label ("docs：#12", "- web-app: ..."), not a URL's scheme. */
const LABEL = /(?:^|[\n。；;，,])[\s*+\-\d.)]*([A-Za-z][\w.-]*)\**\s*[:：](?!\/\/)/g;

/**
 * A "#746" is a GitHub PR or issue: "nsh #747" / "NSH#747" links to that repository when the channel has linked it
 * before; a bare "#747" to the one repository the message, or what it is about (`context`: a card's options, the
 * thread it belongs to), names. Code spans and existing Markdown links are left alone.
 */
function linkRepoRefs(text: string, context = ""): string {
  const known = reposIn(`${text}\n${context}`, new Map(knownRepos()));
  if (!known.size) return text;
  // the repositories in play: linked ones, and "name#N" naming a known one
  const named = new Set<string>([...reposIn(`${text}\n${context}`).values()]);
  for (const m of `${text}\n${context}`.matchAll(REF)) {
    const slug = m[2] && known.get(m[2].toLowerCase());
    if (slug) named.add(slug);
  }
  const only = named.size === 1 ? [...named][0] : null;
  // where each known repository is named in the text ("NSH：", "GPUI Kit", "nsh#1", a link): a bare "#N" belongs to the
  // closest one before it, so a per-project summary links each line's refs to its own project
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [...known.keys()].sort((a, b) => b.length - a.length);
  const mention = new RegExp(`(?<![\\w-])(${names.map((k) => esc(k).replace(/[-_]/g, "[-_ ]?")).join("|")})(?![\\w-])`, "gi");
  const flat = (k: string) => k.toLowerCase().replace(/[-_ ]/g, "");
  const slugOf = (name: string) => [...known].find(([k]) => flat(k) === flat(name))?.[1];
  const marks: [number, string][] = [];
  for (const m of text.matchAll(mention)) {
    const slug = slugOf(m[1]);
    if (slug) marks.push([m.index!, slug]);
  }
  // a repository it doesn't know, named before a ref or as a label ("video-tool #2", "docs：#12"), ends the one
  // before it: the refs after it aren't that one's
  for (const m of text.matchAll(REF)) if (m[2] && repoWord(m[2], m[3]) && !slugOf(m[2])) marks.push([m.index! + m[1].length, ""]);
  for (const m of text.matchAll(LABEL)) if (repoWord(m[1], "") && !slugOf(m[1])) marks.push([m.index! + m[0].lastIndexOf(m[1]), ""]);
  marks.sort((a, b) => a[0] - b[0]);
  const near = (at: number) => { let s: string | null = null; for (const [i, slug] of marks) { if (i >= at) break; s = slug; } return s; };
  const url = (slug: string, n: string) => `https://github.com/${slug}/issues/${n}`;
  let base = 0;
  return text.split(/(`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\))/).map((part, i) => { const off = base; base += part.length; return i % 2 ? part : part.replace(
    REF,
    (all, pre: string, name: string | undefined, sp: string, n: string, at: number) => {
      const slug = name && slugOf(name);
      if (slug) return `${pre}[${name}${sp}#${n}](${url(slug, n)})`;
      const repo = near(off + at + pre.length) ?? only;
      if (!repo || (name && repoWord(name, sp))) return all;
      return `${pre}${name ? name + sp : ""}[#${n}](${url(repo, n)})`;
    },
  ); }).join("");
}

/** Texts inside a pressable chip: a pointer, not the I-beam selectable texts force (per view on Linux). */
export const chipText = { cursor: "pointer", userSelect: "none" } as const;
/** A message's first line, without markdown marks, for a one-line quote. */
export const firstLine = (t: string) => (t.split("\n").find((l) => l.trim()) ?? "").replace(/^\s*(#+|>)\s*/, "").replace(/[*_`]/g, "").trim().slice(0, 80);
const chipFrame = (): ViewStyle => ({
  cursor: "pointer", verticalAlign: "middle", flexDirection: "row", alignItems: "center", gap: 5, marginHorizontal: 2, height: 20,
  borderRadius: corner.badge, borderCurve: "continuous", backgroundColor: alpha(colors.text, 0.07),
});
const chipHover = (): ViewStyle => ({ backgroundColor: alpha(colors.text, 0.12) });

function Custom(props: { node: TextViewCustomNode; small: boolean }) {
  const n = props.node;
  const fs = props.small ? 12 : 13;
  if (n.name === "task") {
    const st = () => STATE_OF()[taskState(n.text!) ?? ""];
    return (
      <View role="link" testID={`task-chip-${n.text}`} accessibilityLabel={L(`Task ${n.text}`, `任务 ${n.text}`)} onPress={() => taskLink(n.text!)}
        hoverStyle={chipHover()} style={{ ...chipFrame(), paddingHorizontal: 6 }}>
        <If when={st()}>
          <View style={{ cursor: "pointer", width: 6, height: 6, borderRadius: 3, backgroundColor: st()?.[1] ?? colors.muted }} />
        </If>
        <Text style={{ ...chipText, fontFamily: MONO, fontSize: fs, lineHeight: 16, color: colors.text }}>{n.text}</Text>
      </View>
    );
  }
  return (
    <View style={{ verticalAlign: "middle", height: 20, justifyContent: "center", marginHorizontal: 2, paddingHorizontal: 6, borderRadius: corner.badge, backgroundColor: alpha(colors.text, 0.07) }}>
      <Text style={{ fontFamily: MONO, fontSize: fs, lineHeight: 16, color: colors.muted }}>{n.text}</Text>
    </View>
  );
}

/** Selectable message Markdown. */
export function Rich(props: { text: string; muted?: boolean; quiet?: boolean; context?: string; scale?: number; report?: boolean }) {
  const small = !!(props.muted || props.quiet);
  const k = () => props.scale ?? 1;
  const fontSize = () => (props.quiet ? 13 : props.muted ? size.small : size.text) * k();
  const lineHeight = () => (props.quiet ? 19 : small ? 21 : size.line) * k();
  const doc = () => {
    // Reports preserve identifiers as text; chat-only chips can replace a heading prefix with an invisible attachment.
    const d = TextView.parse(hubMarkdown(linkRepoRefs(props.text, props.context)), { math: false, html: false }, props.report ? [] : EXTENSIONS);
    return { ...d, blocks: ghBlocks(d.blocks) };
  };
  return (
    <View style={{ gap: 6 }}>
      <TextView
        document={doc()}
        selectable
        onLinkPress={({ url }) => { if (/^(https?|mailto):/i.test(url)) void openUrl(url).catch(() => {}); }}
        renderCustom={(node) => <Custom node={node} small={small} />}
        styles={{
          root: { gap: 8 * k(), fontSize: fontSize(), lineHeight: lineHeight(), color: small ? colors.muted : colors.text },
          code: { fontFamily: MONO, fontSize: (small ? 13 : 14.5) * k(), color: colors.text, backgroundColor: alpha(colors.text, 0.07) },
          emphasis: { fontStyle: "normal", fontWeight: "600" },
          link: { color: linkColor(), textDecorationColor: token("link-underline") },
        }}
      />
    </View>
  );
}

/** What the chat tells message Markdown: how a task chip opens its task and finds its state, and the repositories the
 * channel has linked so far. */
export function bindMarkdown(chat: { taskLink: (id: string) => void; taskState: (id: string) => string | undefined; knownRepos: () => Map<string, string> }) {
  taskLink = chat.taskLink;
  taskState = chat.taskState;
  knownRepos = chat.knownRepos;
}
