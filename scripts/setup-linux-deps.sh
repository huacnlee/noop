#!/usr/bin/env bash
# The app links a Rust nshm, so every target builds Rust here: QuickJS needs clang, WebAssembly objects llvm-ar,
# and the Linux host GTK 4 and GStreamer. Installed packages are skipped, so warm runners refresh nothing.
set -euo pipefail
packages=(clang llvm libclang-dev pkg-config)
if [[ "$TARGET" == linux ]]; then
  packages+=(libgtk-4-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev)
fi
if [[ "$TARGET" == linux ]]; then
  packages+=(libgtk-4-1 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 xvfb xauth)
fi
missing=()
for package in ${packages[@]+"${packages[@]}"}; do
  if [[ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]]; then
    missing+=("$package")
  fi
done
if (( ${#missing[@]} )); then
  sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update
  sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 install -y --no-install-recommends "${missing[@]}"
fi
