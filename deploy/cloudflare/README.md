# Deploy Noop to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/huacnlee/noop/tree/main/deploy/cloudflare)

This template deploys your own Noop Worker: the coordination plane your machines sync through, and the web client you open in a browser. It runs in your Cloudflare account, and the free plan is enough.

It holds no Noop code itself. The build (`npm run build`, see `build.mjs`) downloads the latest Noop release: the Worker source from that tag and the prebuilt web client, checked against the release's `sha256sums`. Set `NOOP_VERSION` (e.g. `v1.0.10`) as a build variable to pin a release.

## Steps

1. Click the button. Cloudflare copies this template to a new repository in your GitHub account and deploys it.
2. When it asks for secrets, enter:
   - `HUB_TOKEN`: a long random string, for example from `openssl rand -hex 32`. Your machines use it to connect. Keep it.
   - `HUB_OWNER_EMAIL`: your email address. Only this address can sign in.
3. Note the Worker address, e.g. `https://noop.<you>.workers.dev`.
4. On an always-on macOS or Linux machine, connect it as the primary:

   ```bash
   curl -fsSL https://huacnlee.github.io/noop/install.sh | bash -s -- --primary https://noop.<you>.workers.dev --token <HUB_TOKEN>
   ```

   Add more machines with `install.sh` as usual.

## Email login codes

Signing in from a browser or the app sends a code to your email, so the Worker needs a sender. Pick one and add it as a secret in the Worker's Settings → Variables and Secrets:

- Cloudflare Email Routing: turn it on for one of your domains, verify your address, then set `HUB_MAIL_FROM` to an address on that domain (e.g. `noop@example.com`).
- SMTP: set `HUB_SMTP` to `{"host":"smtp.example.com","port":465,"secure":true,"user":"...","pass":"...","from":"..."}`.

Or fill in `[email]` in the shared `config.toml` and run `noop cloud deploy` on the primary after `bunx wrangler login`.

## Updates

A new Noop release does not reach this Worker by itself. To update, open the Worker in the Cloudflare dashboard and retry its latest build, or push any commit to your copy of this template. Or run `bunx wrangler login` once on the primary: it then redeploys the Worker on each Noop update, as installs from `install.sh --primary` do.
