import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDoc } from "../src/core";

test("metrics attribute retained rejected tasks to their recorded disposition", () => {
  const root = mkdtempSync(join(tmpdir(), "noop-rejected-metrics-"));
  const data = join(root, "data");
  const rejected = (id: string, meta: Record<string, string>) =>
    writeDoc(join(data, "tasks", "rejected", id + ".md"), { id, created: "2000-01-01T00:00:00Z", ...meta }, "");
  const batch = (id: string, items: string, answer: string, answered_by: string) =>
    writeDoc(join(data, "decisions", "closed", id + ".md"), { id, kind: "proposals", items, answer, answered_by }, "");

  try {
    batch("P-1", "T-3", "NONE: later", "owner(cli@mac)");
    batch("P-2", "T-4,,T-5", "3: do the last one", "owner(chat)");
    batch("P-3", "T-6", "superseded (rebuilt)", "system");
    batch("P-4", "T-10", "could we wait?", "owner(chat)");
    batch("P-5", "T-11", "all", "owner(chat)");
    batch("P-6", "T-12", "9", "owner(chat)");
    rejected("T-1", { approval: "superseded:T-20" });
    rejected("T-2", { cancelled: "2000-01-02", approval: "P-2" });
    rejected("T-3", { approval: "rejected:P-1" });
    rejected("T-4", { approval: "rejected:P-2" });
    rejected("T-5", { approval: "rejected:P-2" }); // the card actually picked this item
    rejected("T-6", { approval: "rejected:P-3" });
    rejected("T-7", { approval: "rejected:P-1" }); // absent from the linked card
    rejected("T-8", { approval: "rejected:P-missing" });
    rejected("T-9", {});
    rejected("T-10", { approval: "rejected:P-4" });
    rejected("T-11", { approval: "rejected:P-5" });
    rejected("T-12", { approval: "rejected:P-6" });

    rejected("T-13", { approval: "superseded:D-M0020" });
    rejected("T-14", { approval: "superseded:unrunnable" });
    rejected("T-15", { approval: "superseded:unknown" });

    const run = Bun.spawnSync([process.execPath, "src/cli.ts", "metrics", "1"], {
      env: { ...process.env, NOOP_HOME: root, HUB_DATA: data, HUB_SYNC: "local" },
    });
    expect(run.exitCode).toBe(0);
    const metrics = JSON.parse(readFileSync(join(data, "fleet", "metrics.json"), "utf8"));
    expect(metrics.proposals_rejected_total).toBe(15);
    expect(metrics.rejected_task_reasons).toEqual({
      scope: "all_retained_records", system_superseded: 2, system_unrunnable: 1, cancelled: 1,
      owner_batch_none: 1, owner_batch_unselected: 1, unclassified: 9,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
