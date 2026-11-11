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
  # Probe signed Ubuntu archives before apt's per-suite retries. Some runners
  # cannot resolve Ubuntu's domains even while other HTTPS hosts work.
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    . /etc/os-release
    archive=''
    for candidate in https://archive.ubuntu.com/ubuntu https://mirrors.edge.kernel.org/ubuntu; do
      if curl --fail --silent --show-error --location --connect-timeout 5 --max-time 10 \
        --output /dev/null "$candidate/dists/$VERSION_CODENAME/InRelease"; then
        archive="$candidate"
        break
      fi
    done
    if [[ -z "$archive" ]]; then
      echo 'No Ubuntu archive reachable; refusing to use stale package indexes.' >&2
      exit 1
    fi
    for source in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
      [[ -f "$source" ]] || continue
      # Keep suites and Signed-By unchanged: apt still verifies Ubuntu signatures.
      sudo sed -i -E \
        -e "s|mirror\+file:/etc/apt/apt-mirrors(-security)?.txt|$archive|g" \
        -e "s@http[s]?://(azure.archive|archive|security).ubuntu.com/ubuntu@$archive@g" \
        "$source"
    done
  fi
  sudo apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update
  sudo apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 install -y --no-install-recommends "${missing[@]}"
fi
