import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { adoptedWorker } from "../src/setup";

const root = join(import.meta.dir, "..");
const cli = Bun.TOML.parse(readFileSync(join(root, "cloud", "wrangler.toml"), "utf8")) as any;
// full-line // comments only: values such as "/*.wasm" contain comment-like characters
const jsonc = readFileSync(join(root, "deploy", "cloudflare", "wrangler.jsonc"), "utf8");
const button = JSON.parse(jsonc.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));

test("the Deploy to Cloudflare template deploys the same Worker as `noop cloud deploy`", () => {
  expect(button.name).toBe(cli.name);
  expect(button.main).toBe(`noop/cloud/${cli.main}`);
  expect(button.compatibility_date).toBe(cli.compatibility_date);
  expect(button.workers_dev).toBe(cli.workers_dev);
  const { directory, ...assets } = button.assets;
  const { directory: cliDirectory, ...cliAssets } = cli.assets;
  expect(cliDirectory).toBe("../app/dist/web/noop");
  expect(directory).toBe("noop/app/dist/web/noop");
  expect(assets).toEqual(cliAssets);
  expect(button.durable_objects).toEqual(cli.durable_objects);
  expect(button.migrations).toEqual(cli.migrations);
  expect(button.send_email).toEqual(cli.send_email);
});

test("the template asks for the secrets a fresh Worker needs", () => {
  const vars = readFileSync(join(root, "deploy", "cloudflare", ".dev.vars.example"), "utf8");
  expect(vars).toContain("HUB_TOKEN=");
  expect(vars).toContain("HUB_OWNER_EMAIL=");
  const pkg = JSON.parse(readFileSync(join(root, "deploy", "cloudflare", "package.json"), "utf8"));
  expect(pkg.scripts.build).toBe("node build.mjs");
  expect(Object.keys(pkg.cloudflare.bindings)).toEqual(["HUB_TOKEN", "HUB_OWNER_EMAIL"]);
});

test("a primary adopts a button-deployed Worker by its address and token", () => {
  expect(adoptedWorker("https://noop.alice.workers.dev/", " t0ken ")).toEqual({ cloud: { url: "https://noop.alice.workers.dev", name: "noop" }, token: "t0ken" });
  expect(adoptedWorker("https://my-team.alice.workers.dev", "t")?.cloud.name).toBe("my-team");
  expect(adoptedWorker("https://noop.example.com", "t")?.cloud).toEqual({ url: "https://noop.example.com", name: "noop" });
  expect(adoptedWorker("https://noop.alice.workers.dev", "")).toBeNull();
  expect(adoptedWorker("https://noop.alice.workers.dev")).toBeNull();
  expect(adoptedWorker("noop.alice.workers.dev", "t")).toBeNull();
});
