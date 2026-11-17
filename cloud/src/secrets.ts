// The team's shared secrets (Settings → MCP → Keys): API keys the owner enters once in the app and every machine uses.
//
// They never enter the data repo (it syncs as files) nor the settings. The Worker keeps them in its own storage,
// AES-GCM encrypted with a key derived from the machine key (HUB_TOKEN), and the routes are one-way:
//   owner session  → write, replace, delete, and list names (never read a value back)
//   machine key    → read the values, to start agents with them
// A phone or browser that is lost or hijacked can therefore not take the keys out, and an MCP connector session
// (scope "mcp") can do neither. The local server (no Worker) keeps the same shape in a 0600 file outside the data.

export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const SECRET_MAX = 8192;
export type SecretInfo = { name: string; updated: string };

const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFor(token: string) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`noop-secrets:v1:${token}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** "iv.ciphertext", both base64; the name is bound as associated data so a value cannot be moved to another name. */
export async function seal(token: string, name: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(name) }, await keyFor(token), enc.encode(value)));
  return `${b64(iv)}.${b64(ct)}`;
}

/** null when it does not open (the machine key changed since it was saved, or the data was altered). */
export async function unseal(token: string, name: string, sealed: string): Promise<string | null> {
  const [iv, ct] = sealed.split(".");
  if (!iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(name) }, await keyFor(token), unb64(ct));
    return new TextDecoder().decode(pt);
  } catch { return null; }
}

/** What is wrong with a PUT body, or null. */
export function secretProblem(name: unknown, value: unknown): string | null {
  if (typeof name !== "string" || !SECRET_NAME.test(name)) return "name: letters, digits and _, not starting with a digit";
  if (value === null || value === "") return null; // delete
  if (typeof value !== "string") return "value must be a string";
  if (value.length > SECRET_MAX) return "value too long";
  return null;
}
