// The login-code mail. Mail apps that offer to copy a code (Gmail's "Copy code", Apple Mail's AutoFill) don't publish
// how they spot one, so this follows what the mails they do pick up share: the code is in the subject, the preview
// and the first line of the text next to the words "verification code", once, unsplit; the HTML part shows it large.
import { L } from "./i18n";

export interface Mail { subject: string; text: string; html: string }

const b64 = (s: string) => { let bin = ""; for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
const lines76 = (s: string) => b64(s).replace(/.{1,76}/g, "$&\r\n").trimEnd();
/** The MIME part of a mail after the address headers: plain text alone, or text and HTML as multipart/alternative. */
export function mimeBody(text: string, html?: string): string[] {
  const part = (type: string, body: string) => [`Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", lines76(body)];
  if (!html) return ["MIME-Version: 1.0", ...part("text/plain", text)];
  const b = `=_${crypto.randomUUID()}`;
  return ["MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${b}"`, "",
    `--${b}`, ...part("text/plain", text), `--${b}`, ...part("text/html", html), `--${b}--`];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ "&": "amp", "<": "lt", ">": "gt", '"': "quot" } as Record<string, string>)[c]};`);

export function loginCodeMail(code: string): Mail {
  const line = L(`Your Noop verification code is ${code}.`, `你的 Noop 验证码是 ${code}。`);
  const valid = L("It expires in 10 minutes.", "10 分钟内有效。");
  const ignore = L("If you didn't try to sign in to Noop, ignore this email.", "如果不是你本人在登录 Noop，请忽略这封邮件。");
  const subject = L(`${code} is your Noop verification code`, `${code} 是你的 Noop 验证码`);
  const text = `${line}\n\n${valid}\n\n${ignore}\n`;
  const html = `<!doctype html><html lang="${L("en", "zh-CN")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(line)} ${esc(valid)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;">
<tr><td style="padding:32px 32px 8px;font:600 18px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b;">${esc(L("Your Noop verification code", "你的 Noop 验证码"))}</td></tr>
<tr><td style="padding:16px 32px;"><div style="padding:16px 0;background:#f4f4f5;border-radius:8px;text-align:center;font:700 32px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:6px;color:#18181b;">${esc(code)}</div></td></tr>
<tr><td style="padding:8px 32px 32px;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#52525b;">${esc(valid)}<br>${esc(ignore)}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
