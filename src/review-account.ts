// Machine-local bridge for scripts/second-review.sh. JSON only; never print credentials.
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { accounts, accountRecovery, recordQuota, classify, type Account } from "./accounts";
import { loadConfig } from "./core";

/** Match the login actually used by the reviewer; never rotate to the author's model. */
export function reviewerAccount(cli: string): Account {
  const standard = join(homedir(), cli === "claude" ? ".claude" : ".codex");
  const dir = resolve((cli === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) || standard);
  const configured = accounts(loadConfig(), cli).find(a => resolve(a.default ? standard : a.dir) === dir);
  if (configured) return configured;
  if (dir === standard) return { cli, name: "default", dir: "", default: true };
  return { cli, name: `env-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`, dir };
}

if (import.meta.main) {
  const [mode, cli] = process.argv.slice(2);
  if (!["claude", "codex"].includes(cli) || !["check", "record"].includes(mode)) process.exit(2);
  try {
    const a = reviewerAccount(cli);
    if (mode === "record") {
      const output = readFileSync(0, "utf8");
      if (classify(output) !== "quota") throw new Error("Not a quota failure");
      console.log(JSON.stringify(recordQuota(a, output)));
    }
    else {
      const recovery = accountRecovery(a);
      console.log(JSON.stringify({ account: `${a.cli}-${a.name}`, ...recovery }));
      process.exitCode = recovery.available ? 0 : 1;
    }
  } catch { console.error("review-account: cannot access configured account state"); process.exitCode = 2; }
}
