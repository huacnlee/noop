import { expect, test } from "bun:test";
import { winTaskXml } from "../src/setup";

test("the Windows task runs headless, comes back within a minute and has no battery or time limits", () => {
  const x = winTaskXml("PC\\me & you", "C:\\Users\\me\\.bun\\bin\\bun.exe", "C:\\Users\\me\\.noop\\app\\src\\cli.ts", "C:\\Users\\me\\.noop\\data\\logs\\daemon.log",
    "C:\\Windows", new Date(2026, 10, 27, 9, 5, 42));
  // no window: a headless console, output appended to the daemon log
  expect(x).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
  expect(x).toContain("<Arguments>--headless cmd.exe /d /c &quot;&quot;C:\\Users\\me\\.bun\\bin\\bun.exe&quot; &quot;C:\\Users\\me\\.noop\\app\\src\\cli.ts&quot; start --foreground &gt;&gt; &quot;C:\\Users\\me\\.noop\\data\\logs\\daemon.log&quot; 2&gt;&amp;1&quot;</Arguments>");
  // kept alive: a time trigger from the install on repeats every minute (a logon trigger's repeat would only begin at
  // the next logon), and a repeat while the daemon runs is dropped; the logon trigger starts it at logon
  expect(x).toMatch(/<TimeTrigger>[\s\S]*<StartBoundary>2026-11-27T09:05:00<\/StartBoundary>[\s\S]*<Interval>PT1M<\/Interval>[\s\S]*<\/TimeTrigger>/);
  expect(x).toMatch(/<LogonTrigger>(?:(?!<Repetition>)[\s\S])*<\/LogonTrigger>/);
  expect(x).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  expect(x).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
  expect(x).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
  expect(x).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  // the logon session, so GUI work still has a desktop
  expect(x).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(x).toContain("<UserId>PC\\me &amp; you</UserId>");
});

test.skipIf(process.platform !== "win32" || !process.env.NOOP_TEST_SCHTASKS)("Task Scheduler accepts the task (NOOP_TEST_SCHTASKS=1, registers a disabled throwaway task)", async () => {
  const { $ } = await import("bun");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const file = join(mkdtempSync(join(tmpdir(), "noop-task-")), "task.xml");
  const xml = winTaskXml(user, process.execPath, "cli.ts", join(tmpdir(), "noop-task.log"), process.env.SystemRoot).replace("<Enabled>true</Enabled>\n    <Priority>", "<Enabled>false</Enabled>\n    <Priority>");
  writeFileSync(file, Buffer.from(`\ufeff${xml}`, "utf16le"));
  const name = `noop-xml-check-${process.pid}`;
  try {
    const r = await $`schtasks /Create /F /TN ${name} /XML ${file}`.quiet().nothrow();
    expect(r.exitCode).toBe(0);
    const q = (await $`schtasks /Query /TN ${name} /XML`.quiet().nothrow()).stdout.toString();
    expect(q).toContain("PT1M");
    expect(q).toContain("--headless");
  } finally {
    await $`schtasks /Delete /F /TN ${name}`.quiet().nothrow();
  }
});
