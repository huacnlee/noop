import { expect, test } from "bun:test";
import { loginSpawn } from "../src/accounts";

test("codex device login runs without a script wrapper on every platform", () => {
  const cmd = ["codex", "login", "--device-auth"];
  for (const platform of ["darwin", "linux", "win32"]) expect(loginSpawn("codex", cmd, platform, true)).toEqual({ argv: cmd, pty: false });
});

test("claude setup-token gets a real pseudo-terminal on macOS instead of BSD script", () => {
  const cmd = ["claude", "setup-token"];
  expect(loginSpawn("claude", cmd, "darwin", true)).toEqual({ argv: cmd, pty: true });
  expect(loginSpawn("claude", cmd, "linux", true)).toEqual({ argv: ["script", "-qfec", "'claude' 'setup-token'", "/dev/null"], pty: false });
  expect(loginSpawn("claude", cmd, "win32", false)).toEqual({ argv: cmd, pty: false });
});

test.skipIf(process.platform !== "darwin")("a piped child under the macOS plan is not wrapped in script (no tcgetattr exit 1)", async () => {
  const { argv } = loginSpawn("codex", ["sh", "-c", "echo https://example.test/device ABCD-12345"], "darwin");
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  expect(await proc.exited).toBe(0);
  expect(err).not.toContain("tcgetattr");
  expect(out).toContain("ABCD-12345");
});

test.skipIf(process.platform === "win32")("the pty plan gives the child a terminal and accepts typed input", async () => {
  let out = "";
  const proc = Bun.spawn(["sh", "-c", "test -t 0 && echo TTY; read x; echo got:$x"], {
    terminal: { cols: 500, rows: 50, data: (_t, d) => { out += new TextDecoder().decode(d); } },
  });
  proc.terminal!.write("abc\r");
  expect(await proc.exited).toBe(0);
  expect(out).toContain("TTY");
  expect(out).toContain("got:abc");
});
