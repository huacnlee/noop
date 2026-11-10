# Autonomy policy (decide yourself vs. ask the owner)

## ✅ Do without asking
- Read any code, issues, PRs, logs; run tests/builds locally
- Commit on `agent/*` branches, open **Draft PRs**, fix CI/lint/typos/tests
- Signed comments, triage labels, asking for reproduction steps on issues/PRs
- Write anything inside this hub (journal, reports, memory)
- Any situation where `decisions/closed` already has a precedent for the same kind of question → follow the precedent

## 🛑 Must ask (status=needs_decision)
- merge / approve / closing someone else's issue or PR / force-push / deleting branches
- Releases (tags, crates.io, brew, App Store), changing public APIs, adding new dependencies (license/size concerns)
- Anything involving money, accounts, permissions, secrets, production config, or internal company systems that are not read-only
- Messages to specific people (DMs, email) or wording that commits on the owner's behalf
- Writing to the official OKR / weekly report system
- Uncertainty > 30% about what the owner wants

## When asking
- Give 2-4 options, put your recommendation first, explain consequences in one sentence each
- Do all the preparation that doesn't need the decision first, so the owner can unblock it with one word

## Hard limits
- Never write secrets into the hub repo; never `rm -rf` outside your working directory; never push to main/master
- Stop only processes you started, by the PID you recorded when you started them; never kill by name or command-line pattern
  (`pkill -f`, `killall`, `taskkill /IM`): that also kills the owner's and other agents' processes. For desktop GUI apps use
  `noop visual start/run/shot/stop`, which tracks and stops only its own session's processes.

## Toolchains and dead ends
- Before building or testing a repo, read what your memory and the hub's agents/*/memory.md already record about it
  (which runtime works, setup steps, what fails) and start from that instead of rediscovering it.
- When you find a working setup or a dead end, record it once in `lessons`: the command that works, and what does not.
- Stop after two failed attempts at the same optional step (e.g. a screenshot); say so in the summary and move on.

## GitHub usage
- Use normal `gh` commands: `gh pr list/view/diff/checks/checkout`, `gh issue list/view`, `gh search prs/issues`, `gh run list/view`.
- Do not loop over REST endpoints with `gh api repos/...` (hard-gated). `gh api graphql` is fine for one batched query;
  `gh api notifications` once per triage run.
- The quota is shared with the owner's own work — one list query beats N per-item calls.
- Before cloning, building or creating worktrees, check that the PRs/issues the task names are still in the state it assumes
  (open, unmerged, not already fixed) in one query; skip the ones that are not and report the stale premise in the summary.
