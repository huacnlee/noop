#!/bin/sh
# Cross-model review round: the OTHER CLI reviews your change read-only (author claude → codex reviews, and vice versa).
# Owner habit (taste.md): "让 codex review 下，有问题就修复下，没什么问题就提交" — loop fix → re-review until clean.
# Policy: policies/review.md. Added by T-0016; failure handling rewritten by T-0023 (2026-11-10).
#
# Usage: sh "$HUB_DATA/tools/second-review.sh" <TASK-ID> <repo-dir> [--base <ref> | --commit <sha> | --uncommitted]
#                                              [--author claude|codex] [--round N] [--note "what the change is for"]
#   default target: --base origin/HEAD (or main) → reviews <base>...HEAD plus uncommitted changes.
# Exit: 0 = clean (no actionable findings) · 1 = findings (fix, then run the next round)
#       2 = reviewer unavailable/failed — a "reason=<kind>" line says why; the attempt does NOT use up a round
#           kinds: same-model · missing · permission · auth · quota · network · timeout · error · parse · repo-modified
#       3 = disabled or round limit reached
# Output: appends the round (or the failed attempt with redacted stdout/stderr tails) to reports/<TASK-ID>-second-review.md.
# Off switch: config.toml  [review] second_model = false   (or env NOOP_SECOND_REVIEW=0). Rounds: [review] max_rounds = 4.
# Keep it POSIX and bash-3.2-safe (macOS /bin/sh): never put a `case` inside "$( )" (bash 3.2 mis-parses ')' there, T-0029).
# After editing, run: sh "$HUB_DATA/tools/check-sh.sh"
# Never fall back to the same model: if the other CLI cannot run here, report the reason; do not review with yourself.
set -u
DATA="${HUB_DATA:-$HOME/.noop/data}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
code_dir="${NOOP_REVIEW_CODE_DIR:-$script_dir/../src}"
[ -f "$code_dir/review-account.ts" ] || code_dir="${NOOP_REVIEW_CODE_DIR:-${NOOP_HOME:-$HOME/.noop}/app/src}"
bridge="$code_dir/review-account.ts"
tid="${1:-}"; repo="${2:-}"
if [ -z "$tid" ] || [ -z "$repo" ] || [ ! -d "$repo" ]; then
  echo "usage: second-review.sh T-xxxx <repo-dir> [--base ref|--commit sha|--uncommitted] [--author claude|codex] [--round N] [--note text]" >&2; exit 2
fi
shift 2
mode="base"; ref=""; author=""; round=""; note=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) mode="base"; ref="${2:-}"; shift 2;;
    --commit) mode="commit"; ref="${2:-}"; shift 2;;
    --uncommitted) mode="uncommitted"; shift;;
    --author) author="${2:-}"; shift 2;;
    --round) round="${2:-}"; shift 2;;
    --note) note="${2:-}"; shift 2;;
    *) echo "second-review: unknown arg $1" >&2; exit 2;;
  esac
done

# [review] settings from config.toml (config.local.toml wins)
cfg() { v=""; for f in "$DATA/config.local.toml" "$DATA/config.toml"; do
  v="$(awk -v k="$1" '/^\[/{s=($0~/^\[review\][ \t]*(#.*)?$/)} s&&$0~"^"k" *="{sub("^"k" *= *","");sub(/ *#.*/,"");gsub(/"/,"");print;exit}' "$f" 2>/dev/null)"
  [ -n "$v" ] && { echo "$v"; return; }; done; }
enabled="${NOOP_SECOND_REVIEW:-$(cfg second_model)}"
case "$enabled" in false|0|off|no) echo "second-review: disabled ([review] second_model = false)"; exit 3;; esac
max="$(cfg max_rounds)"; [ -z "$max" ] && max=4
tmo="$(cfg timeout_minutes)"; [ -z "$tmo" ] && tmo=20

report="$DATA/reports/$tid-second-review.md"
# Only completed rounds (with a verdict) count; "## Attempt failed" sections do not.
# Legacy (pre-T-0023) failed rounds were written as "## Round N" + "Reviewer unavailable or no verdict" — not counted either.
[ -z "$round" ] && round=$(( $(awk '/^## /{p=0} /^## Round /{n++; p=1} p&&/^Reviewer unavailable or no verdict/{n--; p=0} END{print n+0}' "$report" 2>/dev/null || echo 0) + 1 ))
if [ "$round" -gt "$max" ]; then echo "second-review: round $round > max_rounds $max — stop and list the open findings for the owner"; exit 3; fi

# Which CLI is running this script (the agent's own model)?
runtime=""
if [ -n "${CLAUDECODE:-}" ]; then runtime=claude
elif [ -n "${CODEX_THREAD_ID:-}${CODEX_SESSION_ID:-}${CODEX_CI:-}${CODEX_SANDBOX:-}" ]; then runtime=codex; fi
[ -z "$author" ] && author="${runtime:-claude}"
case "$author" in claude) rev=codex;; codex) rev=claude;; *) echo "second-review: --author must be claude or codex" >&2; exit 2;; esac

cd "$repo" || exit 2
if [ "$mode" = "base" ] && [ -z "$ref" ]; then
  ref="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)"
  [ -z "$ref" ] && for b in origin/main origin/master main master; do git rev-parse -q --verify "$b" >/dev/null && { ref="$b"; break; }; done
fi
case "$mode" in
  base) scope="the commits in \`git log $ref..HEAD\` (diff: \`git diff $ref...HEAD\`) plus any uncommitted changes (\`git diff HEAD\`, untracked files from \`git status\`)";;
  commit) scope="commit $ref (\`git show $ref\`)";;
  uncommitted) scope="the uncommitted changes (\`git diff HEAD\` and untracked files from \`git status --porcelain\`)";;
esac

tmp="$(mktemp -d "${TMPDIR:-/tmp}/second-review.XXXXXX")"
out="$tmp/out"; err="$tmp/err"; log="$tmp/log"; : > "$out"; : > "$err"; : > "$log"
trap 'rm -rf "$tmp"' EXIT
rc=0; reason=""; detail=""; ran=""; recovery=""

# Redact anything token-like before it reaches the hub (which syncs to the cloud).
redact() { sed -E \
  -e 's/(sk|pk|rk)-[A-Za-z0-9_-]{12,}/\1-[REDACTED]/g' \
  -e 's/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/\1[REDACTED]/g' \
  -e 's/(AKIA|ASIA)[A-Z0-9]{12,}/\1[REDACTED]/g' \
  -e 's/xox[abprs]-[A-Za-z0-9-]{10,}/xox-[REDACTED]/g' \
  -e 's/([Bb]earer|[Tt]oken|[Aa]uthorization)([": =]+)[A-Za-z0-9._~+\/=-]{12,}/\1\2[REDACTED]/g' \
  -e 's/((api|access|refresh|secret|session)[_-]?(key|token)?["'"'"']?[ :=]+["'"'"']?)[A-Za-z0-9._~+\/=-]{12,}/\1[REDACTED]/Ig' \
  -e 's/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/[REDACTED-JWT]/g'; }
tailf() { tail -n 25 "$1" 2>/dev/null | tail -c 2500 | redact; }

state() { git rev-parse HEAD 2>/dev/null; git status --porcelain=v1 -uall 2>/dev/null; git diff HEAD 2>/dev/null | shasum 2>/dev/null; }

# Bun is already required by the account bridge; GNU timeout isn't installed on stock macOS.
run_with_timeout() {
  bun -e '
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(process.argv[2], process.argv.slice(3), {
      stdio: "inherit", timeout: Number(process.argv[1]) * 1000, killSignal: "SIGKILL"
    });
    if (result.error) console.error("review runner: " + result.error.code);
    process.exit(result.error?.code === "ETIMEDOUT" ? 124 : (result.status ?? 127));
  ' "$@"
}

# Preflight: never review with the model that is running (that is not a cross-model review).
if [ -n "$runtime" ] && [ "$runtime" = "$rev" ]; then
  reason="same-model"; detail="this script runs inside $runtime and the reviewer would also be $rev (--author $author); a $rev review of its own run is not a second opinion"
elif ! command -v "$rev" >/dev/null 2>&1; then
  reason="missing"; rc=127; detail="$rev CLI not on PATH on $(hostname -s 2>/dev/null)"
elif [ ! -f "$bridge" ] || ! command -v bun >/dev/null 2>&1; then
  reason="error"; detail="shared account bridge unavailable; update Noop before retrying"
else
  check_rc=0
  recovery="$(bun "$bridge" check "$rev" 2>"$err")" || check_rc=$?
  if [ "$check_rc" -eq 1 ]; then
    reason="quota"
    printf '%s' "$recovery" | grep -q '"reason":"auth"' && reason="auth"
    detail="reviewer not called: $recovery"
  elif [ "$check_rc" -ne 0 ]; then
    reason="error"; detail="shared account check failed; reviewer not called"
  fi
fi
if [ -z "$reason" ] && [ "$rev" = codex ]; then
  # codex starts an in-process app-server under ~/.codex; inside another seatbelt sandbox that fails with EPERM (T-0014).
  # (claude -p still runs when ~/.claude is read-only, so it is not probed.)
  home_dir="$HOME/.codex"; probe="$home_dir/.second-review-probe-$$"
  if ! ( mkdir -p "$home_dir" && : > "$probe" ) 2>"$err"; then
    reason="permission"; detail="cannot write $home_dir from this process (nested sandbox?); $rev cannot start here"
  fi
  rm -f "$probe" 2>/dev/null
fi

if [ -z "$reason" ]; then
  prompt_file="$tmp/prompt"
  cat > "$prompt_file" <<EOF
You are a second-opinion code reviewer for a change another AI model wrote. Review READ-ONLY: do not edit, stage, commit,
push, launch GUI apps, touch the clipboard or trigger OS permission prompts. You may read files and run read-only git
commands and fast, side-effect-free tests if they clearly help (write any build output outside the repository).

Repository: $(pwd)
Review scope: $scope
${note:+Purpose of the change (from the author): $note
}
What to look for: correctness bugs, regressions, security problems, broken sync/migration/rollback paths, missing tests
for risky logic. Also the owner's checklist: no hard-coded UI strings (use the i18n/copy file); dev-only tools excluded from
production builds; no build output (dist/) committed; no duplicate files; shortcuts must not collide with macOS defaults.
Do NOT report style nits, naming taste or speculative refactors — only things worth changing before the owner commits.

Output format (plain markdown, concise):
- One bullet per finding: "[P1|P2|P3] path:line — problem — concrete failure scenario — suggested fix".
  P1 = must fix (bug/security/data loss), P2 = should fix, P3 = minor but actionable.
- If nothing is actionable, write "No actionable findings." and list what you checked in one line.
- The LAST line must be exactly "VERDICT: CLEAN" or "VERDICT: FINDINGS <count>".
EOF
  before="$(state)"; ran=1
  if [ "$rev" = codex ]; then
    run_with_timeout "$((tmo * 60))" codex exec --sandbox read-only --skip-git-repo-check --ephemeral -C "$(pwd)" \
      -o "$out" - < "$prompt_file" > "$log" 2>"$err" || rc=$?
  else
    run_with_timeout "$((tmo * 60))" claude -p --permission-mode default \
      --allowedTools "Read" "Grep" "Glob" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(git status:*)" \
      --disallowedTools "Edit" "Write" "NotebookEdit" < "$prompt_file" > "$out" 2>"$err" || rc=$?
  fi
  after="$(state)"
  verdict="$(grep -E '^ *VERDICT: *(CLEAN|FINDINGS *[0-9]+) *$' "$out" 2>/dev/null | tail -1 | sed 's/^ *//; s/ *$//')"
  all="$(cat "$err" "$log" "$out" 2>/dev/null | tail -c 20000)"
  m() { printf '%s' "$all" | grep -Eiq "$1"; }
  if [ "$before" != "$after" ]; then
    reason="repo-modified"; detail="HEAD, git status or the diff changed while $rev was reviewing — inspect \`git status\` / \`git reflog\` before trusting the tree"
  elif [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    reason="timeout"; detail="no answer within ${tmo} min ([review] timeout_minutes)"
  elif [ "$rc" -eq 127 ]; then
    reason="missing"; detail="$rev could not be executed"
  elif [ "$rc" -ne 0 ] || [ -z "$verdict" ]; then
    if m 'operation not permitted|EPERM|sandbox(-exec)? (denied|deny)|permission denied|read-only file system'; then reason="permission"
    elif m 'rate.?limit|usage limit|quota|insufficient_quota|credit balance|out of credits|limit reached|hit your .*limit|too many requests|\b429\b|overloaded'; then reason="quota"
    elif m 'not logged in|please (log|sign) ?in|/login|login required|unauthori[sz]ed|invalid api key|authentication|\b401\b|token (has )?expired'; then reason="auth"
    elif m 'ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network (error|is unreachable)|could not resolve host|stream disconnected|connection (refused|reset|error)'; then reason="network"
    elif [ "$rc" -ne 0 ]; then reason="error"; detail="exit $rc without a recognised cause"
    else reason="parse"; detail="exit 0 but the output has no final 'VERDICT: CLEAN|FINDINGS <n>' line"; fi
  fi
fi

# Persist quota failures through the same account store as the daemon. Preflight skips never extend cooldowns.
if [ "$reason" = quota ] && [ -n "$ran" ]; then
  recovery="$(printf '%s' "$all" | bun "$bridge" record "$rev" 2>"$err")" || {
    reason="error"; detail="quota detected but shared recovery could not be saved";
  }
fi

case "$reason" in
  same-model) hint="Do not substitute the same model. Rerun without a wrong --author, or have an agent running in the other CLI run the review.";;
  missing) hint="Install/log in the $rev CLI on this host, or run the review on a host that has it.";;
  permission) hint="The reviewer cannot start inside this sandbox. Rerun the command below outside the sandbox (owner/DSH) or from a full-access agent run; do not fall back to the same model.";;
  auth) hint="Owner action: log the $rev CLI in on this host (\`$rev login\` / \`claude auth login\`), then rerun.";;
  quota) hint="Quota/rate limit: wait for the limit to reset and rerun; report \"未做二次 review：$rev 额度不足\" if it cannot finish in this run.";;
  network) hint="Network failure: retry once; if it persists, report it and rerun later.";;
  timeout) hint="Retry once with a narrower scope (--commit <sha>) or a larger [review] timeout_minutes.";;
  parse) hint="The reviewer answered without the required VERDICT line (output kept above). Retry once; do not treat it as clean.";;
  repo-modified) hint="The reviewer changed the repository. Inspect and restore the tree, then rerun; do not commit the reviewer's edits unreviewed.";;
  *) hint="Unknown failure: read the stdout/stderr tails above, retry once, then report it.";;
esac

[ -f "$report" ] || printf '# %s — cross-model review log\n\nPolicy: policies/review.md. One section per round; the author adds "Fixed:" lines after each round. "Attempt failed" sections do not count as rounds.\n\n' "$tid" > "$report"
head_short="$(git rev-parse --short HEAD 2>/dev/null)"
if [ -n "$reason" ]; then
  rerun="sh \"$DATA/tools/second-review.sh\" $tid \"$(pwd)\" --$mode${ref:+ $ref} --author $author${note:+ --note \"…\"}"
  [ "$mode" = uncommitted ] && rerun="sh \"$DATA/tools/second-review.sh\" $tid \"$(pwd)\" --uncommitted --author $author"
  rcs="exit $rc"; [ -z "$ran" ] && rcs="not started"
  {
    printf '## Attempt failed — %s reviews %s (%s) — reason: %s\n\n' "$rev" "$author" "$(date '+%Y-%m-%d %H:%M')" "$reason"
    printf 'Repo: `%s` · scope: %s %s · HEAD `%s` · runtime: %s · %s\n\n' "$(basename "$(pwd)")" "$mode" "$ref" "$head_short" "${runtime:-unknown}" "$rcs"
    [ -n "$detail" ] && printf -- '- Cause: %s\n' "$detail"
    [ -n "$recovery" ] && printf -- '- Account recovery: `%s`\n- Read-only wait check: `bun "%s" check %s`\n' "$recovery" "$bridge" "$rev"
    printf -- '- Recovery: %s\n- Rerun: `%s`\n\n' "$hint" "$rerun"
    printf 'stderr (tail, redacted):\n```\n%s\n```\n\n' "$(tailf "$err")"
    printf 'stdout (tail, redacted):\n```\n%s\n%s\n```\n\n' "$(tailf "$log")" "$(tailf "$out")"
  } >> "$report" 2>/dev/null && logged="attempt logged in $report" || logged="could NOT write $report (keep this output as the evidence)"
  echo "second-review: $rev did not complete a review — reason=$reason ($rcs); $logged; round $round not used"
  [ -n "$detail" ] && echo "  cause: $detail"
  echo "  recovery: $hint"
  [ -n "$recovery" ] && printf '  account_recovery=%s\n  wait_check=bun "%s" check %s\n' "$recovery" "$bridge" "$rev"
  echo "  report it as: 未做二次 review：$rev $reason"
  exit 2
fi

{
  printf '## Round %s — %s reviews %s (%s)\n\n' "$round" "$rev" "$author" "$(date '+%Y-%m-%d %H:%M')"
  printf 'Repo: `%s` · scope: %s %s · HEAD `%s`\n\n' "$(basename "$(pwd)")" "$mode" "$ref" "$head_short"
  printf '%s\n\n' "$(redact < "$out")"
} >> "$report"
redact < "$out"
echo "second-review: round $round/$max by $rev → $verdict (log: $report)"
case "$verdict" in "VERDICT: CLEAN") exit 0;; *) exit 1;; esac
