// Which bash runs the shell commands users write into task cards and routines (wait_check, signal).
import { existsSync } from "node:fs";

/** Folders whose bash.exe is the WSL launcher, not a shell that understands Windows paths and tools. */
const WSL_LAUNCHER_DIR = /\\(windows\\(system32|sysnative)|microsoft\\windowsapps)$/i;

/**
 * On Windows a bare `bash` resolves through PATH, and a fresh PowerShell lists C:\Windows\System32 (the WSL launcher)
 * ahead of Git for Windows. A daemon started from such a shell then ran every check inside WSL: no p4 or gh, no /c/Users,
 * another $HOME, so a wait_check exited 127 for ever and the wait never ended.
 * Order: NOOP_BASH if that file exists, else the first bash.exe on PATH outside the WSL launcher folders, else plain `bash`.
 * Everywhere but Windows this is just `bash`.
 */
export function pickBash(opts: { platform?: string; path?: string; env?: Record<string, string | undefined>; exists?: (p: string) => boolean } = {}): string {
  if ((opts.platform ?? process.platform) !== "win32") return "bash";
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  if (env.NOOP_BASH && exists(env.NOOP_BASH)) return env.NOOP_BASH;
  for (const entry of (opts.path ?? env.PATH ?? env.Path ?? "").split(";")) {
    const dir = entry.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "");
    if (!dir || WSL_LAUNCHER_DIR.test(dir.replace(/\//g, "\\"))) continue;
    const candidate = `${dir}\\bash.exe`;
    if (exists(candidate)) return candidate;
  }
  return "bash";
}

let picked: string | undefined;
/** The bash for this process, looked up once (PATH does not change while the daemon runs). */
export const shellBash = () => (picked ??= pickBash());
