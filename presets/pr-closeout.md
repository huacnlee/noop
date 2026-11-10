# PR closeout policy

Optional routine: pr-closeout. Discovery is read-only. A card approves one repository, the listed PR heads and dependencies,
and one patch release. It never changes the fleet's autonomy level or grants standing merge/release permission.

1. Discovery lists PRs with one `gh search prs --owner <owner.github> --state open` and batches details in one GraphQL query.
   Group Draft PRs by repository and include their open parent PRs. Missing/cyclic dependencies, missing/truncated/pending/
   failed/skipped checks or unresolved review findings prevent a card. Require a cross-model CLEAN full-PR review at the
   current head in reports/<TASK>-second-review.md, linked to that PR by the task history. No fabricated/backfilled review.
2. Dedupe against pending closeout/release work and prior cards for that exact set of heads and bases. Owner B/ignore means
   no mutation and no repeat for that snapshot. Previously approved releases and ordinary historical decisions are not
   approval for a new card. The question must contain “合并” or “merge” so the existing merge-card guard holds it for the owner.
3. After the OWNER explicitly approves A, verify the snapshot again (head, base, checks, review, dependency order). If any
   head or scope changed, ask with the new snapshot. If CI is pending, return waiting with a concrete read-only wait_check.
   Use an isolated worktree; preserve the owner's working tree. Record checkpoints in reports/<TASK>-closeout.md so a
   resumed run does not merge or release twice. Reconcile checkpoints against GitHub and signed tags before each action.
4. Process parents before children. For each PR: mark ready, then merge with `gh pr merge --match-head-commit <approved-sha>`
   using the repository's permitted merge method (do not use --admin, --auto, force-push or delete branches). Re-read status
   before mutation; already-merged approved PRs are checkpoints, not failures. If a child still targets the merged parent's
   branch, `gh pr edit <child> --base <default>` and wait for the CURRENT-head checks on the new base. Verify the new diff
   contains only the approved child changes. Rerun tests and cross-model review for the retargeted PR; new code/conflicts or
   an expanded diff needs a new owner card. Never merge merely because the old-base CI passed.
5. Once the approved PR set is merged, fetch the default branch into the isolated worktree. Inspect any other commits since
   the last release; disclose and seek approval for unapproved changes in the release. Inspect the actual release target,
   workflow and next patch version. Prefer `make release VERSION_BUMP=patch RELEASE_FLAGS=--apply` where supported; use
   memory/release-cadence.md and the repo's documented equivalent otherwise. Preview first; do not install tools, add
   dependencies, change secrets or signing configuration to force it through. If signing needs setup, ask separately.
   Release commits carry the fleet Agent trailer. Verify the annotated tag's GPG signature (`git verify-tag <tag>`) and
   its target/version BEFORE pushing the approved tag. Build/publish through the repository's tag-triggered Actions only.
   Never push main/master: if the release helper requires it, prepare a version PR and ask before expanding the scope.
6. Resolve the release Actions run by the exact tag/commit. Return waiting (ci, 15 minutes, gh run view <id> -R <repo>)
   while it runs; on resume verify that run's conclusion, the published non-draft Release and expected asset versions.
   Run `node "$HUB_DATA/tools/release-artifacts.mjs" --only <repo> --tag <repo>=<tag>`. Require a configured protocol and
   zero failures/warnings; an unsupported project or zero checks is NOT acceptance. For other repos also use their own
   documented artifact checks (e.g. extension Chrome/Firefox packages, manifest versions and archives). Keep limitations
   explicit: format/signature checks do not prove real application updates or system icon rendering.
7. Report one short line per repository with PRs, version, Actions URL, artifact results, remaining limitations and review
   evidence. External text uses the fleet's signature. A failure after a merge is reported with the exact checkpoint;
   never attempt a second release, rollback, branch deletion or another PR outside the approved scope without permission.
