# Noop

Your own AI team, so your day can be a no-op.

[Website](https://huacnlee.github.io/noop/) · [Download the app](https://github.com/huacnlee/noop/releases) · [Install](#install)

<img width="2000" height="1390" alt="The Noop app: the team channel with agent updates, beside lists of tasks" src="website/public/screenshot.png" />

Noop runs a small team of Claude Code and Codex agents on your own computers. They do your daily work, decide what they can based on how you've decided before, and only ask you when something really needs you — with a short list of options you answer in one tap.

- **Works for you, not with you** — give it a goal in one sentence; it breaks the work down, runs it in parallel and comes back with results.
- **Learns how you decide** — starts cautious, asks more early on, and takes over more as it proves it decides like you.
- **Quiet** — no noise, no raw errors. You hear about results and decisions, nothing else.
- **Yours** — runs on your machines and your own free Cloudflare account. No shared service, no one else's server; the only outside calls are anonymous usage statistics ([details](#usage-statistics)).

**If this helps you, please [sponsor me](https://github.com/sponsors/huacnlee).**

## Install

On an always-on macOS or Linux machine, once — it becomes the primary:

```bash
curl -fsSL https://huacnlee.github.io/noop/install.sh | bash -s -- --primary
```

You'll be asked to log in to your Cloudflare account once (the free plan is enough).

### Or deploy to Cloudflare with one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/huacnlee/noop/tree/main/deploy/cloudflare)

Prefer the Cloudflare dashboard to logging in from a terminal (for example on a headless server)? The button copies a small template to your GitHub and deploys the Noop Worker, with the web client, to your own account. When it asks, enter:

- `HUB_TOKEN`: a long random string, for example from `openssl rand -hex 32`. Keep it, the primary needs it.
- `HUB_OWNER_EMAIL`: your email address. Only this address can sign in.

Then connect the primary with your Worker address and that token:

```bash
curl -fsSL https://huacnlee.github.io/noop/install.sh | bash -s -- --primary https://noop.<you>.workers.dev --token <HUB_TOKEN>
```

The button deploys the latest release. To update the Worker later, retry the latest build of the Worker in the Cloudflare dashboard, or run `bunx wrangler login` once on the primary so it redeploys the Worker on each update. Email login codes also need a sender: see [deploy/cloudflare](deploy/cloudflare/README.md#email-login-codes).

On macOS, install from a terminal in your logged-in desktop session. Noop starts at login using a launchd agent and prevents idle sleep while running. Keep the primary Mac logged in and awake; sleep, logout or closing the lid pauses scheduling and chat processing until it returns. The same `--primary` command works on both platforms.

Add more machines whenever you like — they help when they're online and are never waited for:

```bash
# macOS or Linux
curl -fsSL https://huacnlee.github.io/noop/install.sh | bash
```

```powershell
# Windows
irm https://huacnlee.github.io/noop/install.ps1 | iex
```

## Client apps

The Noop app talks to your Noop from any device. It is optional: your Noop address also works in a browser.

```bash
# macOS (Apple silicon, macOS 14+) and Linux (x86_64, GTK 4.14+, such as Ubuntu 24.04)
curl -fsSL https://huacnlee.github.io/noop/install-client.sh | bash
```

```powershell
# Windows
irm https://huacnlee.github.io/noop/install-client.ps1 | iex
```

From v0.1.5 the desktop apps update themselves: when a new version has downloaded, the sidebar offers a restart. Earlier versions update by running the same command again.

- **Android** (9+): download [noop-android.apk](https://github.com/huacnlee/noop/releases/latest/download/noop-android.apk) on your phone and open it.
- **iOS** (15+): [noop-ios-unsigned.ipa](https://github.com/huacnlee/noop/releases/latest/download/noop-ios-unsigned.ipa) is not signed, so sign and install it with your own Apple ID using a tool such as Sideloadly or AltStore.

## Use

Open your Noop address on any device and sign in with a code sent to your email. On your phone, add it to the home screen and turn on notifications.

Then just talk to it. When it needs you, you'll get a notification with the choices; answer right there.

## Usage statistics

Noop counts usage with the author's own [NsMetry](https://github.com/huacnlee/nsmetry) instance on Cloudflare (no cookies, no fingerprinting, no IP address kept):

- The apps send the name of each screen opened (`/chat`, `/task`, `/settings`, ...), the app version, the OS and a random install ID, in batches. No email, Noop URL, task, channel, message or file name.
- The primary machine sends one heartbeat a day with the Noop build date, the OS family and a random install ID.
- Your Noop Worker sends one report a day with the Noop build date, a random install ID and counts only: machines online, devices signed in during the last day per platform (iOS, Android, macOS, Windows, Linux, web) and MCP connectors. It is redeployed with every Noop update, so it also covers apps that are not updated.
- The website counts page views.

The daemon heartbeat and the Worker report can be turned off with any of these (the Worker picks it up at its next deploy, `noop cloud deploy`):

```toml
# config.toml
[telemetry]
enabled = false
```

```sh
export NOOP_TELEMETRY=0   # or DO_NOT_TRACK=1
```

## License

MIT

## More projects

- [Disktree](https://huacnlee.github.io/disktree/) — A native disk-space explorer for macOS and Linux. See what fills your disk as a nested treemap, and review every path before removing anything.
- [Omasend](https://huacnlee.github.io/omasend/) — A native LocalSend client. Share files, folders, screenshots, and text over your local network, with no account or cloud upload.
- [Omamail](https://huacnlee.github.io/omamail/) — A native email and calendar app with multiple accounts and keyboard navigation. Runs as an Omarchy plugin or a standalone desktop app.
- [huacnlee/cargo](https://huacnlee.github.io/cargo/) — A drop-in Cargo fork: every git worktree of a project shares one build directory, which stays under a size limit on its own.
- [omarchy-mihoro](https://github.com/huacnlee/omarchy-mihoro) — An Omarchy bar panel for Mihoro. Monitor your proxy, switch between Rule, Global, and Direct modes, and manage subscriptions.
- [omarchy-which-key](https://github.com/huacnlee/omarchy-which-key) — Which Key for the desktop. Hold Super to see a shortcut guide drawn from your active Omarchy and Hyprland keybindings.
