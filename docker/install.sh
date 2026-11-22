#!/bin/sh
# ZumiBot in Docker, in one command. Installs and updates. A preview: not yet proven on many real hosts.
#
#   curl -fsSL https://zumibot.run/releases/latest/docker/install.sh -o install.sh
#   less install.sh                                  # read it first
#   sh install.sh                                    # or: sh install.sh --domain zumibot.example.com
#
# It downloads the release's Docker bundle (a compose file that names the image by digest, plus the files it
# mounts and this installer), checks the publisher's signature on it, and hands off to the bundle's own copy of
# this script, which pulls the image and swaps the folder. Nothing is built on your machine.
#
# Safe by default: with no --domain it publishes on 127.0.0.1 only (the `local` profile), so nothing is reachable
# from the internet until you ask for it. It never runs sudo, installs only a signed release, keeps an existing
# .env, refuses to update while a reply is running, and prints where the one-time setup code is rather than the
# code. Run it again to update. Full detail: docs/architecture/install.md.
set -eu

# Where releases are published (the showcase site re-publishes each one; no token needed).
SITE=${ZUMIBOT_UPDATE_URL:-https://zumibot.run}
SITE=${SITE%/}
BUNDLE=zumibot-docker.tar.gz
SIG=$BUNDLE.sig
# The publisher's ed25519 public key, raw 32 bytes in base64: the same as RELEASE_PUBLIC_KEY in
# zumi-bot-server/shared/src/update.ts. A download is installed only with this key's signature over its version and
# sha256, so the site that serves it cannot change what runs. (A --bundle you bring yourself is not checked.)
RELEASE_PUBLIC_KEY='+3zc/fGHM0oDDgdo2kqzNtcYummsTNqGe1O/yarK+T0='
# Runs the check, so the host needs nothing but docker (a Mac has no sha256sum, an old LibreSSL, no node). The same
# base image as the Dockerfile, so its layers are the ones the ZumiBot image reuses.
VERIFY_IMAGE='node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee'

DIR=${ZUMIBOT_DOCKER_DIR:-$HOME/zumibot-docker}
DOMAIN=
ORIGIN_ARG=
VERSION=
BUNDLE_FILE=
FORCE=0

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'Note: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# A refusal after the staged copy exists: it must not be left behind.
refuse() { rm -rf "$DIR.next"; die "$@"; }

usage() {
  cat <<USAGE
The Docker install is a preview: it has not been proven on many real hosts yet.

Usage: sh install.sh [options]

  --domain HOST   serve https://HOST publicly on ports 80 and 443, with a certificate Caddy gets.
                  An A (and AAAA) record must already point at this machine.
                  Without it: https://localhost:8443 on loopback only, for an SSH tunnel or Tailscale.
  --origin URL    for the loopback install, the address you will open: https://HOST:8443, the port is always 8443.
                  With Tailscale, HOST is this machine's name on the tailnet (https://mac.tail1234.ts.net:8443).
                  Not with --domain. On an existing install it must match what its .env already says.
  --dir PATH      where the compose project lives (default: \$HOME/zumibot-docker)
  --version X.Y.Z a release instead of the latest, e.g. v0.1.2 (the site keeps only the latest release)
  --bundle PATH   use a local $BUNDLE instead of downloading (not checked: you vouch for it)
  --force         update even while replies are running (they are stopped)
  --help          this text

Releases are downloaded from \$ZUMIBOT_UPDATE_URL (default https://zumibot.run) and installed only
with the publisher's signature. No token is needed.
USAGE
}

while [ $# -gt 0 ]; do
  case $1 in
    --domain) [ $# -ge 2 ] || die "--domain needs a host name"; DOMAIN=$2; shift 2 ;;
    --origin) [ $# -ge 2 ] || die "--origin needs an address such as https://mac.tail1234.ts.net:8443"; ORIGIN_ARG=$2; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a path"; DIR=$2; shift 2 ;;
    --version) [ $# -ge 2 ] || die "--version needs a release such as v0.1.2"; VERSION=$2; shift 2 ;;
    --bundle) [ $# -ge 2 ] || die "--bundle needs a path"; BUNDLE_FILE=$2; shift 2 ;;
    --force) FORCE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

case $SITE in https://*) ;; *) die "ZUMIBOT_UPDATE_URL must be an https address." ;; esac
if [ -n "$VERSION" ]; then
  VERSION=${VERSION#v}
  printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "--version is a release such as v0.1.2."
  [ -z "$BUNDLE_FILE" ] || die "--version and --bundle do not go together: a bundle is already one release."
fi

# Is x.y.z $1 older than $2? Per number: as text, 0.1.10 would sort before 0.1.9.
older() {
  a=$1; b=$2
  for _ in 1 2 3; do
    ap=${a%%.*}; bp=${b%%.*}
    [ "$ap" -lt "$bp" ] && return 0
    [ "$ap" -gt "$bp" ] && return 1
    a=${a#*.}; b=${b#*.}
  done
  return 1
}

# `curl ... | sh` makes stdin the script itself: anything that reads stdin would eat the rest of it, so every
# docker call gets </dev/null.
dc() { docker compose -f "$DIR/docker-compose.yml" "$@" </dev/null; }

# --- what the host must already have -------------------------------------------------------------------------

step "Checking this host"

for tool in tar mktemp; do have "$tool" || die "$tool is needed and was not found."; done
# A Mac runs Docker Desktop, OrbStack or Colima, not Docker Engine, and has no docker group to join.
OS=$(uname -s 2>/dev/null || true)
if ! have docker; then
  if [ "$OS" = Darwin ]; then
    die "Docker is needed. Install Docker Desktop, OrbStack or Colima (with its compose plugin), then run this again."
  fi
  die "Docker is needed. Install Docker Engine with the compose plugin (https://docs.docker.com/engine/install/), then run this again."
fi
docker compose version >/dev/null 2>&1 </dev/null \
  || die "The Docker compose plugin is needed ('docker compose', v2.17 or newer). See https://docs.docker.com/compose/install/linux/"

# `depends_on: restart: true` in docker-compose.yml is 2.17+; an older compose silently ignores it, and Caddy
# would be left in a dead namespace after the server restarts.
cv=$(docker compose version --short 2>/dev/null </dev/null | sed 's/^v//')
cmaj=${cv%%.*}; crest=${cv#*.}; cmin=${crest%%.*}
case $cmaj$cmin in
  ''|*[!0-9]*) warn "Could not read the compose version ($cv); it needs 2.17 or newer." ;;
  *) if [ "$cmaj" -lt 2 ] || { [ "$cmaj" -eq 2 ] && [ "$cmin" -lt 17 ]; }; then
       die "docker compose $cv is too old; 2.17 or newer is needed."
     fi ;;
esac

# Never sudo on the operator's behalf: say what would fix it and stop.
if ! docker info >/dev/null 2>&1 </dev/null; then
  if [ "$OS" = Darwin ]; then
    die "Cannot talk to the Docker daemon. Start Docker Desktop, OrbStack or Colima, and run this again."
  fi
  die "Cannot talk to the Docker daemon as $(id -un). Start Docker, or add yourself to the docker group (sudo usermod -aG docker $(id -un), then log in again), and run this again."
fi
say "docker compose $cv"

# Only a download needs these; a --bundle you bring is used as it is.
if [ -z "$BUNDLE_FILE" ]; then
  have curl || die "curl is needed and was not found."
  if have sha256sum; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
  elif have shasum; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else die "sha256sum (or shasum) is needed to check the download."
  fi
fi
fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" -- "$1"; }

# --- which profile ---------------------------------------------------------------------------------------------

ENV_FILE=$DIR/.env
UPDATING=0
[ -f "$ENV_FILE" ] && UPDATING=1

if [ -n "$DOMAIN" ]; then
  DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')
  # A bare host: Caddy orders a certificate for exactly this string, and the server checks every write against
  # https://<it>. No scheme, port or path; no IP, which a public CA will not issue for here.
  case $DOMAIN in
    *[!a-z0-9.-]*|.*|*.|-*|*..*|*.-*|*-.*) die "--domain must be a host name such as zumibot.example.com (no https://, port or path)." ;;
    *.*) ;;
    *) die "--domain must be a fully qualified host name such as zumibot.example.com." ;;
  esac
  case $DOMAIN in *[!0-9.]*) ;; *) die "--domain must be a host name, not an IP address. Leave it out to run on loopback instead." ;; esac
  if have getent && ! getent hosts "$DOMAIN" >/dev/null 2>&1; then
    warn "$DOMAIN does not resolve yet. Caddy cannot get a certificate until its A/AAAA record points at this machine."
  fi
fi

if [ -n "$ORIGIN_ARG" ]; then
  ORIGIN_ARG=$(printf '%s' "$ORIGIN_ARG" | tr 'A-Z' 'a-z')
  # Port 8443 only: compose publishes <loopback>:8443 and Caddyfile.local listens on the origin's own port, so any
  # other port would break. https only, no path.
  case $ORIGIN_ARG in
    https://*:8443) origin_host=${ORIGIN_ARG#https://}; origin_host=${origin_host%:8443} ;;
    *) die "--origin must be https://HOST:8443 (https, port 8443, no path), such as https://mac.tail1234.ts.net:8443." ;;
  esac
  case $origin_host in
    ''|*[!a-z0-9.-]*|.*|*.|-*|*-|*..*) die "--origin must be https://HOST:8443 with a host name made of letters, digits, dots and dashes." ;;
  esac
  [ -z "$DOMAIN" ] || die "--origin is for the loopback profile; --domain serves https://HOST itself. Use one of them."
fi

if [ "$UPDATING" = 1 ]; then
  PROFILE=$(sed -n 's/^COMPOSE_PROFILES=//p' "$ENV_FILE" | tail -1)
  if [ -n "$DOMAIN" ]; then
    current=$(sed -n 's/^ZUMIBOT_DOMAIN=//p' "$ENV_FILE" | tail -1)
    [ "$PROFILE" = domain ] && [ "$current" = "$DOMAIN" ] \
      || die "$ENV_FILE already exists and says something else. Edit it to change the profile or domain, then run this again without --domain."
  fi
  if [ -n "$ORIGIN_ARG" ]; then
    current=$(sed -n 's/^ZUMIBOT_LOCAL_ORIGIN=//p' "$ENV_FILE" | tail -1)
    [ "$PROFILE" = local ] && [ "$current" = "$ORIGIN_ARG" ] \
      || die "$ENV_FILE already exists and says something else. Edit it to change the profile or origin, then run this again without --origin."
  fi
else
  if [ -n "$DOMAIN" ]; then PROFILE=domain; else PROFILE=local; fi
fi
case $PROFILE in
  domain) SVC=zumibot ;;
  local) SVC=zumibot-local ;;
  *) die "COMPOSE_PROFILES in $ENV_FILE is '$PROFILE'; it must be domain or local." ;;
esac

# --- the bundle -----------------------------------------------------------------------------------------------

work=$(mktemp -d "${TMPDIR:-/tmp}/zumibot-docker.XXXXXX")
cleanup() { rm -rf "$work"; }
# A signal handler that only cleans up would let the script carry on; exiting runs the EXIT trap.
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ -n "$BUNDLE_FILE" ]; then
  [ -f "$BUNDLE_FILE" ] || die "$BUNDLE_FILE is not a file."
  step "Using $BUNDLE_FILE"
  cp "$BUNDLE_FILE" "$work/$BUNDLE"
  rel=
else
  # The signature binds the version, so it is known before the download: --version, or the site's latest.json. Both
  # files then come from that version's own folder, so a site deploy in between cannot mix two releases.
  if [ -n "$VERSION" ]; then rel=$VERSION
  else
    fetch "$SITE/releases/latest.json" "$work/latest.json" || die "Could not download $SITE/releases/latest.json"
    rel=$(sed -n 's/^.*"version"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*$/\1/p' "$work/latest.json" | head -1)
    printf '%s\n' "$rel" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "$SITE/releases/latest.json does not name a release."
  fi
  # latest.json is not signed, so a tampered site could name an older signed release: never go below what is
  # installed. The same version is a repair and passes; going back on purpose is the .prev rollback or --bundle.
  # (A source-built install has no VERSION and is not checked.)
  have_v=$(cat "$DIR/VERSION" 2>/dev/null || true)
  if printf '%s\n' "$have_v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' && older "$rel" "$have_v"; then
    die "ZumiBot $rel is the release to install, which is older than the $have_v already in $DIR. Nothing was changed. To go back on purpose, use the rollback in $DIR.prev, or run this with --bundle and a $BUNDLE you trust."
  fi
  base=$SITE/releases/$rel
  step "Downloading ZumiBot $rel from $SITE"
  fetch "$base/$BUNDLE" "$work/$BUNDLE" \
    || die "Could not download $base/$BUNDLE: ZumiBot $rel has no Docker bundle on $SITE, or the site could not be reached. Releases from before the Docker image have none; try --version with a newer release, or --bundle with a file you have."
  fetch "$base/$SIG" "$work/$SIG" || die "Could not download $base/$SIG: the release is not signed, so it is not installed."
  got=$(sha256 "$work/$BUNDLE")
  # 64 bytes of base64 and nothing else: it goes onto the docker command line below.
  sig=$(tr -d ' \t\r\n' < "$work/$SIG")
  printf '%s\n' "$sig" | grep -Eq '^[A-Za-z0-9+/]{86}==$' || die "$base/$SIG is not an ed25519 signature, so ZumiBot $rel was not installed."

  step "Checking the signature"
  docker pull -q "$VERIFY_IMAGE" </dev/null >/dev/null \
    || die "Could not pull $VERIFY_IMAGE, the small image that checks the signature. Check the network and Docker Hub, then run this again."
  # The sums come from the same site as the bundle; only the signature ties them to the publisher. Values go in by
  # env, never into the script text, and the container has no network and no writable disk. Anything short of a
  # good signature (a bad file, no crypto) refuses; its error output says nothing a person could use.
  VERIFY_JS='
    const c = require("node:crypto")
    const e = process.env
    const sig = Buffer.from(e.CB_SIG, "base64")
    const raw = Buffer.from(e.RELEASE_PUBLIC_KEY, "base64")
    if (sig.length !== 64 || raw.length !== 32) process.exit(1)
    const key = c.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" })
    const text = "zumibot-docker\n" + e.CB_VERSION + "\n" + e.CB_SHA256 + "\n"
    process.exit(c.verify(null, Buffer.from(text, "utf8"), key, sig) ? 0 : 1)
  '
  docker run --rm --network none --read-only --user 65534:65534 -e RELEASE_PUBLIC_KEY="$RELEASE_PUBLIC_KEY" -e CB_VERSION="$rel" -e CB_SHA256="$got" -e CB_SIG="$sig" "$VERIFY_IMAGE" node -e "$VERIFY_JS" </dev/null >/dev/null 2>/dev/null \
    || die "The release signature does not verify: nothing was installed. $BUNDLE did not come from the ZumiBot publisher, or the download is damaged. Try again, and if it keeps failing do not use it."
  say "Signed by the ZumiBot publisher"
fi

tar -xzf "$work/$BUNDLE" -C "$work" || die "Could not unpack $BUNDLE."
src=$work/zumibot-docker
for required in docker-compose.yml docker/Caddyfile docker/Caddyfile.local docker/install.sh .env.example VERSION; do
  [ -e "$src/$required" ] || die "$BUNDLE is missing $required."
done
version=$(cat "$src/VERSION")
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "$BUNDLE has a VERSION that is not a release ('$version')."
# The signed version must be the one inside, so an older signed bundle cannot be served under a newer name.
if [ -n "$rel" ] && [ "$version" != "$rel" ]; then
  die "$BUNDLE says it is $version, but its signature is for $rel. Nothing was installed."
fi
say "ZumiBot $version"

# A download is installed by the bundle's own copy of this script, as the signed release shipped it: this one only
# fetched and checked. It does the rest, so a fix to the install steps ships with the release it belongs to.
if [ -z "$BUNDLE_FILE" ]; then
  step "Handing over to the installer in the bundle"
  if [ "$FORCE" = 1 ]; then force_arg=1; else force_arg=; fi
  rc=0
  sh "$work/zumibot-docker/docker/install.sh" --bundle "$work/$BUNDLE" --dir "$DIR" ${DOMAIN:+--domain "$DOMAIN"} ${ORIGIN_ARG:+--origin "$ORIGIN_ARG"} ${force_arg:+--force} </dev/null || rc=$?
  exit "$rc"
fi

# --- write the project, keeping the operator's .env -----------------------------------------------------------

step "Writing $DIR"
rm -rf "$DIR.next"
mkdir -p "$(dirname "$DIR")"
cp -a "$src" "$DIR.next"

if [ "$UPDATING" = 1 ]; then
  cp -p "$ENV_FILE" "$DIR.next/.env"
  say "Kept $ENV_FILE"
else
  umask_was=$(umask); umask 077
  {
    say "# Written by docker/install.sh. Edit and run 'docker compose up -d' in this folder to apply."
    say "COMPOSE_PROFILES=$PROFILE"
    if [ "$PROFILE" = domain ]; then say "ZUMIBOT_DOMAIN=$DOMAIN"
    else
      say "ZUMIBOT_LOCAL_PUBLISH=127.0.0.1:8443"
      say "ZUMIBOT_LOCAL_ORIGIN=${ORIGIN_ARG:-https://localhost:8443}"
    fi
  } > "$DIR.next/.env"
  umask "$umask_was"
  say "Wrote $ENV_FILE ($PROFILE profile)"
fi

# --- pull first: a slow or failed download never leaves the server down ---------------------------------------

step "Pulling the images (a running server is left alone until this is done)"
docker compose -f "$DIR.next/docker-compose.yml" pull </dev/null \
  || refuse "Could not pull the images, so nothing was changed. Check the network and Docker Hub, then run this again."

# --- refuse while a reply is running -------------------------------------------------------------------------

if [ "$UPDATING" = 1 ] && [ -n "$(dc ps -q "$SVC" 2>/dev/null)" ]; then
  busy=$(dc exec -T "$SVC" zumibot-server busy 2>/dev/null || echo unknown)
  case $busy in ''|*[!0-9]*) busy=unknown ;; esac
  if [ "$busy" = unknown ]; then
    [ "$FORCE" = 1 ] || refuse "Could not read the running-reply count from the $SVC container. Re-run with --force to update anyway."
  elif [ "$busy" -gt 0 ]; then
    [ "$FORCE" = 1 ] || refuse "$busy reply/replies running. Wait for them, or re-run with --force to interrupt them."
  fi
  say "Replies running: $busy"
fi

# Swapped whole; the previous tree stays for a rollback (see the summary below).
rm -rf "$DIR.prev"
[ ! -d "$DIR" ] || mv "$DIR" "$DIR.prev" || refuse "Could not move $DIR aside, so nothing was changed."
mv "$DIR.next" "$DIR" || {
  # Put the old tree back, so a failed second move leaves the server where it was.
  if [ ! -d "$DIR.prev" ] || mv "$DIR.prev" "$DIR"; then
    refuse "Could not move the new files into $DIR; the previous install was put back."
  fi
  refuse "Could not move the new files into $DIR, and the previous install could not be put back; it is at $DIR.prev."
}

# The way back exists only after an update; a first install has no previous folder.
if [ -d "$DIR.prev" ]; then
  GOBACK="mv $DIR $DIR.failed && mv $DIR.prev $DIR && cd $DIR && docker compose up -d"
else
  GOBACK=
fi

# --- start ----------------------------------------------------------------------------------------------------

step "Starting ZumiBot $version"
dc up -d --remove-orphans \
  || die "docker compose could not start ZumiBot.${GOBACK:+ To go back: $GOBACK}"

step "Waiting for the server"
i=0
until dc exec -T "$SVC" zumibot-server busy >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    warn "The server did not answer within 60 s. Its log: cd $DIR && docker compose logs $SVC"
    break
  fi
  sleep 1
done
[ "$i" -lt 60 ] && say "The server is up."

# --- what is left to do ---------------------------------------------------------------------------------------

if [ -n "$GOBACK" ]; then
  BACK="To go back to the previous version:
     $GOBACK"
else
  BACK="Each update keeps the previous version in $DIR.prev, for a rollback."
fi
if [ "$PROFILE" = domain ]; then
  ORIGIN=https://$(sed -n 's/^ZUMIBOT_DOMAIN=//p' "$DIR/.env" | tail -1)
  REACH="Open $ORIGIN/setup (ports 80 and 443 must be reachable for the certificate)."
else
  ORIGIN=$(sed -n 's/^ZUMIBOT_LOCAL_ORIGIN=//p' "$DIR/.env" | tail -1)
  ORIGIN=${ORIGIN:-https://localhost:8443}
  origin_host=${ORIGIN#https://}; origin_host=${origin_host%:8443}
  if [ "$origin_host" = localhost ]; then
    REACH="It listens on 127.0.0.1 only. From your own computer:
     ssh -L 8443:127.0.0.1:8443 $(id -un)@<this-host>
   then open $ORIGIN/setup. The certificate is from Caddy's own CA, so the
   browser warns until you trust it (see docker/Caddyfile.local).
   For Tailscale instead, install with --origin https://<this-machine>.<tailnet>.ts.net:8443
   (or set ZUMIBOT_LOCAL_ORIGIN to it in $DIR/.env)."
  else
    REACH="It listens on 127.0.0.1 only. To reach it over Tailscale, run on this machine:
     tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443
   then open $ORIGIN/setup from any device on the tailnet. The certificate is
   from Caddy's own CA, so the browser warns until you trust it (see
   docker/Caddyfile.local)."
  fi
fi

cat <<DONE

------------------------------------------------------------------------------
ZumiBot $version is running from $DIR.
The Docker install is a preview: it has not been proven on many real hosts yet.

1. $REACH

2. Paste the one-time setup code. It is in the server's log:
     cd $DIR && docker compose logs $SVC
   A restart prints a new one; it is gone once setup finishes.

3. Sign the claude CLI in, once:
     cd $DIR && docker compose exec $SVC claude

Update later by running the same command again (it refuses while a reply is
running), or: sh $DIR/docker/install.sh
$BACK
Back up the data and vault volumes: see docs/architecture/install.md.
------------------------------------------------------------------------------
DONE
