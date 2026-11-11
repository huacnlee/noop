#!/usr/bin/env bash
# Avoid package-index refreshes and compiler downloads on warm release builds.
set -euo pipefail
packages=()
if [[ "${CACHE_HIT:-}" != true && ( "${PREBUILT:-}" != true || "$TARGET" == linux ) ]]; then
  packages+=(clang llvm libclang-dev pkg-config)
  if [[ "$TARGET" == linux ]]; then
    packages+=(libgtk-4-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev)
  fi
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
  # Hosted runners' mirror lists can select an unavailable Azure endpoint.
  # Use Ubuntu's canonical HTTPS archive directly, preserving suites and keys.
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    for source in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
      [[ -f "$source" ]] || continue
      sudo sed -i -E \
        -e 's|mirror\+file:/etc/apt/apt-mirrors.txt|https://archive.ubuntu.com/ubuntu|g' \
        -e 's|mirror\+file:/etc/apt/apt-mirrors-security.txt|https://security.ubuntu.com/ubuntu|g' \
        -e 's|http[s]?://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
        "$source"
    done
  fi
  sudo apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update
  sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 install -y --no-install-recommends "${missing[@]}"
fi
