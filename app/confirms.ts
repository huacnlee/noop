// Confirmations the owner sees now and then: a lazy chunk, loaded by the first one asked (lazy.tsx).
import { AlertDialog } from "nsh/base";
import { L } from "./i18n";
import type { Hub } from "./connection";

/** Ask before ending a task: cancel it, or mark it done when the owner finished it himself. */
export async function confirmEndTask(id: string, done: boolean, running: boolean): Promise<boolean> {
  const r = done
    ? await AlertDialog.show({
      title: L(`Mark ${id} as done?`, `把 ${id} 标记为完成？`),
      description: running ? L("The running agent will be stopped and the task marked done.", "正在运行的 agent 会被停下，任务记为完成。") : L("The task will be marked done and won’t run again.", "任务记为完成，不再执行。"),
      actions: [
        { id: "keep", label: L("Back", "返回"), role: "cancel" },
        { id: "end", label: L("Mark as done", "标记完成") },
      ],
    })
    : await AlertDialog.show({
      title: L(`Cancel ${id}?`, `取消 ${id}？`),
      description: running ? L("The running agent will be stopped. Changes it already made stay in the repository.", "正在运行的 agent 会被停下，已经做了的改动保留在仓库里。") : L("This task won’t run again.", "这个任务不会再执行。"),
      actions: [
        { id: "keep", label: L("Keep", "不取消"), role: "cancel" },
        { id: "end", label: L("Cancel task", "取消任务"), role: "destructive" },
      ],
    });
  return r.action === "end";
}

/** Ask every machine to update to the latest code; the primary also redeploys the web app and the Worker. */
export async function updateAllMachines(hub: Hub) {
  const r = await AlertDialog.show({
    title: L("Update all machines?", "更新所有机器？"),
    description: L("Each machine pulls the latest code and restarts. Idle machines update now; busy ones restart when their tasks finish. The primary also redeploys the server.", "每台机器拉取最新代码后重启：空闲的马上更新，有任务在跑的等跑完再重启。主控机同时重新发布线上。"),
    actions: [
      { id: "cancel", label: L("Cancel", "取消"), role: "cancel" },
      { id: "update", label: L("Update", "更新") },
    ],
  });
  if (r.action === "update") await hub.api("POST", "/api/fleet/update").catch(() => {});
}
