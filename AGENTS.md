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

The App Store app is `Noop Agent` (Apple ID `6835723652`) in the "lei zhong" team (provider `1196602372`). Its bundle ID is `dev.huacnlee.noop`, set only when packaging for the App Store: `nsh package app --target ios --id dev.huacnlee.noop --sign <Apple Distribution identity> --profile <App Store profile>`. `nsh.json` keeps `dev.noop.app`, which the desktop, Android and sideloaded iPhone builds (above) still use, so their data and the Linux installer are unaffected. Before packaging locally, write the release version into `app/version.ts` as release CI does (`export const CLIENT_VERSION = "1.0.0";`), or Settings shows "This app: dev"; restore the file afterwards. Pass a `--build` higher than any build already uploaded. The iOS account sheet uses a content-height detent and the system grabber (longbridge/nsh#2243). Use a runtime that includes longbridge/nsh#2253 so the glass follows the app’s appearance. Run the same `scripts/check-ios-sdk.sh` check before uploading with `nsh publish ios --app-id 6835723652 ...` (an App Store Connect API key of that team, kept outside the repo).

App Review signs in with the test account `demo@noop.dev` (App Store Connect's sign-in information): entered as the email on the sign-in screen, "Send code" opens the in-app demo (`app/demo.ts`) at once, with no server, code or 2FA. The sign-in screen also shows a "Try the demo" link (all platforms, not on a self-served web page) that opens the same demo. The server address `demo` with code `DEMO2026` and 2FA `000000` also reaches it. It runs entirely on the device, so never point reviewers at a real Noop server. Keep the demo working when the hub's API changes; `app/demo.test.tsx` covers it.

### Release channels (1.0.1 onward)

All client channels share the release version. Before local packaging, run
`python3 scripts/prepare-client-release.py --version 1.0.1 --build <next-build> --channel store`
in an isolated checkout/copy; use `--channel direct` for desktop, Android and sideloaded iOS.
This sets both the native metadata and Settings version. Store builds retain
`dev.huacnlee.noop` and use `store-latest.json`; direct builds retain `dev.noop.app`
and fetch the signed direct manifest via /api/updates/direct/latest.json. Legacy Store
1.0.0 installations fetch the same Store package through the generic latest.json alias.

Store OTA packages require `NSH_STORE_PACKAGE_CERT` in release CI: a certificate
for the existing release public key, certified by the existing root specifically
for `dev.huacnlee.noop`. The direct-channel certificate only authorizes
`dev.noop.app`; do not reuse it for Store packages. Obtain owner approval before
extending signing authorization or configuring this secret. The Store manifest
is signed by the existing release key; NSH fetches its detached signature at
`latest.json.sig` beside `store-latest.json`. Publish the signed Store manifest at both store-latest.json and latest.json for legacy Store installations. Direct releases use the signed direct-latest.json and its signature via the direct channel endpoint. CI's Store IPA is unsigned; sign and
validate the actual distribution IPA before requesting upload approval.

### Publishing a release to the App Store

Verified with 1.0.9 (build 115) on 2026-11-24. Nothing secret lives in this repository; everything is on the owner's
Mac under `~/.appstoreconnect/` (mode 700/600). `source ~/.appstoreconnect/noop.env` sets the App Store Connect API
key (`NSH_APP_STORE_*`, a team key: it needs the issuer ID, which that file holds), the signing identity
(`NOOP_STORE_SIGN_IDENTITY`) and the App Store profile (`NOOP_STORE_PROFILE`). Never commit these values.

1. Release from CI, not from a local NSH. The release workflow pins `NSH_REF`; the locally installed nightly CLI can be
   ahead of it (on 2026-11-24 it had already moved `Speech` out of `nsh`, so a local `nsh package` failed). Tag
   `origin/main` as `vX.Y.Z` and push the tag; that release run's number is the build number of every client, higher
   than any build uploaded before. Download `noop-ios-store-unsigned.ipa` from the run (`gh run download`).
2. Sign by hand. Use `$NOOP_STORE_SIGN_IDENTITY` (an `Apple Distribution: lei zhong (6K2XXVCSDD)` certificate in the
   login keychain, key and certificate also in `~/.appstoreconnect/distribution/`). Ignore the identical-looking
   identity in `noop-release.keychain-db`: that keychain's password is lost, so codesign fails with
   `errSecInternalComponent`. Xcode's own account is not in the "lei zhong" developer team, so do not rely on Xcode
   automatic signing. Unzip the IPA, copy `$NOOP_STORE_PROFILE` to `Payload/Noop.app/embedded.mobileprovision`, sign
   `Noop.app` with entitlements taken from the profile (`application-identifier` `6K2XXVCSDD.dev.huacnlee.noop`,
   `com.apple.developer.team-identifier`, `beta-reports-active` true, `get-task-allow` false, `keychain-access-groups`
   `6K2XXVCSDD.dev.huacnlee.noop`) using `codesign -f -s "$NOOP_STORE_SIGN_IDENTITY" --entitlements … --generate-entitlement-der`,
   and zip `Payload` again. When the profile expires (2027-11-24) or a capability changes, create a new
   `IOS_APP_STORE` profile for bundle ID `dev.huacnlee.noop` with that certificate through the App Store Connect API.
3. Run `scripts/check-ios-sdk.sh` on `Payload/Noop.app/Noop` (SDK 27 or newer) and `codesign --verify --strict` on the
   signed app.
4. Ask the owner, then upload with `nsh publish ios <ipa>`; the env file supplies the app ID, issuer ID, key ID and key.
   Check first with `nsh publish doctor ios` (read-only) when the CLI has it. The upload CLI is the local one, not
   the pinned release NSH, so mind which features it has:
   - longbridge/nsh#3101 (on nsh `main` from 2026-11-24, not yet in the nightly of that day) makes `nsh publish ios`
     wait for processing, answer export compliance, add the build to TestFlight groups, create or reuse the App Store
     version for the IPA's version, attach the build and write the store listing; it submits for review only with
     `--submit`. Use `--testflight-only` to stop after TestFlight, `--no-wait` to stop once the upload is accepted.
     It reads `store.ios` from `nsh.json` (`appId`, `usesNonExemptEncryption`, `betaGroups`, `release`) and the
     listing from `store.locales` or `store/<locale>/`. Noop's `nsh.json` has no `store` block yet, so the env file's
     `NSH_APP_STORE_APP_ID` names the app; add `store.ios` (and `"ITSAppUsesNonExemptEncryption"` in
     `ios.infoPlist`) only with the owner's answers, since they become the App Store listing.
   - Older CLIs (0.6.0, nightly 2026-11-23) only upload. Then `nsh publish status ios` / `doctor ios` do not exist,
     and the build waits in App Store Connect for TestFlight groups and the version to be set by hand.
   - Every CLI up to nsh `main` of 2026-11-24 commits the upload with a SHA_256 `sourceFileChecksums`, which App Store
     Connect rejected with HTTP 409 for 1.0.9: the parts are uploaded but the command fails. Do not upload again:
     complete that same upload by PATCHing its `buildUploadFiles/<id>` with `uploaded: true` and an `MD5`
     `sourceFileChecksums.file` (the API key signs the request), then wait for `buildUploads/<id>` to reach
     `COMPLETE` and the build to be `VALID`. With a CLI that waits, run `nsh publish status ios` afterwards and finish
     TestFlight and the version in App Store Connect.
5. Follow it up with `nsh publish status ios` (exit 0 live, 10 processing or in review, 11 draft, 12 action needed)
   where available, or in App Store Connect. Privacy details, age rating and pricing stay in App Store Connect.
