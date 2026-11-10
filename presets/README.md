# Presets

Optional members (`agents/`) and routines (`routines.toml`) for software teams: PR review, CI upkeep, releases,
uptime alerts, open-source triage. New installs don't get them; the `workflow-coach` routine suggests them when the
owner's work needs one. To add one by hand, copy `agents/<id>/` into the data folder's `agents/` and the routine into
`config.toml`.

For PR closeout cards, copy `pr-closeout.md` to `policies/pr-closeout.md` and the optional `pr-closeout` routine to
`config.toml`. Set `owner.github`; provide `memory/release-cadence.md`, `tools/second-review.sh` and your project's
`tools/release-artifacts.mjs`. `noop pr-closeout --dry-run` previews cards without writing any hub file or changing GitHub;
`--enqueue` queues one owner-decision task per eligible repository. Only an explicit owner approval permits execution.
Discovery adds no Worker requests or polling path: it runs on the existing primary routine tick (at 30m, at most 48 scans
per day across three hosts), uses one GitHub search plus one batched GraphQL call, and writes only new decision tasks.
An unchanged fleet writes no additional files and triggers no model run. Normal hub sync carries new cards.
