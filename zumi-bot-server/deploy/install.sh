#!/bin/sh
# ZumiBot server installer and updater for a Linux host without Docker.
#
#   curl -fsSL https://zumibot.run/releases/latest/install.sh -o install.sh
#   less install.sh                 # read it first: it writes a systemd unit and may ask for one sudo command
#   sh install.sh --origin https://zumibot.example.com
#
# Run it again to update: it refuses while a reply is running, swaps the build in place
# (app -> app.prev, app.next -> app) and restarts the service. Safe to run twice.
#
# It installs nothing with sudo without saying what and asking first. Full detail:
# docs/architecture/install.md.
set -eu

# Where releases are published (the showcase site re-publishes each one; no token needed).
SITE=${ZUMIBOT_UPDATE_URL:-https://zumibot.run}
SITE=${SITE%/}
ASSET=zumibot-server.tar.gz
SUMS=SHA256SUMS
SIG=zumibot-server.tar.gz.sig
# The publisher's ed25519 public key, raw 32 bytes in base64: the same as RELEASE_PUBLIC_KEY in
# zumi-bot-server/shared/src/update.ts. A download is installed only with this key's signature over its version and
# sha256, so the site that serves it cannot change what runs. (A --tarball you bring yourself is not checked.)
RELEASE_PUBLIC_KEY='+3zc/fGHM0oDDgdo2kqzNtcYummsTNqGe1O/yarK+T0='
UNIT_NAME=zumibot.service

DIR=${ZUMIBOT_INSTALL_DIR:-$HOME/zumibot}
ORIGIN=
VERSION=
TARBALL=
FORCE=0
SNAPSHOT=0
WITH_SERVICE=1
ASSUME_YES=0
# The same default as bin/zumibot-server, which is what pins it for the service.
DATA=${ZUMIBOT_DATA_DIR:-$HOME/.local/share/zumibot}
DATA=${DATA%/}

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'Note: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<USAGE
Usage: sh install.sh [options]

  --origin URL     the public https origin, e.g. https://zumibot.example.com
                   (required on a first install; afterwards it is read back from the unit)
  --dir PATH       where to install (default: \$HOME/zumibot)
  --version TAG    a release instead of the latest, e.g. v0.1.2 (the site keeps only the
                   latest; for an older one use --tarball)
  --tarball PATH   install from a local $ASSET instead of downloading
  --no-service     install the files only; do not write or start a systemd user service
  --force          swap the build even while replies are running
  --snapshot-data  keep a copy of the data folder in <dir>/data.prev before the swap, so a rollback
                   (<dir>/bin/zumibot-rollback) can put the data back too; needs room for a second copy
  --yes            answer yes to the one optional sudo step (never to anything destructive)
  --help           this text

Releases are downloaded from \$ZUMIBOT_UPDATE_URL (default https://zumibot.run), checked
against their SHA256SUMS and the publisher's signature. No token is needed.
USAGE
}

while [ $# -gt 0 ]; do
  case $1 in
    --origin) [ $# -ge 2 ] || die "--origin needs a URL"; ORIGIN=$2; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a path"; DIR=$2; shift 2 ;;
    --version) [ $# -ge 2 ] || die "--version needs a tag"; VERSION=$2; shift 2 ;;
    --tarball) [ $# -ge 2 ] || die "--tarball needs a path"; TARBALL=$2; shift 2 ;;
    --no-service) WITH_SERVICE=0; shift ;;
    --force) FORCE=1; shift ;;
    --snapshot-data) SNAPSHOT=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

case $VERSION in *[!A-Za-z0-9._-]*) die "--version is a release such as v0.1.2." ;; esac
case $SITE in https://*) ;; *) die "ZUMIBOT_UPDATE_URL must be an https address." ;; esac
# DIR is written into bin/zumibot-update inside single quotes and into the unit by sed, so it is held to a charset
# that needs no escaping in either.
case $DIR in /*) ;; *) die "--dir must be an absolute path (got '$DIR')." ;; esac
case $DIR in *[!A-Za-z0-9._/:-]*) die "--dir may only use letters, digits and . _ / : - (got '$DIR')." ;; esac

# `curl ... | sh` makes stdin the script itself, so a question has to come from the terminal.
ask() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -r /dev/tty ] || return 1
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r reply </dev/tty || return 1
  case $reply in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# --- what the host must already have -------------------------------------------------------------------------

step "Checking this host"

# Agents run as the server's own user, so this is never root. (The deploy and the container image do the same.)
[ "$(id -u)" != 0 ] || die "Run this as the account ZumiBot should run as, not as root."

for tool in tar mktemp; do have "$tool" || die "$tool is needed and was not found."; done
if have sha256sum; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif have shasum; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "sha256sum (or shasum) is needed to check the download."
fi
if have curl; then fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" -- "$1"; }
elif have wget; then fetch() { wget -q --https-only -O "$2" -- "$1"; }
else fetch() { die "curl or wget is needed to download a release."; }
fi

have node || die "Node.js 22 or newer is needed. NodeSource has packages: download https://deb.nodesource.com/setup_22.x, read it, then run it with sudo (do not pipe it into a shell), then 'sudo apt-get install -y nodejs'."
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case $node_major in ''|*[!0-9]*) die "Could not read the Node.js version from 'node'." ;; esac
[ "$node_major" -ge 22 ] || die "Node.js 22 or newer is needed; this is $(node -v)."
say "Node.js $(node -v)"

# A missing CLI is not fatal: the server starts, and the setup wizard's last step says how to fix it.
if have claude; then say "claude $(claude --version 2>/dev/null | head -1)"
else warn "The claude CLI was not found. ZumiBot runs it for every reply. Install it with 'npm i -g @anthropic-ai/claude-code' and sign in by running 'claude' once, as this same user."
fi

# --- where, and with which origin ----------------------------------------------------------------------------

UNIT_FILE=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT_NAME
UPDATING=0
[ -d "$DIR/app" ] && UPDATING=1

# Remembered, so an update needs no arguments: the installed unit first, then the copy this script keeps (which
# is also what a host with no systemd user manager has).
if [ -z "$ORIGIN" ]; then
  for remembered in "$UNIT_FILE" "$DIR/systemd/$UNIT_NAME"; do
    [ -f "$remembered" ] || continue
    ORIGIN=$(sed -n 's/.*ZUMIBOT_ORIGIN=\([^ ]*\).*/\1/p' "$remembered" | head -1)
    [ -n "$ORIGIN" ] && break
  done
fi
[ -n "$ORIGIN" ] || die "--origin is required on a first install: the public https origin this server is reached at, e.g. --origin https://zumibot.example.com"
case $ORIGIN in
  https://*) ;;
  *) die "--origin must start with https://. The session cookie is Secure and every write is checked against this origin, so there is no plain-HTTP mode; put a reverse proxy in front (this script prints the config for one)." ;;
esac
# An origin only: the server compares this string to the browser's Origin header, which carries no path.
host=${ORIGIN#https://}
case $host in
  ''|*/*|*'?'*|*'#'*|*@*) die "--origin must be an origin only, with no path, query or credentials: https://host[:port]" ;;
esac
# The origin goes into the unit and the host into the proxy configs through sed: no character sed or a unit would read.
case $host in *[!A-Za-z0-9.:-]*) die "--origin may only use letters, digits and . : - in its host (got '$host')." ;; esac

# Before anything is moved: a first migration from the old system-level unit would start the new server against a port
# the old one still holds, and a rerun after the swap would overwrite app.prev with the new app.
if [ "$WITH_SERVICE" = 1 ] && have systemctl && systemctl is-active --quiet zumibot 2>/dev/null; then
  die "The old system service 'zumibot' is still running and holds port 4317. Stop it first: sudo systemctl disable --now zumibot"
fi

[ "$UPDATING" = 1 ] && step "Updating the install in $DIR" || step "Installing into $DIR"
say "Origin: $ORIGIN"

# --- refuse while a reply is running -------------------------------------------------------------------------

# Through the control socket in the data dir. A failed call means no server, which counts as idle.
replies_running() {
  [ -x "$DIR/bin/zumibot-server" ] || { echo 0; return; }
  out=$("$DIR/bin/zumibot-server" busy 2>/dev/null) || { echo 0; return; }
  case $out in
    ''|*[!0-9]*) echo unknown ;;
    *) echo "$out" ;;
  esac
}

if [ "$UPDATING" = 1 ]; then
  busy=$(replies_running)
  if [ "$busy" = unknown ]; then
    [ "$FORCE" = 1 ] || die "Could not read the running-reply count from $DIR/bin/zumibot-server busy. Re-run with --force to update anyway."
  elif [ "$busy" -gt 0 ]; then
    [ "$FORCE" = 1 ] || die "$busy reply/replies running. Wait for them, or re-run with --force to interrupt them."
  fi
  say "Replies running: $busy"
fi

# --- the build ------------------------------------------------------------------------------------------------

work=$(mktemp -d "${TMPDIR:-/tmp}/zumibot-install.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT HUP INT TERM

if [ -n "$TARBALL" ]; then
  step "Using $TARBALL"
  [ -f "$TARBALL" ] || die "$TARBALL is not a file."
  cp "$TARBALL" "$work/$ASSET"
else
  # The signature binds the version, so it is known before the download: --version, or the site's latest.json. All
  # three files then come from that version's own folder, so a site deploy in between cannot mix two releases.
  if [ -n "$VERSION" ]; then rel=${VERSION#v}
  else
    fetch "$SITE/releases/latest.json" "$work/latest.json" || die "Could not download $SITE/releases/latest.json"
    rel=$(node -e 'const v = String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version).replace(/^v/, ""); if (!/^[0-9]+[.][0-9]+[.][0-9]+$/.test(v)) process.exit(1); process.stdout.write(v)' "$work/latest.json") \
      || die "$SITE/releases/latest.json does not name a release."
  fi
  case $rel in ''|*[!0-9.]*) die "--version is a release such as v0.1.2." ;; esac
  base=$SITE/releases/$rel
  step "Downloading ZumiBot $rel from $SITE"
  fetch "$base/$ASSET" "$work/$ASSET" || die "Could not download $base/$ASSET${VERSION:+ (the site keeps only the latest release; use --tarball for an older one)}"
  fetch "$base/$SUMS" "$work/$SUMS" || die "Could not download $base/$SUMS"
  fetch "$base/$SIG" "$work/$SIG" || die "Could not download $base/$SIG: the release is not signed, so it is not installed."
  want=$(awk -v f="$ASSET" '{ sub(/^\*/, "", $2); if ($2 == f) print $1 }' "$work/$SUMS" | head -1)
  [ -n "$want" ] || die "$SUMS does not list $ASSET."
  got=$(sha256 "$work/$ASSET")
  [ "$want" = "$got" ] || die "The download does not match $SUMS. Delete it and try again."
  say "Checksum matches $SUMS"
  # The sums come from the same site as the tarball; only the signature ties them to the publisher. Values go in by
  # env, never into the script text. Anything short of a good signature (no node crypto, a bad file) refuses.
  RELEASE_PUBLIC_KEY=$RELEASE_PUBLIC_KEY CB_VERSION=$rel CB_SHA256=$got CB_SIG_FILE=$work/$SIG node -e '
    const c = require("node:crypto")
    const e = process.env
    const sig = Buffer.from(require("node:fs").readFileSync(e.CB_SIG_FILE, "utf8").trim(), "base64")
    const raw = Buffer.from(e.RELEASE_PUBLIC_KEY, "base64")
    if (sig.length !== 64 || raw.length !== 32) process.exit(1)
    const key = c.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" })
    const text = "zumibot-server\n" + e.CB_VERSION + "\n" + e.CB_SHA256 + "\n"
    process.exit(c.verify(null, Buffer.from(text, "utf8"), key, sig) ? 0 : 1)
  ' 2>/dev/null || die "The release signature does not verify: $ASSET was not published by the ZumiBot publisher. Nothing was installed."
  say "Signed by the ZumiBot publisher"
fi

tar -xzf "$work/$ASSET" -C "$work" || die "Could not unpack $ASSET."
src=$work/zumibot-server
for required in app/server.mjs app/login/setup.html bin/zumibot-server bin/zumibot-rollback systemd/zumibot-user.service install.sh VERSION; do
  [ -e "$src/$required" ] || die "$ASSET is missing $required."
done
version=$(cat "$src/VERSION")
# The signed version must be the one inside, so an older signed tarball cannot be served under a newer name.
if [ -z "$TARBALL" ] && [ "$version" != "$rel" ]; then
  die "$ASSET says it is $version, but its signature is for $rel. Nothing was installed."
fi
say "ZumiBot $version"

# --- install, swapping the live app in one move ---------------------------------------------------------------

step "Writing $DIR"
mkdir -p "$DIR/bin"
rm -rf "$DIR/app.next"
cp -a "$src/app" "$DIR/app.next"
cp -a "$src/bin/." "$DIR/bin/"
chmod 0755 "$DIR/bin/zumibot-server" "$DIR/bin/zumibot-rollback"

# --- the data, kept for a rollback ---------------------------------------------------------------------------

# After the new app is fully staged and before the live one moves: a copy that fails stops the update with the
# running app untouched, and a new data.prev is never left beside an old app.prev.
# Not the browsers (big, and fetched again), nor the per-chat scratch folder, nor the two files that only mean
# something to a running process.
if [ "$SNAPSHOT" = 1 ]; then
  if [ -d "$DATA" ]; then
    step "Copying $DATA to $DIR/data.prev"
    mkdir -p "$DIR"
    rm -rf "$DIR/data.prev.new"
    mkdir -m 0700 "$DIR/data.prev.new"
    rm -f "$work/snapshot.failed"
    # Either half of a pipe can fail on its own, and only the last status is seen, so the first leaves a mark.
    { tar -C "$DATA" --exclude=./browsers --exclude=./browser-runtime --exclude=./claude-tmp \
        --exclude=./control.sock --exclude=./server.lock -cf - . || : > "$work/snapshot.failed"; } |
      tar -C "$DIR/data.prev.new" -xf - || : > "$work/snapshot.failed"
    if [ -e "$work/snapshot.failed" ]; then
      rm -rf "$DIR/data.prev.new"
      die "Could not copy the data folder (is there room for a second copy?). Nothing was updated."
    fi
    # Which version this data belongs to: the one about to be replaced.
    cat "$DIR/VERSION" 2>/dev/null > "$DIR/data.prev.new/.zumibot-from" || :
    [ -s "$DIR/data.prev.new/.zumibot-from" ] || printf 'unknown\n' > "$DIR/data.prev.new/.zumibot-from"
    rm -rf "$DIR/data.prev"
    mv "$DIR/data.prev.new" "$DIR/data.prev"
    say "Kept the data as of $(cat "$DIR/data.prev/.zumibot-from")"
  else
    say "No data folder at $DATA yet, so there is nothing to keep for a rollback."
    # An older data.prev belongs to the app that is about to become app.prev's predecessor, not to it.
    rm -rf "$DIR/data.prev"
  fi
fi
# Without a fresh one, an older data.prev would pair with the app.prev made below and roll a newer app back onto
# older data. Better no rollback than that one.
[ "$SNAPSHOT" = 1 ] || rm -rf "$DIR/data.prev"

# The running server reads app/ on every request, so it is only ever replaced whole, and the old one is kept
# for a manual rollback (mv app.prev app).
rm -rf "$DIR/app.prev"
[ ! -d "$DIR/app" ] || mv "$DIR/app" "$DIR/app.prev"
mv "$DIR/app.next" "$DIR/app"
printf '%s\n' "$version" > "$DIR/VERSION"

# An updater that needs no arguments, and a copy of this script for it to run.
# The one in the verified release first: it is the version of the installer that matches this build.
if [ -f "$src/install.sh" ]; then cp "$src/install.sh" "$DIR/install.sh"
elif [ -f "$0" ] && [ -r "$0" ]; then cp "$0" "$DIR/install.sh"
elif [ ! -f "$DIR/install.sh" ]; then
  fetch "$SITE/releases/latest/install.sh" "$DIR/install.sh" \
    || warn "Could not save a copy of this installer; $DIR/bin/zumibot-update will not work until you do."
fi
if [ -f "$DIR/install.sh" ]; then
  chmod 0644 "$DIR/install.sh"
  printf '#!/bin/sh\n# Re-runs the installer, which updates in place. Add --force to interrupt running replies.\nexec sh %s --dir %s "$@"\n' "'$DIR/install.sh'" "'$DIR'" > "$DIR/bin/zumibot-update"
  chmod 0755 "$DIR/bin/zumibot-update"
fi

# Filled-in proxy configs to install yourself: this script never touches /etc.
mkdir -p "$DIR/proxy"
for f in Caddyfile nginx-zumibot.conf; do
  [ -f "$src/proxy/$f" ] || continue
  sed "s/zumibot-server\.mhdaljuboori\.me/$host/g" "$src/proxy/$f" > "$DIR/proxy/$f"
done

# --- the service ----------------------------------------------------------------------------------------------

LOG_HINT="journalctl --user -u $UNIT_NAME -n 20 --no-pager"

service_manual() {
  cat <<MANUAL

The files are in place but nothing is running them. To start the server by hand:

  $DIR/bin/zumibot-server

Or install the unit yourself from $DIR/systemd/$UNIT_NAME.
MANUAL
}

mkdir -p "$DIR/systemd"
sed -e "s#<ZUMIBOT_ORIGIN>#$ORIGIN#" -e "s#<ZUMIBOT_DIR>#$DIR#" "$src/systemd/zumibot-user.service" > "$DIR/systemd/$UNIT_NAME"

if [ "$WITH_SERVICE" = 0 ]; then
  step "Skipping the service (--no-service)"
  service_manual
  LOG_HINT="the output of the command above"
elif ! have systemctl || [ ! -d "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/systemd" ]; then
  step "No systemd user manager here"
  warn "systemctl --user is not available in this session (no user instance of systemd), so no service was installed."
  service_manual
  LOG_HINT="the output of the command above"
else
  step "Installing the systemd user service"
  mkdir -p "$(dirname "$UNIT_FILE")"
  # Only rewrite a changed unit, so running this twice is quiet.
  if [ ! -f "$UNIT_FILE" ] || ! cmp -s "$DIR/systemd/$UNIT_NAME" "$UNIT_FILE"; then
    cp "$DIR/systemd/$UNIT_NAME" "$UNIT_FILE"
    say "Wrote $UNIT_FILE"
  else
    say "$UNIT_FILE is already current"
  fi
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT_NAME" >/dev/null
  systemctl --user restart "$UNIT_NAME"

  # Without linger a user service stops when the last session of this user ends, which for a server is never
  # what you want. Setting it for your own account usually needs no password; only if that fails do we ask.
  if loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | grep -q 'Linger=yes'; then
    say "Lingering is already on, so the service runs without you logged in."
  elif loginctl enable-linger 2>/dev/null; then
    say "Turned lingering on, so the service runs without you logged in."
  elif have sudo; then
    say ""
    say "One thing needs root: without 'lingering' this service stops when you log out."
    say "The command is:  sudo loginctl enable-linger $(id -un)"
    if ask "Run it now?"; then
      sudo loginctl enable-linger "$(id -un)" && say "Lingering is on." || warn "That failed; run it yourself later."
    else
      warn "Skipped. The service will stop when your last session ends; run that command when you want it to keep running."
    fi
  else
    warn "Could not turn lingering on and sudo is not here. The service stops when your last session ends; ask an admin to run: loginctl enable-linger $(id -un)"
  fi

  # It answers in the setup state too, so this says "up", not "set up".
  step "Waiting for the server"
  i=0
  # The answer must come from this user unit: a server of the old system service on the same port would also answer.
  until [ "$("$DIR/bin/zumibot-server" busy 2>/dev/null || echo no)" != no ] && systemctl --user is-active --quiet "$UNIT_NAME"; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      warn "The server did not answer within 30 s. Its log: journalctl --user -u $UNIT_NAME -n 50 --no-pager"
      break
    fi
    sleep 1
  done
  [ "$i" -lt 30 ] && say "The server is up."
fi

# --- what is left to do ---------------------------------------------------------------------------------------

# An update leaves proxy, setup and CLI login as they were; the first-run steps would only mislead (and they land in the About page's update log).
if [ "$UPDATING" = 1 ]; then
  cat <<DONE

------------------------------------------------------------------------------
ZumiBot $version is installed in $DIR.
The proxy, your login and your data are unchanged.
Undo this update: $DIR/bin/zumibot-rollback
------------------------------------------------------------------------------
DONE
  exit 0
fi

cat <<DONE

------------------------------------------------------------------------------
ZumiBot $version is installed in $DIR.

1. Put a reverse proxy in front of 127.0.0.1:4317 and give it TLS for $host.
   The server binds loopback only, so the proxy is the one way in. Ready-made
   configs with your host filled in:
     $DIR/proxy/Caddyfile
     $DIR/proxy/nginx-zumibot.conf
   Installing either needs root. The commands for Caddy and for nginx + certbot
   are in zumi-bot-server/deploy/SETUP-VPS.md in the ZumiBot repository.

2. Open $ORIGIN/setup and paste the one-time setup code. It is in the log:
     $LOG_HINT
   The code is only in the running server's memory: it is gone once setup
   finishes, and a restart prints a new one.

3. Sign the claude CLI in as this user, if you have not:  claude

Later: $DIR/bin/zumibot-update   (refuses while a reply is running)
------------------------------------------------------------------------------
DONE
