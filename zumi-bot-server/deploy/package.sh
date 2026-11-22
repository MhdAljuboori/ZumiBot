#!/bin/sh
# Packages the release artifacts from an already-built backend/dist:
#
#   npm run build:server
#   sh zumi-bot-server/deploy/package.sh [out-dir]      # default: release/
#
# Writes zumibot-server.tar.gz (app/, bin/, systemd/, proxy/, install.sh, VERSION) and SHA256SUMS. The release workflow
# (.github/workflows/release.yml) runs exactly this, and install.sh consumes what it writes.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/../.." && pwd)
out=${1:-$root/release}
dist=$root/zumi-bot-server/backend/dist

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ -f "$dist/server.mjs" ] || die "$dist/server.mjs is missing. Run 'npm run build:server' first."
for required in login/login.html login/setup.html web/index.html; do
  [ -f "$dist/$required" ] || die "$dist/$required is missing. Run 'npm run build:server' first."
done

# The same check the deploy makes: a build that was interrupted, or rewritten by another build, can leave an
# index.html naming assets that are not there, which serves a blank page.
missing=
for asset in $(grep -o 'assets/[A-Za-z0-9._-]*' "$dist/web/index.html" | sort -u); do
  [ -f "$dist/web/$asset" ] || missing="$missing $asset"
done
[ -z "$missing" ] || die "web/index.html names assets that are not in the build:$missing. Build again."

version=$(node -p "require('$root/zumi-bot-server/backend/package.json').version")
case $version in ''|*[!0-9.]*) die "Could not read a version from backend/package.json (got '$version')." ;; esac

work=$(mktemp -d "${TMPDIR:-/tmp}/zumibot-package.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
stage=$work/zumibot-server

mkdir -p "$stage/systemd" "$stage/proxy"
cp -a "$dist" "$stage/app"
cp -a "$here/bin" "$stage/bin"
cp "$here/zumibot-user.service" "$stage/systemd/"
# The server runs this one out of the release to update itself, so the installer always matches the build.
cp "$here/install.sh" "$stage/install.sh"
cp "$here/Caddyfile" "$here/nginx-zumibot.conf" "$stage/proxy/"
printf '%s\n' "$version" > "$stage/VERSION"

mkdir -p "$out"
archive=$out/zumibot-server.tar.gz
# Reproducible where tar supports it, so the same build packs to the same bytes.
if tar --sort=name --help >/dev/null 2>&1; then
  tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner \
      -czf "$archive" -C "$work" zumibot-server
else
  tar -czf "$archive" -C "$work" zumibot-server
fi

( cd "$out" && if command -v sha256sum >/dev/null 2>&1; then sha256sum zumibot-server.tar.gz
  else shasum -a 256 zumibot-server.tar.gz; fi > SHA256SUMS )

printf 'ZumiBot %s packaged:\n  %s\n  %s\n' "$version" "$archive" "$out/SHA256SUMS"
cat "$out/SHA256SUMS"
