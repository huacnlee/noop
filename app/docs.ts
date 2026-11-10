// The report open in the reader pane and the report bodies fetched for it, shared by the timeline's file cards
// (the chat) and the reader (loaded with the first report it shows).
import { signal, type Signal, untracked } from "nsh";
import { L } from "./i18n";
import { stripFrontMatter } from "./hub";

/** The report open in the chat's reader pane: one at a time, shared by every file card in the timeline. */
export type DocRef = { src: string; name: string; at?: string };
export const reading = signal<DocRef | null>(null);
/** The page the reader belongs to (a channel or a task); a report opened on one page never shows on another. */
export const readerAt = signal("");
/** Report bodies already fetched, so reopening or switching back is instant. Bounded, newest kept; a failed one loads again when reopened or retried. */
type DocBody = { text: string | null; error: string };
const DOC_CACHE_MAX = 16;
const docCache = new Map<string, Signal<DocBody>>();
export function clearDocCache() {
  docCache.clear();
  reading.set(null);
}
function loadDoc(src: string, body: Signal<DocBody>) {
  body.set({ text: null, error: "" });
  void fetch(src)
    .then(async (r) => {
      if (r.ok) return body.set({ text: stripFrontMatter(await r.text()), error: "" });
      body.set({ text: null, error: r.status === 404 ? L("This file has expired.", "这个文件已过期。") : L(`Couldn’t load (${r.status})`, `读取失败（${r.status}）`) });
    })
    .catch(() => {
      body.set({ text: null, error: L("Can’t reach the server", "连不上服务器") });
    });
}
export function docBody(src: string) {
  const hit = docCache.get(src);
  if (hit) {
    docCache.delete(src);
    docCache.set(src, hit);
    if (untracked(hit).error) loadDoc(src, hit);
    return hit;
  }
  const body = signal<DocBody>({ text: null, error: "" });
  docCache.set(src, body);
  while (docCache.size > DOC_CACHE_MAX) docCache.delete(docCache.keys().next().value!);
  loadDoc(src, body);
  return body;
}
export function retryDoc(src: string, body: Signal<DocBody>) {
  if (!docCache.has(src)) {
    docCache.set(src, body);
    while (docCache.size > DOC_CACHE_MAX) docCache.delete(docCache.keys().next().value!);
  }
  loadDoc(src, body);
}
