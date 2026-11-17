#!/usr/bin/env bash
# Run the same executable `nsh package` ships, rather than an all-features test host.
set -euo pipefail
runtime="$(realpath "${1:?usage: check-linux-runtime.sh <Linux executable>}")"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:?set TMPDIR outside /tmp and any checkout}/noop-linux-runtime.XXXXXX")"
trap '(cd "$work" && rm -rf -- ./*); rmdir "$work"' EXIT
mkdir -p "$work/nsh"
"${NSH:-nsh}" build "$root/scripts/fixtures/linux-runtime/App.tsx" -o "$work/nsh"
printf '%s\n' '{"name":"Noop runtime check","id":"dev.noop.runtime-check"}' > "$work/nsh/app.json"
cp "$runtime" "$work/runner"
# Cold GTK/graphics initialization on shared runners can exceed five seconds.
# Keep the success marker mandatory, and print startup diagnostics on failure.
export RUST_LOG=info
code=0
if [[ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]]; then
  timeout --kill-after=5s 30s "$work/runner" > "$work/log" 2>&1 || code=$?
else
  xvfb-run -a timeout --kill-after=5s 30s "$work/runner" > "$work/log" 2>&1 || code=$?
fi
cat "$work/log"
if [[ "$code" != 0 && "$code" != 124 ]]; then
  exit "$code"
fi
if ! grep -q 'INFO js: NOOP_LINUX_RUNTIME_OK' "$work/log"; then
  echo "Linux runtime did not emit its success marker within 30s (exit $code)" >&2
  exit 1
fi
