/** Read only completed assistant messages, never result-like text in tool output. */
export function codexMessage(event: any): string | undefined {
  if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") return event.item.text;
}

/** A turn that died before any assistant message. Codex prints this on stdout
 *  (`error`, then the same text again as `turn.failed`); stderr may only have
 *  an unrelated models-refresh timeout. Dropping it left classify with nothing
 *  to call a quota wall, so the run was "no result" and the medic was woken. */
export function codexTurnError(event: any): string | undefined {
  let message: unknown;
  if (event?.type === "error") message = event.message;
  else if (event?.type === "turn.failed") message = typeof event.error === "string" ? event.error : event.error?.message;
  else return;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

export function codexMessages(raw: string): string {
  let seenError = "";
  return raw.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line);
      const text = codexMessage(event);
      if (text) return [text];
      const failure = codexTurnError(event);
      if (!failure || failure === seenError) return [];
      seenError = failure;
      return [`ERROR: ${failure}`];
    } catch { return []; }
  }).join("\n\n");
}
