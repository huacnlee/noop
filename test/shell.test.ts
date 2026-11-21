import { expect, test } from "bun:test";
import { pickBash } from "../src/shell";

// A fresh PowerShell puts C:\Windows\System32 (the WSL launcher) ahead of Git for Windows, so a bare "bash" there runs the
// command inside WSL: no p4/gh, no /c/Users, a different $HOME. pickBash must skip those and find the real Git Bash.
const GIT = "D:\\tools\\git\\usr\\bin\\bash.exe";
const WSL = "C:\\Windows\\System32\\bash.exe";
const win = (path: string, present: string[], env: Record<string, string | undefined> = {}) =>
  pickBash({ platform: "win32", path, env, exists: (p) => present.includes(p) });

test("pickBash: anything but Windows keeps the bash from PATH", () => {
  expect(pickBash({ platform: "linux", path: "/usr/bin", env: {}, exists: () => true })).toBe("bash");
  expect(pickBash({ platform: "darwin", path: "/usr/bin", env: {}, exists: () => true })).toBe("bash");
});

test("pickBash: on Windows it skips the System32 WSL launcher and takes Git Bash", () => {
  expect(win("C:\\Windows\\System32;D:\\tools\\git\\usr\\bin", [WSL, GIT])).toBe(GIT);
});

test("pickBash: the WSL launcher is recognised whatever the case, trailing slash or Sysnative spelling", () => {
  const git = "D:\\tools\\git\\usr\\bin\\bash.exe";
  expect(win("C:\\WINDOWS\\system32\\;D:\\tools\\git\\usr\\bin", ["C:\\WINDOWS\\system32\\bash.exe", git])).toBe(git);
  expect(win("C:\\Windows\\Sysnative;D:\\tools\\git\\usr\\bin", ["C:\\Windows\\Sysnative\\bash.exe", git])).toBe(git);
});

test("pickBash: the WindowsApps alias is skipped too", () => {
  const apps = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe";
  expect(win("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;D:\\tools\\git\\usr\\bin", [apps, GIT])).toBe(GIT);
});

test("pickBash: NOOP_BASH wins when the file exists, and is ignored when it does not", () => {
  const mine = "E:\\msys64\\usr\\bin\\bash.exe";
  expect(win("D:\\tools\\git\\usr\\bin", [GIT, mine], { NOOP_BASH: mine })).toBe(mine);
  expect(win("D:\\tools\\git\\usr\\bin", [GIT], { NOOP_BASH: mine })).toBe(GIT);
});

test("pickBash: with only the WSL launcher on PATH it falls back to plain bash (unchanged behaviour)", () => {
  expect(win("C:\\Windows\\System32", [WSL])).toBe("bash");
});
