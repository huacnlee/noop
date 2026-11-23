// Runs before every test file: point the hub at a throwaway home/data dir so no test can touch a real ~/.noop or ~/.agent-hub.
import { setDefaultTimeout } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Self-update validates a release by running this suite on whatever load the host has. On this Mac that is load
// 200-370 with a 99%-full disk, 23 GB of swap in use and Spotlight indexing: sub-second tests stall for 5-9 s and
// hooks for tens of seconds, which failed valid releases on wall-clock rather than on a regression. Give every test
// and hook room; tests with a real wall-clock budget (fleet day, git spawns, tar spawns, login shells, worker
// subprocesses) still set their own, larger one.
setDefaultTimeout(60_000);

const W = mkdtempSync(join(tmpdir(), "hub-test-"));
process.env.NOOP_HOME = join(W, "home");
process.env.HUB_DATA = join(W, "data");
process.env.HUB_SYNC = "local";
