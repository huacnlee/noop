// A CLI whose API endpoint (often a local gateway) is down fails with a connection error. That is not
// a login/quota problem: the run must fail over to the other CLI (or be requeued for a later tick) and
// never start a remote-login flow. The exact shape below is what Claude Code stream-json prints.
import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR, DATA } from "../src/core";
import { classify, failoverAccount, reportFailure, TRANSIENT_COOLDOWN_MS, type Account } from "../src/accounts";

beforeAll(() => { mkdirSync(join(DATA, "journal"), { recursive: true }); });

const REAL_RUN = [
  '{"type":"system","subtype":"api_retry","attempt":1,"error":"unknown"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"}]}}',
  '{"type":"result","api_error":"connection_failed","result":"API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)","is_error":true}',
  "[exit 1] ",
].join("\n");

const claude: Account = { cli: "claude", name: "zz-transient", dir: "" };
const stateFile = join(HOME_DIR, "accounts", "state.json");
const readState = () => JSON.parse(readFileSync(stateFile, "utf8")).accounts["claude-zz-transient"] ?? {};

test("classify: connection failures are transient, quota/auth still win their own kind", () => {
  expect(classify(REAL_RUN)).toBe("transient");
  expect(classify("API Error: Connection refused (ECONNREFUSED)")).toBe("transient");
  expect(classify('"api_error":"connection_failed"')).toBe("transient");
  expect(classify("fetch failed: ECONNRESET")).toBe("transient");
  expect(classify("Error: socket hang up")).toBe("transient");
  expect(classify("HTTP 503 Service Unavailable")).toBe("transient");
  expect(classify("usage limit reached, resets at 3pm")).toBe("quota");
  expect(classify("Not logged in · Please run /login")).toBe("auth");
  expect(classify('```json\n{"status":"done","summary":"ok"}\n```')).toBeNull();
  // a report that merely mentions a status code is not an outage
  expect(classify("PR 502 was merged, all checks passed")).toBeNull();
});

test("reportFailure(transient): short cooldown, no login flag, no login flow", async () => {
  await reportFailure(claude, "transient", REAL_RUN, {} as any);
  const st = readState();
  expect(st.cooldown_until).toBeTruthy();
  expect(Date.parse(st.cooldown_until) - Date.now()).toBeLessThan(TRANSIENT_COOLDOWN_MS + 5000);
  expect(Date.parse(st.cooldown_until)).toBeGreaterThan(Date.now());
  expect(st.needs_login).toBeUndefined();
  expect(st.told).toBeUndefined();
});

test("transient cooldown makes the account unusable so failover picks the other CLI", async () => {
  await reportFailure(claude, "transient", REAL_RUN, {} as any);
  const all = () => true;
  // Real single-account setup: accounts(cfg, cli) synthesized "default" for each CLI. The failing
  // claude default is now cooling and must be skipped; codex default is the hop.
  const cfg = { accounts: [{ cli: "claude", name: "zz-transient" }, { cli: "codex", name: "zz-codex" }] } as any;
  const failed = { cli: "claude", name: "zz-transient", dir: "" };
  const next = failoverAccount(cfg, failed, ["claude", "codex"], all);
  expect(next?.cli).toBe("codex");
  // and with codex missing, there is nothing to hop to → the task is requeued for a later tick
  expect(failoverAccount(cfg, failed, ["claude", "codex"], (c) => c === "claude")).toBeNull();
});
