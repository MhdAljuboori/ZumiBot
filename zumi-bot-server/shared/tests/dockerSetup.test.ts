import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DOCKER_BUNDLE, DOCKER_BUNDLE_DIR, DOCKER_BUNDLE_FILES } from '@zumibot/shared/dockerBundle'
import { RELEASE_PUBLIC_KEY, dockerBundleSignedText } from '@zumibot/shared/update'

// The container install is the path someone else uses first, and nothing here is exercised by the unit suite,
// so these are the facts that must not drift. Raw text on purpose: no YAML dependency, and each check fails
// loudly if the shape changes. The real build and a wizard run in it are a manual step (docs/architecture/install.md).
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const dockerfile = read('Dockerfile')
const compose = read('docker-compose.yml')
const envExample = read('.env.example')

/** Each top-level service block of docker-compose.yml, by name. */
function services(text: string): Map<string, string> {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === 'services:')
  expect(start, 'docker-compose.yml has no services: block').toBeGreaterThanOrEqual(0)
  const out = new Map<string, string>()
  let name: string | null = null
  let body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && line.trim() !== '') break // the next top-level key ends the block
    const m = /^ {2}([a-z0-9-]+):\s*$/.exec(line)
    if (m) {
      if (name) out.set(name, body.join('\n'))
      name = m[1]!
      body = []
    } else if (name) body.push(line)
  }
  if (name) out.set(name, body.join('\n'))
  return out
}

const byName = services(compose)

describe('Dockerfile', () => {
  it('pins both node stages to the same base image by digest', () => {
    const froms = [...dockerfile.matchAll(/^FROM (node:\S+)/gm)].map((m) => m[1]!)
    expect(froms).toHaveLength(2)
    for (const f of froms) expect(f, f).toMatch(/^node:22-bookworm-slim@sha256:[0-9a-f]{64}$/)
    expect(froms[0]).toBe(froms[1])
  })

  it('has a dist stage a release can swap for the signed tarball app folder', () => {
    expect(dockerfile.match(/^FROM scratch AS dist$/gm)).toHaveLength(1)
    expect(dockerfile).toMatch(/^FROM node:\S+ AS build$/m)
    // Split on stage starts, so each COPY is checked in the stage it sits in.
    const stages = dockerfile.split(/^(?=FROM )/m).filter((b) => b.startsWith('FROM '))
    expect(stages).toHaveLength(3)
    const [build, dist, runtime] = stages as [string, string, string]
    expect(build).toMatch(/^FROM node:\S+ AS build$/m)
    expect(dist).toMatch(/^FROM scratch AS dist$/m)
    expect(dist).toMatch(/^COPY --from=build \/src\/zumi-bot-server\/backend\/dist \/$/m)
    expect(runtime).toMatch(/^COPY --from=dist \/ \/app$/m)
    expect(runtime).not.toMatch(/COPY --from=build/)
  })

  it('names no repo or GitHub account in any image label', () => {
    for (const l of dockerfile.split('\n').filter((x) => /^\s*LABEL\b/.test(x))) {
      expect(l).not.toMatch(/github|org\.opencontainers\.image\.source/i)
    }
  })

  it('pins the claude CLI to one exact version and turns its updater off', () => {
    expect(dockerfile).toMatch(/^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m)
    expect(dockerfile).toContain('npm i -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"')
    expect(dockerfile).toMatch(/^ENV DISABLE_AUTOUPDATER=1$/m)
  })

  it('installs what the server shells out to', () => {
    // bash comes with the base image (shellEnv and claudeLocator ask a login shell); these do not.
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends git tzdata ca-certificates/)
  })

  it('runs as a non-root user that owns every volume path', () => {
    expect(dockerfile).toMatch(/^USER zumibot$/m)
    expect(dockerfile).toMatch(/useradd .*--uid 10001 .*zumibot/)
    // A named volume over a path the image never made comes out owned by root.
    expect(dockerfile).toMatch(/mkdir -p \/data \/vault \/home\/zumibot\/\.claude/)
    expect(dockerfile).toMatch(/chown -R zumibot:zumibot \/data \/vault \/home\/zumibot/)
  })

  it('points CLAUDE_CONFIG_DIR at exactly the home .claude', () => {
    // Anything else splits ZumiBot's view from the CLI's: the agents folder and the CLI's session logs are
    // joined from HOME whatever this says (see install.md, "The claude CLI in a container").
    expect(dockerfile).toMatch(/^ENV HOME=\/home\/zumibot|^ENV NODE_ENV=production HOME=\/home\/zumibot/m)
    expect(dockerfile).toMatch(/^ENV CLAUDE_CONFIG_DIR=\/home\/zumibot\/\.claude$/m)
  })

  it('keeps the vault key outside the data dir, in a folder of its own', () => {
    expect(dockerfile).toMatch(/^ENV ZUMIBOT_DATA_DIR=\/data|ZUMIBOT_DATA_DIR=\/data/m)
    expect(dockerfile).toMatch(/^ENV ZUMIBOT_VAULT_KEY_FILE=\/vault\/vault\.key$/m)
  })

  it('health-checks through the control socket, which answers in the setup state too', () => {
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*zumibot-server busy/)
  })
})

describe('docker-compose.yml', () => {
  it('has both profiles, and every service belongs to one', () => {
    expect([...byName.keys()].sort()).toEqual(['caddy', 'caddy-local', 'zumibot', 'zumibot-local'])
    expect(byName.get('zumibot')).toMatch(/profiles: \[domain\]/)
    expect(byName.get('caddy')).toMatch(/profiles: \[domain\]/)
    expect(byName.get('zumibot-local')).toMatch(/profiles: \[local\]/)
    expect(byName.get('caddy-local')).toMatch(/profiles: \[local\]/)
  })

  it('gives Caddy the server own network namespace, and only the owner publishes ports', () => {
    for (const [name, body] of byName) {
      const joins = /network_mode: "service:([a-z0-9-]+)"/.exec(body)
      if (!joins) {
        // A namespace owner: it publishes, and never on anything but what .env names.
        expect(body, `${name} should publish ports`).toMatch(/^\s+ports:$/m)
        continue
      }
      // Docker refuses ports on a container that joins another's namespace; keep the file honest about it.
      expect(body, `${name} must not publish ports`).not.toMatch(/^\s+ports:$/m)
      expect(byName.has(joins[1]!), `${name} joins ${joins[1]}, which is not a service`).toBe(true)
      expect(body, `${name} must come back up with its namespace owner`).toMatch(/restart: true/)
    }
  })

  it('publishes only what each profile should', () => {
    expect(byName.get('zumibot')).toMatch(/- "80:80"/)
    expect(byName.get('zumibot')).toMatch(/- "443:443"/)
    // No domain: loopback by default, and never a wildcard.
    expect(byName.get('zumibot-local')).toMatch(/- "\$\{ZUMIBOT_LOCAL_PUBLISH:-127\.0\.0\.1:8443\}:8443"/)
  })

  it('never widens the container network or hands out the docker socket', () => {
    expect(compose).not.toMatch(/network_mode:\s*(host|"host")/)
    expect(compose).not.toMatch(/privileged:\s*true/)
    expect(compose).not.toMatch(/docker\.sock/)
    expect(compose).not.toMatch(/cap_add/)
  })

  it('runs both profiles in vps mode on an https origin', () => {
    for (const name of ['zumibot', 'zumibot-local']) {
      const body = byName.get(name)!
      expect(body, name).toMatch(/ZUMIBOT_MODE: vps/)
      expect(body, name).toMatch(/ZUMIBOT_PORT: "4317"/)
      expect(body, name).toMatch(/ZUMIBOT_ORIGIN: (https:\/\/|\$\{ZUMIBOT_LOCAL_ORIGIN:-https:\/\/)/)
    }
    // From the shared anchor, so both profiles get it: without an init the CLI's orphaned grandchildren pile up
    // as zombies under node as pid 1.
    expect(compose).toMatch(/^x-zumibot: &zumibot$/m)
    expect(compose).toMatch(/^ {2}init: true$/m)
    expect(compose).toMatch(/^ {2}stop_grace_period: 30s$/m)
  })

  it('gives the data dir, ~/.claude and the vault key a volume each', () => {
    for (const name of ['zumibot', 'zumibot-local']) {
      // Through the shared anchor, so both profiles keep the same three.
      expect(compose).toMatch(/- data:\/data/)
      expect(compose).toMatch(/- claude:\/home\/zumibot\/\.claude/)
      expect(compose).toMatch(/- vault:\/vault/)
      expect(byName.get(name), name).toMatch(/<<: \*zumibot/)
    }
  })

  it('pins the Caddy image by digest and mounts a Caddyfile that exists', () => {
    expect(compose).toMatch(/image: caddy:\d+\.\d+-alpine@sha256:[0-9a-f]{64}/)
    const mounts = [...compose.matchAll(/\.\/(docker\/Caddyfile[a-z.]*):\/etc\/caddy\/Caddyfile:ro/g)].map((m) => m[1]!)
    expect(mounts.sort()).toEqual(['docker/Caddyfile', 'docker/Caddyfile.local'])
    for (const m of mounts) expect(existsSync(join(ROOT, m)), m).toBe(true)
  })
})

describe('the Caddyfiles', () => {
  it('turn the admin API off, since it would answer inside the server own namespace', () => {
    for (const f of ['docker/Caddyfile', 'docker/Caddyfile.local']) expect(read(f), f).toMatch(/^\tadmin off$/m)
  })

  it('reach the server on loopback and overwrite the forwarded address', () => {
    for (const f of ['docker/Caddyfile', 'docker/Caddyfile.local']) {
      expect(read(f), f).toMatch(/reverse_proxy 127\.0\.0\.1:4317/)
      // Appending would let a client feed the per-IP rate limiter whatever it likes.
      expect(read(f), f).toMatch(/header_up X-Forwarded-For \{remote_host\}/)
    }
  })

  it('serve https only, and open no port 80 in the local profile', () => {
    expect(read('docker/Caddyfile.local')).toMatch(/auto_https disable_redirects/)
    expect(read('docker/Caddyfile.local')).toMatch(/tls internal/)
    for (const f of ['docker/Caddyfile', 'docker/Caddyfile.local']) expect(read(f), f).not.toMatch(/^http:\/\//m)
  })
})

describe('.env.example and the ignore files', () => {
  it('picks a profile and documents both', () => {
    expect(envExample).toMatch(/^COMPOSE_PROFILES=domain$/m)
    expect(envExample).toMatch(/^ZUMIBOT_DOMAIN=/m)
    expect(envExample).toMatch(/#ZUMIBOT_LOCAL_PUBLISH=/)
    expect(envExample).toMatch(/#ZUMIBOT_LOCAL_ORIGIN=/)
    // Namespaced, so a stray CLAUDE_CODE_VERSION in the host shell cannot move the pin.
    expect(envExample).toMatch(/#ZUMIBOT_CLAUDE_VERSION=\d+\.\d+\.\d+$/m)
    expect(envExample).not.toMatch(/^CLAUDE_CODE_VERSION=/m)
  })

  it('keeps the build context small and .env out of both git and the image', () => {
    const ignore = read('.dockerignore')
    for (const entry of ['node_modules', '.git', '.env']) expect(ignore, entry).toContain(entry)
    expect(read('.gitignore')).toMatch(/^\.env$/m)
  })
})

describe('docker/install.sh, the one-liner', () => {
  const script = read('docker/install.sh')
  /** Without the comment lines: the script quotes commands it tells the operator to run themselves. */
  const code = script
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')

  it('stops at the first failure', () => {
    expect(script.split('\n')[0]).toBe('#!/bin/sh')
    expect(script).toMatch(/^set -eu$/m)
  })

  it('defaults to the loopback-only profile, and goes public only with --domain', () => {
    expect(script).toMatch(/if \[ -n "\$DOMAIN" \]; then PROFILE=domain; else PROFILE=local; fi/)
    expect(script).toMatch(/ZUMIBOT_LOCAL_PUBLISH=127\.0\.0\.1:8443/)
  })

  it('takes a bare host name for --domain, never a URL or an IP', () => {
    expect(script).toMatch(/--domain must be a host name such as/)
    expect(script).toMatch(/--domain must be a host name, not an IP address/)
  })

  it('never runs sudo, and only names it for the operator', () => {
    const runs = code.split('\n').filter((l) => /^\s*sudo\b/.test(l) || /(&&|;|\|)\s*sudo\b/.test(l))
    expect(runs).toEqual([])
  })

  it('keeps stdin away from docker, which would eat the rest of a piped script', () => {
    expect(script).toMatch(/^dc\(\) \{ docker compose .*"\$@" <\/dev\/null; \}$/m)
    // Every other line that runs docker (not one that only names it in a message) redirects stdin too.
    const runsDocker = (l: string): boolean => /(^\s*|\$\(|!\s+)docker (compose|info|pull|run)\b/.test(l) && !/^dc\(\)/.test(l)
    const lines = code.split('\n').filter(runsDocker)
    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const line of lines) {
      expect(line, line).toMatch(/<\/dev\/null/)
    }
  })

  it('takes --origin for the loopback profile, on port 8443 only, and says so in --help', () => {
    expect(script).toMatch(/--origin\) .*ORIGIN_ARG=\$2/)
    expect(script).toMatch(/^ {2}--origin URL /m)
    expect(script).toContain('--origin must be https://HOST:8443')
    expect(script).toContain('--origin is for the loopback profile')
    expect(script).toMatch(/ORIGIN_ARG:\+--origin "\$ORIGIN_ARG"/)
    // The existing-install rule is the one --domain has.
    expect(script).toContain('already exists and says something else')
    expect(script).toContain('tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443')
  })

  it('refuses a release older than the installed one, before any download, and names both ways back', () => {
    expect(script).toContain('which is older')
    expect(script).toMatch(/\$DIR\/VERSION/)
    const msg = script.split('\n').find((l) => l.includes('which is older'))!
    expect(msg).toContain('.prev')
    expect(msg).toContain('--bundle')
    expect(script.indexOf('which is older')).toBeLessThan(script.indexOf('fetch "$base/$BUNDLE"'))
  })

  it('names Docker Desktop, OrbStack or Colima on a Mac, with no usermod line there', () => {
    expect(script).toContain('uname -s')
    expect(script).toContain('Docker Desktop, OrbStack or Colima')
    expect(script).toContain('Start Docker Desktop, OrbStack or Colima')
    const lines = script.split('\n')
    const start = lines.find((l) => l.includes('Start Docker Desktop, OrbStack or Colima'))!
    expect(start).not.toContain('usermod')
    const usermod = lines.filter((l) => l.includes('usermod'))
    expect(usermod.length).toBeGreaterThan(0)
    for (const l of usermod) expect(l).not.toContain('Colima')
  })

  it('reads the release from the site, never from a source archive', () => {
    expect(script).toMatch(/^SITE=\$\{ZUMIBOT_UPDATE_URL:-https:\/\/zumibot\.run\}$/m)
    expect(script).toContain('$SITE/releases/latest.json')
    expect(script).toContain('base=$SITE/releases/$rel')
    expect(script).toContain('fetch "$base/$BUNDLE"')
    for (const gone of ['github.com', 'raw.githubusercontent', '--build', '--unsafe-ref', '--tarball', '--ref']) {
      expect(code, gone).not.toContain(gone)
    }
    expect(script).toMatch(/--proto '=https'/)
    expect(code).not.toMatch(/\|\s*(sudo\s+)?(sh|bash)\b/)
  })

  it('takes --version, --bundle and --dir, and names its bundle like the release does', () => {
    expect(script).toMatch(/--version\) .*VERSION=\$2/)
    expect(script).toMatch(/--bundle\) .*BUNDLE_FILE=\$2/)
    expect(script).toMatch(/--dir\) .*DIR=\$2/)
    expect(script).toMatch(/^DIR=\$\{ZUMIBOT_DOCKER_DIR:-\$HOME\/zumibot-docker\}$/m)
    expect(script).toContain(`BUNDLE=${DOCKER_BUNDLE}\n`)
    expect(script).toContain(`for required in ${DOCKER_BUNDLE_FILES.join(' ')}; do`)
    expect(script).toContain(`$work/${DOCKER_BUNDLE_DIR}`)
  })

  it('carries the publisher key and the verify image, and nothing in the environment can change them', () => {
    const key = /^RELEASE_PUBLIC_KEY='([^']+)'$/m.exec(script)
    expect(key, 'one RELEASE_PUBLIC_KEY=... line').not.toBeNull()
    expect(key![1]).toBe(RELEASE_PUBLIC_KEY)
    const base = /^FROM (node:\S+)/m.exec(dockerfile)![1]!
    expect(script).toContain(`VERIFY_IMAGE='${base}'`)
    expect(script.match(/^(RELEASE_PUBLIC_KEY|VERIFY_IMAGE)=/gm)).toHaveLength(2)
    expect(code).not.toMatch(/RELEASE_PUBLIC_KEY=\$\{|VERIFY_IMAGE=\$\{|:-\$RELEASE_PUBLIC_KEY/)
  })

  it('checks the signature over exactly the text the release signed, in a throwaway container', () => {
    expect(dockerBundleSignedText('V', 'S')).toBe('zumibot-docker\nV\nS\n')
    expect(script).toContain('"zumibot-docker\\n" + e.CB_VERSION + "\\n" + e.CB_SHA256 + "\\n"')
    expect(script).toContain('docker run --rm --network none --read-only --user 65534:65534')
    // The signature goes in by env like the rest, never into the script text.
    expect(script).toContain('e.CB_SIG')
    expect(script).toMatch(/-e CB_SIG="\$sig"/)
    // The pull has its own error, so a missing image is not reported as a bad signature.
    expect(script).toMatch(/docker pull -q "\$VERIFY_IMAGE" <\/dev\/null[^\n]*\\\n\s*\|\| die "Could not pull/)
  })

  it('verifies before it unpacks anything, and a bad signature installs nothing', () => {
    const at = (s: string): number => {
      const i = script.indexOf(s)
      expect(i, s).toBeGreaterThanOrEqual(0)
      return i
    }
    const fetched = at('fetch "$base/$SIG"')
    const verify = at('c.verify(null')
    const refuse = at('The release signature does not verify: nothing was installed.')
    const unpack = at('tar -xzf')
    expect(fetched).toBeLessThan(verify)
    expect(verify).toBeLessThan(refuse)
    expect(refuse).toBeLessThan(unpack)
    expect(script.match(/tar -xzf/g)).toHaveLength(1)
  })

  it('needs nothing on the host but docker to verify: sha256sum or shasum, no openssl, no node', () => {
    expect(code).toContain('sha256sum')
    expect(code).toContain('shasum -a 256')
    expect(code).not.toMatch(/\bopenssl\b/)
    const hostNode = code.split('\n').filter((l) => /(^|[\s;&|(])node\s/.test(l) && !/docker run/.test(l))
    expect(hostNode).toEqual([])
  })

  it('explains a release that has no Docker bundle, and one that is not the signed version', () => {
    expect(script).toMatch(/has no Docker bundle/)
    expect(script).toMatch(/--version/)
    expect(script).toMatch(/says it is \$version, but its signature is for \$rel/)
  })

  it('hands off to the bundle own installer, which does the install', () => {
    expect(script).toContain(`sh "$work/${DOCKER_BUNDLE_DIR}/docker/install.sh" --bundle "$work/$BUNDLE"`)
    expect(script).toMatch(/--bundle "\$work\/\$BUNDLE" .*<\/dev\/null/)
  })

  it('pulls first, checks for running replies, and only then swaps', () => {
    const pull = script.indexOf('docker compose -f "$DIR.next/docker-compose.yml" pull')
    const busy = script.indexOf('exec -T "$SVC" zumibot-server busy')
    const swap = script.indexOf('mv "$DIR" "$DIR.prev"')
    expect(pull).toBeGreaterThan(0)
    expect(busy).toBeGreaterThan(pull)
    expect(swap).toBeGreaterThan(busy)
  })

  it('starts the pulled image, and never builds', () => {
    expect(script).toMatch(/dc up -d --remove-orphans\b/)
    expect(code).not.toMatch(/up -d --build|compose build/)
  })

  it('says the Docker install is a preview in its help and in its closing summary', () => {
    const heredoc = (tag: string): string => new RegExp(`<<${tag}\\n([\\s\\S]*?)\\n${tag}\\n`).exec(script)![1]!
    expect(heredoc('USAGE').split('\n')[0]).toContain('The Docker install is a preview')
    expect(heredoc('DONE')).toContain('The Docker install is a preview')
  })

  it('documents a download-then-read install, and no doc pipes it into a shell', () => {
    expect(script).toMatch(/^# {3}curl -fsSL https:\/\/zumibot\.run\/releases\/latest\/docker\/install\.sh -o install\.sh$/m)
    for (const doc of [script, read('README.md'), read('docs/architecture/install.md')]) {
      expect(doc).not.toMatch(/ZumiBot\/master\/docker\/install\.sh/)
      expect(doc).not.toMatch(/docker\/install\.sh \| sh/)
    }
  })

  it('keeps agent and planning folders out of the build context', () => {
    const ignore = read('.dockerignore')
    for (const entry of ['.claude', '.superpowers']) expect(ignore).toMatch(new RegExp(`^\\${entry}$`, 'm'))
  })

  it('writes .env private on a first install and keeps it on an update', () => {
    expect(script).toMatch(/umask 077/)
    expect(script).toMatch(/cp -p "\$ENV_FILE" "\$DIR\.next\/\.env"/)
  })

  it('refuses to update while a reply is running, unless forced', () => {
    expect(script).toMatch(/exec -T "\$SVC" zumibot-server busy/)
    expect(script).toMatch(/reply\/replies running\. Wait for them, or re-run with --force/)
    expect(script).toMatch(/Could not read the running-reply count/)
  })

  it('swaps the project whole and keeps the previous one', () => {
    expect(script).toMatch(/mv "\$DIR" "\$DIR\.prev"/)
    expect(script).toMatch(/mv "\$DIR\.next" "\$DIR"/)
  })

  it('names the service each profile in docker-compose.yml runs', () => {
    expect(script).toMatch(/domain\) SVC=zumibot ;;/)
    expect(script).toMatch(/local\) SVC=zumibot-local ;;/)
    expect([...byName.keys()]).toEqual(expect.arrayContaining(['zumibot', 'zumibot-local']))
  })

  it('prints where the one-time code is, and never the code', () => {
    expect(script).toMatch(/docker compose logs \$SVC/)
    expect(code).not.toMatch(/logs[^\n]*\|\s*grep/)
  })

  // The docs a reader follows must name the site's URL, never a raw file in the repository, and say it is a preview.
  describe('the docs that teach it', () => {
    const URL = 'https://zumibot.run/releases/latest/docker/install.sh'
    /** The lines after a `## ` heading, up to the next one. */
    const section = (file: string, heading: string): string[] => {
      const lines = read(file).split('\n')
      const start = lines.findIndex((l) => l === heading)
      expect(start, `${file} has no "${heading}"`).toBeGreaterThanOrEqual(0)
      const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
      return lines.slice(start + 1, end < 0 ? undefined : end)
    }
    const docs: [string, string][] = [
      ['README.md', '## Quick start with Docker'],
      ['docs/architecture/install.md', '## Phase 2: Docker']
    ]

    it('never point at a raw file in the repository', () => {
      for (const [file] of docs) expect(read(file), file).not.toContain('raw.githubusercontent.com')
    })

    it('show the installer URL on the public site', () => {
      for (const [file] of docs) expect(read(file), file).toContain(URL)
    })

    it('label the Docker install a preview, near the top of its section', () => {
      for (const [file, heading] of docs) {
        const top = section(file, heading).filter((l) => l.trim() !== '').slice(0, 5)
        expect(top.some((l) => l.startsWith('**Preview:**')), `${file} ${heading}`).toBe(true)
      }
    })

    it('teach the Tailscale form, not a publish on the tailnet address', () => {
      const serve = 'tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443'
      expect(envExample).toContain(serve)
      expect(section('docs/architecture/install.md', '## Phase 2: Docker').join('\n')).toContain(serve)
      for (const text of [envExample, read('docs/architecture/install.md'), read('README.md')]) {
        expect(text).not.toMatch(/PUBLISH=100\./) // the tailnet IP, which fails on Colima and at boot
      }
      expect(envExample).toMatch(/^#ZUMIBOT_LOCAL_ORIGIN=https:\/\/\S+:8443$/m)
    })

    it('document --origin, the refused downgrade and Mac hosts', () => {
      // Phase 3 (no Docker) has its own --origin, so look only at the Docker section.
      const install = section('docs/architecture/install.md', '## Phase 2: Docker').join('\n')
      expect(install).toContain('--origin')
      expect(install).toContain('which is older') // the downgrade refusal itself, not any "older"
      for (const name of ['Docker Desktop', 'OrbStack', 'Colima']) expect(install, name).toContain(name)
      expect(read('README.md')).toContain('--origin https://<this-machine>.<tailnet>.ts.net:8443')
    })

    it('keep no stale install instructions', () => {
      for (const [file] of [...docs, ['docs/architecture/updates.md', '']]) {
        for (const gone of ['--unsafe-ref', 'pull a new image']) expect(read(file), `${file}: ${gone}`).not.toContain(gone)
      }
      expect(read('docs/architecture/install.md')).not.toMatch(/`Dockerfile`, two stages/)
    })
  })
})
