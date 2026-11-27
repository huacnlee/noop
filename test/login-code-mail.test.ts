import { expect, test } from "bun:test";
import { loginCodeMail, mimeBody } from "../cloud/src/codemail";
import { setLang } from "../cloud/src/i18n";

const unb64 = (s: string) => Buffer.from(s.replace(/\r\n/g, ""), "base64").toString();

test("the code leads the subject and the first text line, unsplit, next to 'verification code'", () => {
  setLang("en");
  const m = loginCodeMail("K7MPQ3XR");
  expect(m.subject).toBe("K7MPQ3XR is your Noop verification code");
  expect(m.text.split("\n")[0]).toBe("Your Noop verification code is K7MPQ3XR.");
  expect(m.html).toContain(">K7MPQ3XR</div>");
  expect(m.html).toContain('<div style="display:none;max-height:0;overflow:hidden;">Your Noop verification code is K7MPQ3XR.');
  setLang("zh");
  const zh = loginCodeMail("K7MPQ3XR");
  expect(zh.subject).toBe("K7MPQ3XR 是你的 Noop 验证码");
  expect(zh.text).toContain("10 分钟内有效");
});

test("mimeBody sends text alone, or text and HTML as multipart/alternative", () => {
  expect(mimeBody("hi")).toEqual(["MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", "aGk="]);
  const lines = mimeBody("plain ✓", "<b>html ✓</b>");
  const b = lines[1].match(/boundary="([^"]+)"/)![1];
  expect(lines.filter((l) => l === `--${b}`)).toHaveLength(2);
  expect(lines.at(-1)).toBe(`--${b}--`);
  const parts = lines.join("\r\n").split(`--${b}`).slice(1, 3).map((p) => p.split("\r\n\r\n"));
  expect(parts[0][0]).toContain("text/plain");
  expect(unb64(parts[0][1])).toBe("plain ✓");
  expect(parts[1][0]).toContain("text/html");
  expect(unb64(parts[1][1])).toBe("<b>html ✓</b>");
});
