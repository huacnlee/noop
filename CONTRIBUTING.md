# Contributing to Noop

Technical reference for people and AI agents working on this codebase.

## Third-party pull requests

Noop accepts third-party pull requests only for:

- Bug fixes.
- Security fixes.
- Performance optimizations.

Noop was not intended to accept third-party pull requests that shape the product. Changes to product design, scheduling behavior, workflows, or product details are not accepted. New features and other changes outside the three categories above will be declined.

Keep fixes focused on the existing behavior. A bug fix, security fix, or performance optimization must not bundle unrelated product or workflow changes.

## Principles

- Single owner. Noop serves one person (the CEO); there is no multi-tenant or shared service. Each user deploys their own Cloudflare Worker.
- No personal data or secrets in this repository. Templates are generic.
- Everything is Bun + TypeScript. The client is written with NSH.
- The owner only sees results and decisions. Never surface raw errors, internal routine failures or test data.

## Docs

- [docs/architecture.md](docs/architecture.md) — how Noop works: sync, Worker API, code layout, agents and safety.

## Development

```bash
bun install
bun test                 # unit + sync tests
bash test/e2e.sh         # offline end to end (fake CLI, HUB_SYNC_FAKE store)
bunx tsc --noEmit
```

Worker:

```bash
cd cloud && bunx wrangler dev --port 8799 --var HUB_TOKEN:test
bun cloud/test/run.ts http://127.0.0.1:8799      # file sync harness (see cloud/test)
```

The app uses the current NSH nightly, matching release CI. Install it with `curl -fsSL https://nsh.dev/install.sh | sh -s -- --nightly`, or run `nsh update nightly` with an existing installation. The client's `nsh.json` is at the repository root, beside `package.json`, and names its entry (`"entry": "app/App.tsx"`; this needs an NSH nightly with `nsh.json` `entry`): run `nsh run` and `nsh test` from the root. Run `app/build-web.sh` (from any directory). `app/dist` is not in git: `wrangler dev` needs that build first, and a machine leaves a local build alone instead of downloading the release's.

Website: see [website/README.md](website/README.md). `website/` is the public project site on GitHub Pages and serves the installers; `web/` is the page each owner's Worker serves.

## Releasing the client apps

Push a tag `vX.Y.Z`. [release.yml](.github/workflows/release.yml) packages Linux, Windows, macOS, iOS, Android and the web client and publishes them as a GitHub release, and machines pick up the web client from it; pull requests that change the workflow or the installers build them without publishing. The tag sets the app version and the run number sets the build number.

The release also carries `latest.json` and versioned archives (`Noop-<version>-<os>-<arch>`): installed desktop apps update from them through `nsh/updater`, and the Android app gets a link to the APK. Keep the unversioned assets too, the installers use them.

The workflow resolves `NSH_REF: nightly` to a commit and caches the CLI and runtimes by that commit. It uses prebuilt nightly assets where supported. Android signing uses the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS` and `ANDROID_KEYSTORE_PASSWORD`. Keep that key: Android refuses an update signed with another one. The iOS package is unsigned.

Do not run tests against a production Worker or a live `DATA` directory.
