# Wait checks

A `waiting` result frees the agent slot. The daemon polls `wait_check` locally with
5 → 10 → 20 → 40 minute backoff. Checks must be quick, read-only commands.

New machine waits default to `wait_check_mode: "success"`: exit 0 means ready,
including on the first poll or after a daemon restart. Every nonzero exit means
pending or an error, never completion. For example:

```json
{
  "status": "waiting",
  "summary": "Waiting for the result file",
  "waiting_on": "result.json",
  "wait_kind": "ci",
  "wait_minutes": 15,
  "wait_check": "test -f /path/to/result.json",
  "wait_check_mode": "success"
}
```

Use `wait_check_mode: "change"` when any exit-code transition should wake the
agent. For example, `gh pr checks` exits 8 while pending, 0 on success and 1 on
failure. Change mode detects either terminal result after observing 8; success
mode wakes only on 0, leaving failed checks to the existing 120-minute fallback.
A failed launch, timeout or signal supplies no result in either mode.

Existing task files with no mode retain change semantics. The daemon persists
the first exit code together with the command in `wait_check_base`, so a restart
does not lose the baseline. Old zero baselines cannot be safely interpreted as
completion: some commands intentionally wait for a nonzero transition. There is
no automatic migration of those tasks; a new machine wait records its mode
explicitly. Success-mode polls do not write baselines or update task files.

Human waits always retain change semantics, even if success mode was requested.
They have no timed wake-up: only an observed event or an owner reply resumes the
agent. An initial exit 0 does not release a human wait. A check never answers an
owner decision or grants approval; blocked decision tasks are outside this check
loop. Resuming an agent means it checks the condition again before continuing.

This adds no polling interval or Worker requests. For three machines, additional
requests/day and rows written/request are both 0; while unattended, unchanged
success-mode polls only run a local process and write no hub files. Legacy change
mode retains its one baseline write per newly parked wait.
