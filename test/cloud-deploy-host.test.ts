import { expect, test } from "bun:test";
import { isCloudDeployHost, isPrimary } from "../src/core";

test("cloud deployment defaults to the primary", () => {
  const cfg = { fleet: { primary: "coordinator" } };
  expect(isCloudDeployHost(cfg, "coordinator")).toBe(true);
  expect(isCloudDeployHost(cfg, "macbook")).toBe(false);
});

test("designating a deployment host leaves coordination on the primary", () => {
  const cfg = { fleet: { primary: "coordinator" }, cloud: { deploy_host: "macbook" } };
  expect(isCloudDeployHost(cfg, "coordinator")).toBe(false);
  expect(isCloudDeployHost(cfg, "macbook")).toBe(true);
  expect(isCloudDeployHost(cfg, "other")).toBe(false);
  expect(isPrimary(cfg, "coordinator")).toBe(true);
  expect(isPrimary(cfg, "macbook")).toBe(false);
});

test("blank deployment host preserves the default", () => {
  expect(isCloudDeployHost({ fleet: { primary: "coordinator" }, cloud: { deploy_host: " " } }, "coordinator")).toBe(true);
});
