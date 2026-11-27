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
// bun 1.4 resets the default timeout for each test file, so setDefaultTimeout here reached only the first file and
// every other one stayed at 5 s (e3c73ab failed 4 tests "timed out after 5000ms" at load ~30). Prepend the call to
// each test file as it loads, on its first line so stack-trace line numbers stay right. `bun test --timeout` would
// also work, but self-update runs plain `bun test` from the previous release's code.
const DEFAULT_TIMEOUT = 60_000;
setDefaultTimeout(DEFAULT_TIMEOUT);
Bun.plugin({
  name: "noop-test-timeout",
  setup(build) {
    build.onLoad({ filter: /\.test\.[jt]sx?$/ }, async ({ path }) => ({
      contents: `import { setDefaultTimeout as __noopTimeout } from "bun:test"; __noopTimeout(${DEFAULT_TIMEOUT}); ${await Bun.file(path).text()}`,
      loader: path.endsWith("x") ? "tsx" : path.endsWith(".ts") ? "ts" : "js",
    }));
  },
});

const W = mkdtempSync(join(tmpdir(), "hub-test-"));
process.env.NOOP_HOME = join(W, "home");
process.env.HUB_DATA = join(W, "data");
process.env.HUB_SYNC = "local";

// Core and sync refuse test imports unless this isolation setup ran first.
(globalThis as any)[Symbol.for("noop.test.isolated")] = true;
