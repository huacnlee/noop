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

/** CLI diagnostics only: a session transcript can quote quota text before failing for another reason. */
export function reviewerFailure(output: string): { kind: ReturnType<typeof classify>; diagnostic: string } {
  const lines = output.slice(-4000).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").split(/\r?\n/);
  const diagnostic = lines.filter(line => /^(?:ERROR:|API Error:|(?:Claude(?: AI)? )?(?:usage|session|weekly|\d+-hour) limit reached|You've hit|You have hit|Rate.?limit|Usage limit|Quota|Insufficient_quota|Credit balance|Out of credits|Overloaded|Too many requests)(?!\w)/i.test(line.trim())).at(-1)?.trim() ?? "";
  return { kind: classify(diagnostic), diagnostic };
}

if (import.meta.main) {
  const [mode, cli] = process.argv.slice(2);
  if (!["claude", "codex"].includes(cli) || !["check", "record", "classify"].includes(mode)) process.exit(2);
  try {
    if (mode === "classify") console.log(reviewerFailure(readFileSync(0, "utf8")).kind ?? "none");
    else if (mode === "record") {
      const { kind, diagnostic } = reviewerFailure(readFileSync(0, "utf8"));
      if (kind !== "quota") throw new Error("Not a quota failure");
      console.log(JSON.stringify(recordQuota(reviewerAccount(cli), diagnostic)));
    } else {
      const a = reviewerAccount(cli);
      const recovery = accountRecovery(a);
      console.log(JSON.stringify({ account: `${a.cli}-${a.name}`, ...recovery }));
      process.exitCode = recovery.available ? 0 : 1;
    }
  } catch { console.error("review-account: cannot access configured account state"); process.exitCode = 2; }
}
