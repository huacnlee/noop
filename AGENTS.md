## Workflow for Small Fixes

For small fixes with clear scope and acceptance criteria, make the change directly and verify it. Do not create design documents, specs, implementation plans, or extra approval checkpoints. Use a full design and planning workflow only when the change affects architecture or public APIs, spans multiple subsystems, or has materially ambiguous requirements.

## Cloudflare Free Plan Budget (hard rule)

Noop must run on the owner's Cloudflare Workers Free plan. The free plan allows, per account per day, 100k requests, 5M SQLite rows read and 100k rows written, and 5 GB of storage in total. Past a limit every operation of that kind fails until 00:00 UTC, and the account is shared with other projects. Noop's own steady state must stay under `TARGET` in `cloud/src/budget.ts`, a fifth of the free plan.

- `test/budget.test.ts` simulates a fleet day and fails when it goes over `TARGET`. Never raise `TARGET` or loosen the simulation to make a change pass. Redesign the change instead.
- Anything that talks to the Worker on a timer, or once per event, needs a budget argument before it lands: requests per day for three machines, rows written per request, and what it costs while nobody is looking.
- No polling where a push exists. Owner clients take `$status` frames over `/api/stream?v=2`, and the primary takes inbox nudges over the hibernating `/api/host/stream`. Fall back to slow polling only while the socket is down.
- Journals, logs and heartbeats (`latestOnly`) keep no history and are pushed lazily. Pulls are debounced. Do not add `{ force: true }` pushes outside shutdown and owner-visible update steps.
- No `OFFSET` pagination and no full-table scans on request paths. Rows read are billed per row, so walk by key and keep an index for every `WHERE`.
- The Worker meters itself (`/api/usage`; `noop status` prints today's numbers) and sheds fleet chatter past `SHED`. After deploying a change that affects traffic, check `/api/usage` or the Cloudflare analytics a few hours later.

## Update Noop on the user's iPhone

When asked to update Noop on the user's iPhone, build the current working-tree app, install it over Wi-Fi, and verify that it launches. The paired iPhone is `00008150-001603543C08401C`; the app bundle ID is `dev.noop.app`. Use `xcrun devicectl list devices` and device details to check connectivity.

The existing device build is `app/.nsh/out/noop.app`. Its embedded provisioning profile and signing authority identify the correct signing configuration: inspect the app with `codesign -dvv` and match its `Authority` to an identity from `security find-identity -v -p codesigning`. Do not assume the first certificate in the provisioning profile is the right identity. On 2026-11-02 the working identity was `Apple Development: Huashun Li (MJMFDP85B6)`, fingerprint `23A880371F9BA289EA15125ED6473F4C73F90BD6`.

Prefer `nsh package app --target ios --sign <identity> --profile <profile>` when the iOS runtime can be built. Copy the embedded profile to a temporary location first so it survives replacement of the output app. If the runtime build is blocked, the following workflow was verified with the existing runtime: `nsh build app --release -o <temporary-bundle>`, copy the existing app to a temporary `.app`, replace its `nsh/bundle.nshc`, `nsh/app.json`, and `nsh/capabilities.json` with the freshly built files, then sign the copy using the existing `app/.nsh/out/noop.entitlements`. This fallback reuses the existing native runtime; if native runtime changes are needed, build a fresh package instead.

Before installing, run `bash scripts/check-ios-sdk.sh <app-path>/<CFBundleExecutable>` on the actual packaged executable. It must link against iOS SDK 27 or newer to preserve Glass behavior. The installed Xcode SDK and successful packaging do not prove this: NSH may use a prebuilt runtime linked against an older SDK. If this check fails, use the existing SDK 27 runtime with the fresh application bundle as described above, or rebuild the native runtime; never install the older-SDK package. Include fresh assets when replacing the application bundle.

Verify the signature with `codesign --verify --strict`, install with `xcrun devicectl device install app --device 00008150-001603543C08401C <app-path>`, then launch with `xcrun devicectl device process launch --device 00008150-001603543C08401C dev.noop.app`. Preserve the bundle ID so the installation updates the existing app and retains its data. Report any build, signing, connection, or launch failure accurately.

## App Store release (iOS)

The App Store app is `Noop Agent` (Apple ID `6835723652`) in the "lei zhong" team (provider `1196602372`). Its bundle ID is `dev.huacnlee.noop`, set only when packaging for the App Store: `nsh package app --target ios --id dev.huacnlee.noop --sign <Apple Distribution identity> --profile <App Store profile>`. `app/nsh.json` keeps `dev.noop.app`, which the desktop, Android and sideloaded iPhone builds (above) still use, so their data and the Linux installer are unaffected. Before packaging locally, write the release version into `app/version.ts` as release CI does (`export const CLIENT_VERSION = "1.0.0";`), or Settings shows "This app: dev"; restore the file afterwards. Pass a `--build` higher than any build already uploaded. The iOS build needs an NSH runtime with `Dialog`'s `sheetHeight` / `sheetGrabber` (longbridge/nsh#2253) for the account sheet; until the nightly has it, package with a CLI built from that commit or later and check Settings shows its version. Run the same `scripts/check-ios-sdk.sh` check before uploading with `nsh publish ios --app-id 6835723652 ...` (an App Store Connect API key of that team, kept outside the repo).

App Review signs in with the test account `demo@noop.dev` (App Store Connect's sign-in information): entered as the email on the sign-in screen, "Send code" opens the in-app demo (`app/demo.ts`) at once, with no server, code or 2FA. The server address `demo` with code `DEMO2026` and 2FA `000000` also reaches it. It runs entirely on the device, so never point reviewers at a real Noop server. Keep the demo working when the hub's API changes; `app/demo.test.tsx` covers it.

### Release channels (1.0.1 onward)

All client channels share the release version. Before local packaging, run
`python3 scripts/prepare-client-release.py --version 1.0.1 --build <next-build> --channel store`
in an isolated checkout/copy; use `--channel direct` for desktop, Android and sideloaded iOS.
This sets both the native metadata and Settings version. Store builds retain
`dev.huacnlee.noop` and use `store-latest.json`; direct builds retain `dev.noop.app`
and `latest.json`. An existing 1.0.0 Store installation needs the new native Store
build once to adopt its separate update URL.

Store OTA packages require `NSH_STORE_PACKAGE_CERT` in release CI: a certificate
for the existing release public key, certified by the existing root specifically
for `dev.huacnlee.noop`. The direct-channel certificate only authorizes
`dev.noop.app`; do not reuse it for Store packages. Obtain owner approval before
extending signing authorization or configuring this secret. The Store manifest
is signed by the existing release key; NSH fetches its detached signature at
`latest.json.sig` beside `store-latest.json`. The direct manifest remains unsigned
and trusted through its GitHub source. CI's Store IPA is unsigned; sign and
validate the actual distribution IPA before requesting upload approval.
