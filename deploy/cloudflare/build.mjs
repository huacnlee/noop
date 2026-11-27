// Downloads the Noop release this Worker runs: the Worker source (cloud/ and the app/ modules it imports) and the
// prebuilt web client, checked against the release's sha256sums. Runs on Cloudflare Workers Builds (Node + tar).
// NOOP_VERSION picks a release tag (e.g. v1.0.10); the default is the latest release.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.env.NOOP_REPO ?? "huacnlee/noop";
const OUT = "noop";

async function get(url) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function latestTag() {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual" });
  const tag = (res.headers.get("location") ?? "").match(/\/releases\/tag\/([^/?#]+)/)?.[1];
  if (!tag) throw new Error(`no latest release found for ${REPO} (HTTP ${res.status})`);
  return decodeURIComponent(tag);
}

function untar(file, dir, strip = 0) {
  mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["-xzf", file, "-C", dir, ...(strip ? [`--strip-components=${strip}`] : [])], { stdio: "inherit" });
}

const tag = process.env.NOOP_VERSION || (await latestTag());
console.log(`Noop ${tag}`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// the source at that tag
const src = join(OUT, "source.tar.gz");
writeFileSync(src, new Uint8Array(await (await get(`https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}`)).arrayBuffer()));
untar(src, OUT, 1);
rmSync(src);
if (!existsSync(join(OUT, "cloud", "src", "index.ts"))) throw new Error(`${tag} has no cloud/src/index.ts`);

// the web client of the same release, verified like `noop cloud deploy` does (src/webclient.ts)
const base = `https://github.com/${REPO}/releases/download/${tag}`;
const ASSET = "noop-web.tar.gz";
const sums = await (await get(`${base}/sha256sums`)).text();
const expected = sums.split("\n").map((l) => l.trim().split(/\s+\*?/)).find(([, name]) => name === ASSET)?.[0];
if (!expected) throw new Error(`${ASSET} is not in the ${tag} release`);
const bytes = new Uint8Array(await (await get(`${base}/${ASSET}`)).arrayBuffer());
const actual = createHash("sha256").update(bytes).digest("hex");
if (actual !== expected) throw new Error(`${ASSET}: checksum ${actual}, expected ${expected}`);
const web = join(OUT, "app", "dist", "web");
writeFileSync(join(OUT, ASSET), bytes);
untar(join(OUT, ASSET), join(web, "noop"));
rmSync(join(OUT, ASSET));
if (!existsSync(join(web, "noop", "index.html"))) throw new Error(`${ASSET}: not a web client`);
console.log(`✓ Worker source and web client of Noop ${tag} are in ./${OUT}`);
