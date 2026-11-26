import { expect, test } from "nsh/test";
import { agentDisplayName, avatarOf } from "./avatars";


test("every fleet agent id and name has an avatar", () => {
  const ids = ["lead", "reviewer", "rust-maintainer", "release-manager", "ops-watcher", "chief-of-staff", "dispatcher", "architect", "reporter", "apprentice", "oss-triage", "planner"];
  for (const id of ids) expect(avatarOf(id)).not.toBeNull();
  expect(avatarOf("Zhenyuan@huacnlee-omarchy-lb")).not.toBeNull();
});

test("the planner is shown as Zhenyuan", () => {
  expect(agentDisplayName("Zhenyuan@host", false)).toBe("Zhenyuan");
  expect(agentDisplayName("planner", true)).toBe("镇元子");
});
