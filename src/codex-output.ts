/** Read only completed assistant messages, never result-like text in tool output. */
export function codexMessage(event: any): string | undefined {
  if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") return event.item.text;
}

export function codexMessages(raw: string): string {
  return raw.split("\n").flatMap((line) => {
    try { const text = codexMessage(JSON.parse(line)); return text === undefined ? [] : [text]; }
    catch { return []; }
  }).join("\n\n");
}
