// Worker hardening: IP allow-list, login code format, OAuth redirect hosts, media served from the app origin.
import { expect, test } from "bun:test";
import { checkAllowEdit, ipAllowed, normalizeAllowList, parseAllowList } from "../cloud/src/ipallow";
import { withAllowIps } from "../src/cloud";
import { CODE_ALPHABET, CODE_LEN, CODE_RE, newCode, normCode } from "../cloud/src/authcode";
import { okRedirect } from "../cloud/src/mcp";
import { mediaHeaders } from "../cloud/src/uploads";

test("IP allow-list: v4 / v6 addresses and CIDRs", () => {
  const { nets, bad } = parseAllowList("203.0.113.7, 198.51.100.0/24 2001:db8:abcd::/48\n::1 nonsense 10.0.0.0/33");
  expect(bad).toEqual(["nonsense", "10.0.0.0/33"]);
  expect(ipAllowed("203.0.113.7", nets)).toBe(true);
  expect(ipAllowed("203.0.113.8", nets)).toBe(false);
  expect(ipAllowed("198.51.100.254", nets)).toBe(true);
  expect(ipAllowed("198.51.101.1", nets)).toBe(false);
  expect(ipAllowed("2001:db8:abcd:12::5", nets)).toBe(true);
  expect(ipAllowed("2001:DB8:ABCE::5", nets)).toBe(false);
  expect(ipAllowed("::1", nets)).toBe(true);
  expect(ipAllowed("::ffff:203.0.113.7", nets)).toBe(true); // IPv4-mapped
  expect(ipAllowed("", nets)).toBe(false);
  expect(ipAllowed(null, nets)).toBe(false);
  expect(ipAllowed("1.2.3.4", parseAllowList("garbage").nets)).toBe(false); // fails closed
  expect(ipAllowed("1.2.3.4", parseAllowList("0.0.0.0/0").nets)).toBe(true);
});

test("login codes: 8 unambiguous letters/digits, typed loosely", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const c = newCode();
    expect(c).toHaveLength(CODE_LEN);
    expect(CODE_RE.test(c)).toBe(true);
    seen.add(c);
  }
  expect(seen.size).toBe(2000);
  expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
  expect(normCode("abcd-efgh")).toBe("ABCDEFGH");
  expect(normCode(" k7qm 4xpr ")).toBe("K7QM4XPR");
  expect(CODE_RE.test(normCode("123456"))).toBe(false); // old 6-digit codes
  expect(CODE_RE.test(normCode("ABCDEFG0"))).toBe(false);
});

test("OAuth redirects: only Claude, ChatGPT and loopback", () => {
  expect(okRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
  expect(okRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
  expect(okRedirect("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
  expect(okRedirect("http://localhost:6274/oauth/callback")).toBe(true);
  expect(okRedirect("http://127.0.0.1:33418/callback")).toBe(true);
  expect(okRedirect("https://evil.example.com/cb")).toBe(false);
  expect(okRedirect("https://claude.ai.evil.com/cb")).toBe(false);
  expect(okRedirect("https://evilclaude.ai/cb")).toBe(false);
  expect(okRedirect("https://claude.ai@evil.com/cb")).toBe(false);
  expect(okRedirect("http://claude.ai/cb")).toBe(false);
  expect(okRedirect("https://claude.ai:8443/cb")).toBe(false);
});

test("media: active content is a sandboxed download, images stay inline", () => {
  for (const t of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/javascript", ""]) {
    const h = mediaHeaders(t, "x");
    expect(h["content-type"]).toBe("application/octet-stream");
    expect(h["content-disposition"]).toStartWith("attachment");
  }
  const png = mediaHeaders("image/png", "a b.png");
  expect(png["content-type"]).toBe("image/png");
  expect(png["content-disposition"]).toBe('inline; filename="a_b.png"');
  expect(png["x-content-type-options"]).toBe("nosniff");
  expect(png["content-security-policy"]).toStartWith("sandbox");
});

test("TOTP: RFC 6238 vectors, ±1 step, single use", async () => {
  const { b32decode, b32encode, hotp, newSecret, otpauthUri, totpMatch } = await import("../cloud/src/totp");
  const key = new TextEncoder().encode("12345678901234567890");
  // RFC 6238 Appendix B (SHA-1, 8 digits) at T = 59, 1111111109, 2000000000
  expect(await hotp(key, 1, 8)).toBe("94287082");
  expect(await hotp(key, 37037036, 8)).toBe("07081804");
  expect(await hotp(key, 66666666, 8)).toBe("69279037");
  const b32 = b32encode(key);
  expect(b32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  expect(b32decode(b32)).toEqual(key);
  const at = 1_111_111_109_000, step = Math.floor(at / 30_000);
  const now = await hotp(key, step), prev = await hotp(key, step - 1), old = await hotp(key, step - 2);
  expect(await totpMatch(b32, now, -1, at)).toBe(step);
  expect(await totpMatch(b32, prev, -1, at)).toBe(step - 1); // clock drift
  expect(await totpMatch(b32, old, -1, at)).toBeNull();
  expect(await totpMatch(b32, now, step, at)).toBeNull(); // already used
  expect(await totpMatch(b32, "12345", -1, at)).toBeNull();
  expect(newSecret()).toMatch(/^[A-Z2-7]{32}$/);
  expect(otpauthUri("ABC", "a@b.c")).toBe("otpauth://totp/Noop%3Aa%40b.c?secret=ABC&issuer=Noop&algorithm=SHA1&digits=6&period=30");
});

test("security check bounds every Worker call with a timeout signal", async () => {
  const { securityReport } = await import("../src/security");
  const seen: RequestInit[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((_: any, init: any) => { seen.push(init); return Promise.reject(new Error("connect ECONNREFUSED")); }) as any;
  try {
    // a Worker that cannot be reached must fail fast instead of hanging the whole command
    const out = await securityReport({ cloud: { url: "http://127.0.0.1:9" }, server: { token: "k" } } as any, "test-host", true);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(out.some((f) => f.level === "bad" && /Cannot reach|连不上/.test(f.text))).toBe(true);
  } finally {
    globalThis.fetch = real;
  }
});

test("IP allow-list edits from the app: parse, never lock out the editor, ask before shutting out a machine", () => {
  expect(normalizeAllowList(" 1.2.3.4, 1.2.3.4\n5.6.7.0/24 ")).toBe("1.2.3.4,5.6.7.0/24");
  const ctx = { requester: "203.0.113.7", machines: ["198.51.100.9"] };
  expect(checkAllowEdit(["203.0.113.7", "198.51.100.0/24"], ctx)).toEqual({ ok: true, value: "203.0.113.7,198.51.100.0/24" });
  expect(checkAllowEdit(["203.0.113.7", "bogus"], ctx)).toMatchObject({ ok: false, code: "bad", ips: ["bogus"] });
  expect(checkAllowEdit(["198.51.100.0/24"], ctx)).toMatchObject({ ok: false, code: "self" });
  expect(checkAllowEdit(["203.0.113.0/24"], ctx)).toMatchObject({ ok: false, code: "machines", ips: ["198.51.100.9"] });
  expect(checkAllowEdit(["203.0.113.0/24"], { ...ctx, force: true })).toEqual({ ok: true, value: "203.0.113.0/24" });
  expect(checkAllowEdit([], ctx)).toEqual({ ok: true, value: "" }); // empty: the allow-list is off
});

test("IP allow-list edits land in config.toml's [cloud] block", () => {
  const toml = '[fleet]\nprimary = "a"\n\n[cloud]\nurl = "https://x"\nallow_ips = "1.1.1.1"\n\n[[routine]]\nname = "r"\n';
  expect(withAllowIps(toml, "1.1.1.1,2.2.2.2")).toBe(toml.replace('allow_ips = "1.1.1.1"', 'allow_ips = "1.1.1.1,2.2.2.2"'));
  const noLine = '[cloud]\nurl = "https://x"\nname = "noop"\n\n[[routine]]\nname = "r"\n';
  expect(withAllowIps(noLine, "2.2.2.2")).toBe('[cloud]\nurl = "https://x"\nname = "noop"\nallow_ips = "2.2.2.2"\n\n[[routine]]\nname = "r"\n');
  expect(withAllowIps('[cloud]\nurl = "https://x"\n', "")).toBe('[cloud]\nurl = "https://x"\nallow_ips = ""\n');
  expect(withAllowIps('[fleet]\nprimary = "a"\n', "2.2.2.2")).toBe('[fleet]\nprimary = "a"\n\n[cloud]\nallow_ips = "2.2.2.2"\n');
  expect(Bun.TOML.parse(withAllowIps(noLine, "2.2.2.2"))).toMatchObject({ cloud: { allow_ips: "2.2.2.2" } });
});
