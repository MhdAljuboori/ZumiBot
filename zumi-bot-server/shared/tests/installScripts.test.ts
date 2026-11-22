import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { DOCKER_IMAGE } from '@zumibot/shared/dockerBundle'
import { RELEASE_PUBLIC_KEY, releaseSignedText } from '@zumibot/shared/update'

// install.sh runs on someone else's machine, as a plain user, and may ask for one sudo command. None of that is
// exercised by the unit suite, so these pin the promises it makes. A real run is a manual step
// (docs/architecture/install.md).
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const install = read('zumi-bot-server/deploy/install.sh')
const pack = read('zumi-bot-server/deploy/package.sh')
const unit = read('zumi-bot-server/deploy/zumibot-user.service')
const rollback = read('zumi-bot-server/deploy/bin/zumibot-rollback')
const workflow = read('.github/workflows/release.yml')
// Missing file reads as empty, so its tests fail one by one instead of the whole file failing to load.
const CHECK_RUN = '.github/workflows/docker-image-check.yml'
const checkRun = existsSync(join(ROOT, CHECK_RUN)) ? read(CHECK_RUN) : ''

/** Without the comment lines: these scripts quote commands they tell the operator to run themselves. */
const code = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
/** The first word of each line that runs something. */
const commands = (text: string): string[] =>
  code(text)
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean)

describe('install.sh', () => {
  it('stops at the first failure and runs as the server own user, never root', () => {
    expect(install.split('\n')[0]).toBe('#!/bin/sh')
    expect(install).toMatch(/^set -eu$/m)
    expect(install).toMatch(/\[ "\$\(id -u\)" != 0 \] \|\| die/)
  })

  it('ends an update with a short note, not the first-run steps (they land in the About page update log)', () => {
    const tail = install.slice(install.indexOf('# --- what is left to do'))
    const update = tail.slice(tail.indexOf('if [ "$UPDATING" = 1 ]'), tail.indexOf('exit 0'))
    expect(update).toMatch(/The proxy, your login and your data are unchanged\./)
    expect(update).toMatch(/bin\/zumibot-rollback/)
    expect(update).not.toMatch(/setup code|reverse proxy/)
    // The first-run steps still follow for a fresh install.
    expect(tail.slice(tail.indexOf('exit 0'))).toMatch(/paste the one-time setup code/)
  })

  it('refuses to install the service while the old system-level unit runs, before anything is moved', () => {
    const guard = install.indexOf('systemctl is-active --quiet zumibot')
    expect(guard).toBeGreaterThan(-1)
    expect(install.slice(guard - 120, guard)).toMatch(/have systemctl/)
    expect(install.slice(guard, guard + 400)).toMatch(
      /still running and holds port 4317\. Stop it first: sudo systemctl disable --now zumibot/
    )
    // Skipped with --no-service, and ahead of the app swap and the unit write.
    expect(install.slice(guard - 160, guard)).toMatch(/WITH_SERVICE" = 1/)
    expect(guard).toBeLessThan(install.indexOf('mv "$DIR/app.next" "$DIR/app"'))
    expect(guard).toBeLessThan(install.indexOf('cp "$DIR/systemd/$UNIT_NAME" "$UNIT_FILE"'))
    // It asks the system manager: no --user, so no sudo either.
    expect(install).not.toMatch(/sudo systemctl is-active/)
  })

  it('says the server is up only when its own user unit is active too', () => {
    expect(install).toMatch(
      /until \[ "\$\("\$DIR\/bin\/zumibot-server" busy[^\n]*\] && systemctl --user is-active --quiet "\$UNIT_NAME"; do/
    )
  })

  it('takes only an https origin, with no path', () => {
    expect(install).toMatch(/--origin must start with https:\/\//)
    expect(install).toMatch(/host=\$\{ORIGIN#https:\/\/\}/)
    expect(install).toMatch(/''\|\*\/\*\|/)
  })

  it('asks before the one command that needs root, and runs no other', () => {
    // Every sudo in the script: the linger command, run only inside the ask, plus the lines that print it.
    const sudoLines = install.split('\n').filter((l) => /\bsudo\b/.test(l) && !l.trimStart().startsWith('#'))
    const runs = sudoLines.filter((l) => /^\s*sudo /.test(l.trimStart()) || /&&\s*sudo /.test(l))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatch(/sudo loginctl enable-linger/)
    // It sits inside `if ask "Run it now?"`, after the command has been printed.
    const guarded =
      /say "The command is:  sudo loginctl enable-linger[\s\S]{0,200}?if ask "Run it now\?"; then\s*\n\s*sudo loginctl enable-linger/
    expect(install).toMatch(guarded)
    // And it never installs a package itself, however often it names the command for the operator to run.
    for (const first of commands(install)) {
      expect(['apt-get', 'apt', 'yum', 'dnf', 'pacman', 'npm'], `${first} is run by the script`).not.toContain(first)
    }
  })

  it('never pipes a download into a shell, and refuses a plain-http redirect', () => {
    expect(code(install)).not.toMatch(/\|\s*(sudo\s+)?(sh|bash)\b/)
    expect(install).toMatch(/--proto '=https'/)
    expect(install).toMatch(/--https-only/)
  })

  it('checks the download against SHA256SUMS before it unpacks anything', () => {
    const verify = install.indexOf('does not match $SUMS')
    const unpack = install.indexOf('tar -xzf')
    expect(verify).toBeGreaterThan(0)
    expect(unpack).toBeGreaterThan(verify)
  })

  it('checks the publisher signature before it unpacks anything, and fails closed', () => {
    const key = /^RELEASE_PUBLIC_KEY='([A-Za-z0-9+/=]+)'$/m.exec(install)
    expect(key, 'install.sh pins no key').not.toBeNull()
    expect(key![1]).toBe(RELEASE_PUBLIC_KEY)
    const sig = install.indexOf('fetch "$base/$SIG"')
    const verify = install.indexOf('c.verify(null')
    const refuse = install.indexOf('The release signature does not verify')
    const unpack = install.indexOf('tar -xzf')
    expect(sig).toBeGreaterThan(0)
    expect(verify).toBeGreaterThan(sig)
    expect(refuse).toBeGreaterThan(verify)
    expect(unpack).toBeGreaterThan(refuse)
    // The signed text is the one the server checks (releaseSignedText), and the version inside must be the signed one.
    expect(install).toContain('"zumibot-server\\n" + e.CB_VERSION + "\\n" + e.CB_SHA256 + "\\n"')
    expect(releaseSignedText('V', 'S')).toBe('zumibot-server\nV\nS\n')
    expect(install).toMatch(/"\$version" != "\$rel"/)
  })

  it('holds --dir and --origin to a charset that needs no escaping where they are written', () => {
    expect(install).toMatch(/case \$DIR in \/\*\) ;; \*\) die/)
    expect(install).toContain('case $DIR in *[!A-Za-z0-9._/:-]*) die')
    expect(install).toContain('case $host in *[!A-Za-z0-9.:-]*) die')
    // Before the first place either is written.
    expect(install.indexOf('case $host in *[!A-Za-z0-9.:-]*)')).toBeLessThan(install.indexOf('> "$DIR/bin/zumibot-update"'))
    expect(install.indexOf('case $DIR in *[!A-Za-z0-9._/:-]*)')).toBeLessThan(install.indexOf('mkdir -p "$DIR/bin"'))
  })

  it('refuses to swap the build while a reply is running, unless forced', () => {
    // Through the control socket, the same question the deploy asks.
    expect(install).toMatch(/\$DIR\/bin\/zumibot-server" busy/)
    expect(install).toMatch(/reply\/replies running\. Wait for them, or re-run with --force/)
    // An unreadable count is not "idle": the deploy learned that the hard way.
    expect(install).toMatch(/Could not read the running-reply count/)
  })

  it('replaces the live app whole and keeps the old one for a rollback', () => {
    expect(install).toMatch(/rm -rf "\$DIR\/app\.next"/)
    expect(install).toMatch(/mv "\$DIR\/app" "\$DIR\/app\.prev"/)
    expect(install).toMatch(/mv "\$DIR\/app\.next" "\$DIR\/app"/)
  })

  it('prints where the one-time code is, and never the code', () => {
    expect(install).toMatch(/journalctl --user -u \$UNIT_NAME/)
    expect(install).toMatch(/\$ORIGIN\/setup/)
    // Reading the journal to echo the code would copy a secret into another log.
    expect(install).not.toMatch(/Setup code/)
  })

  it('downloads from the showcase site with no token, over https only', () => {
    expect(install).toMatch(/^SITE=\$\{ZUMIBOT_UPDATE_URL:-https:\/\/zumibot\.run\}$/m)
    expect(install).toMatch(/case \$SITE in https:\/\/\*\) ;; \*\) die/)
    // One version's folder for every file: latest.json names it unless --version did.
    expect(install).toMatch(/fetch "\$SITE\/releases\/latest\.json"/)
    expect(install).toMatch(/rel=\$\{VERSION#v\}/)
    expect(install).toMatch(/^  base=\$SITE\/releases\/\$rel$/m)
    // The self-copy fallback comes from the same place, not from the repository.
    expect(install).toMatch(/fetch "\$SITE\/releases\/latest\/install\.sh"/)
    // No token of any kind is read, sent or asked for.
    expect(code(install)).not.toMatch(/TOKEN|Authorization|Bearer|api\.github\.com|raw\.githubusercontent/)
  })

  it('can snapshot the data folder before the swap, without what cannot be copied or restored', () => {
    expect(install).toMatch(/--snapshot-data\) SNAPSHOT=1/)
    expect(install).toMatch(/DATA=\$\{ZUMIBOT_DATA_DIR:-\$HOME\/\.local\/share\/zumibot\}/)
    for (const skipped of ['browsers', 'browser-runtime', 'claude-tmp', 'control.sock', 'server.lock']) {
      expect(install, skipped).toMatch(new RegExp(`--exclude=\\./${skipped.replace('.', '\\.')}\\b`))
    }
    // Built beside the target and renamed, so a half copy is never called data.prev.
    expect(install).toMatch(/tar -C "\$DATA" [^|]*-cf - \./)
    expect(install).toMatch(/tar -C "\$DIR\/data\.prev\.new" -xf -/)
    expect(install).toMatch(/mv "\$DIR\/data\.prev\.new" "\$DIR\/data\.prev"/)
    // It records which version the snapshot belongs to: the one being replaced.
    expect(install).toMatch(/> "\$DIR\/data\.prev\.new\/\.zumibot-from"/)
    // After the busy check, and after the new app is fully staged and its bin/ in place, but before the live app
    // moves: a failed staging must not leave a new data.prev beside an old app.prev.
    const busy = install.indexOf('reply/replies running')
    const staged = install.indexOf('cp -a "$src/app" "$DIR/app.next"')
    const chmod = install.indexOf('chmod 0755 "$DIR/bin/zumibot-server"')
    const snap = install.indexOf('data.prev.new')
    const clear = install.indexOf('[ "$SNAPSHOT" = 1 ] || rm -rf "$DIR/data.prev"')
    const swap = install.indexOf('rm -rf "$DIR/app.prev"')
    expect(busy).toBeGreaterThan(0)
    expect(staged).toBeGreaterThan(busy)
    expect(chmod).toBeGreaterThan(staged)
    expect(snap).toBeGreaterThan(chmod)
    expect(clear).toBeGreaterThan(snap)
    expect(swap).toBeGreaterThan(clear)
    expect(install.indexOf('mv "$DIR/app" "$DIR/app.prev"')).toBeGreaterThan(swap)
    // No data folder: nothing to keep, and an older data.prev is dropped too.
    expect(install).toMatch(/so there is nothing to keep for a rollback\."\n[^\n]*\n\s*rm -rf "\$DIR\/data\.prev"/)
    // A failed copy stops the update before anything is replaced.
    expect(install).toMatch(/Could not copy the data folder/)
  })

  it('drops a data.prev that no longer belongs to the app it would be rolled back with', () => {
    expect(install).toMatch(/\[ "\$SNAPSHOT" = 1 \] \|\| rm -rf "\$DIR\/data\.prev"/)
  })

  it('keeps the copy of itself and the rollback script from the verified release', () => {
    expect(install).toMatch(/cp "\$src\/install\.sh" "\$DIR\/install\.sh"/)
    expect(install).toMatch(/chmod 0755 "\$DIR\/bin\/zumibot-server" "\$DIR\/bin\/zumibot-rollback"/)
  })

  it('is safe to run twice: it only rewrites a changed unit', () => {
    expect(install).toMatch(/cmp -s "\$DIR\/systemd\/\$UNIT_NAME" "\$UNIT_FILE"/)
  })
})

describe('install.sh and package.sh agree', () => {
  it('packages every file the installer requires', () => {
    const required = /for required in ([^\n]+); do\n\s*\[ -e "\$src\/\$required" \]/.exec(install)
    expect(required, 'install.sh no longer lists what the tarball must hold').not.toBeNull()
    const names = required![1]!.trim().split(/\s+/)
    expect(names.length).toBeGreaterThanOrEqual(4)
    // The server runs the installer out of the tarball, and a rollback needs its script.
    expect(names).toContain('install.sh')
    expect(names).toContain('bin/zumibot-rollback')
    // Each one has to come from somewhere in package.sh's staging.
    const staged = [
      ['app/', /cp -a "\$dist" "\$stage\/app"/],
      ['bin/', /cp -a "\$here\/bin" "\$stage\/bin"/],
      ['install.sh', /cp "\$here\/install\.sh" "\$stage\/install\.sh"/],
      ['systemd/zumibot-user.service', /cp "\$here\/zumibot-user\.service" "\$stage\/systemd\/"/],
      ['VERSION', /printf '%s\\n' "\$version" > "\$stage\/VERSION"/]
    ] as const
    for (const [prefix, rule] of staged) expect(pack, prefix).toMatch(rule)
    for (const name of names) {
      const covered = staged.some(([prefix]) => name === prefix || name.startsWith(prefix.replace(/\/$/, '') + '/'))
      expect(covered, `${name} is required by install.sh but package.sh does not stage it`).toBe(true)
    }
  })

  it('refuses to package a build that is not whole', () => {
    expect(pack).toMatch(/Run 'npm run build:server' first/)
    // The blank-page incident behind the deploy's own check: index.html naming assets that are not there.
    expect(pack).toMatch(/names assets that are not in the build/)
  })

  it('writes the two files the installer downloads', () => {
    expect(pack).toMatch(/archive=\$out\/zumibot-server\.tar\.gz/)
    expect(pack).toMatch(/> SHA256SUMS/)
    expect(install).toMatch(/^ASSET=zumibot-server\.tar\.gz$/m)
    expect(install).toMatch(/^SUMS=SHA256SUMS$/m)
  })
})

describe('the systemd user unit', () => {
  it('is a user unit with no User= of its own', () => {
    expect(unit).toMatch(/^WantedBy=default\.target$/m)
    expect(unit).not.toMatch(/^User=/m)
  })

  it('carries the placeholders install.sh fills in, and nothing else', () => {
    const placeholders = [...unit.matchAll(/<([A-Z_]+)>/g)].map((m) => m[1]!)
    expect([...new Set(placeholders)].sort()).toEqual(['ZUMIBOT_DIR', 'ZUMIBOT_ORIGIN'])
    for (const p of placeholders) expect(install, p).toContain(`<${p}>`)
  })

  it('tells the server where it was installed, so it can update itself', () => {
    expect(unit).toMatch(/^Environment=ZUMIBOT_INSTALL_DIR=<ZUMIBOT_DIR>$/m)
  })

  it('runs in vps mode on the installed origin and stops on SIGTERM', () => {
    expect(unit).toMatch(/ZUMIBOT_MODE=vps/)
    expect(unit).toMatch(/NODE_ENV=production/)
    expect(unit).toMatch(/^KillSignal=SIGTERM$/m)
    expect(unit).toMatch(/^NoNewPrivileges=true$/m)
  })
})

describe('the release workflow', () => {
  /** The text of one job, from its key to the next top-level job (or the end). */
  const job = (name: string): string => {
    const start = workflow.indexOf(`\n  ${name}:\n`)
    expect(start, name).toBeGreaterThan(-1)
    const next = workflow.slice(start + 1).search(/\n  [\w-]+:\n/)
    return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
  }

  it('runs on a tag only, with no default permission and only what each job needs', () => {
    expect(workflow).toMatch(/on:\n\s*push:\n\s*tags: \['v\*'\]/)
    expect(workflow).toMatch(/^permissions: \{\}$/m)
    expect(job('build')).toMatch(/permissions:\n\s*contents: read\n/)
    expect(job('build')).not.toMatch(/contents: write/)
    expect(job('publish')).toMatch(/permissions:\n\s*contents: write[^\n]*\n/)
    expect(job('publish')).not.toMatch(/actions: (read|write)/)
    expect(workflow).not.toMatch(/pull-requests|id-token|packages:/)
  })

  it('pins every action by commit, the artifact download included', () => {
    const uses = workflow.match(/uses: [^\n]+/g) ?? []
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/)
    expect(workflow).toMatch(/uses: actions\/download-artifact@/)
    expect(workflow).not.toMatch(/gh run download/)
  })

  it('leaves no git credentials behind for later steps', () => {
    const checkouts = workflow.match(/uses: actions\/checkout@/g) ?? []
    expect(checkouts.length).toBeGreaterThanOrEqual(2)
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(checkouts.length)
  })

  it('keeps npm out of the job that holds the signing key and the write token', () => {
    const publish = code(job('publish'))
    expect(publish).not.toMatch(/\bnpm\b|\bnpx\b|cache: npm/)
    expect(code(job('build'))).not.toMatch(/secrets\.|gh release/)
    expect(job('build')).toMatch(/actions\/upload-artifact@/)
  })

  it('signs the tarball with RELEASE_SIGNING_KEY, fails without it, and publishes the signature', () => {
    const publish = job('publish')
    expect(workflow.match(/secrets\.RELEASE_SIGNING_KEY/g)).toHaveLength(1)
    expect(publish).toMatch(/RELEASE_SIGNING_KEY: \$\{\{ secrets\.RELEASE_SIGNING_KEY \}\}/)
    expect(publish).toMatch(/if \[ -z "\$RELEASE_SIGNING_KEY" \]; then[\s\S]{0,160}exit 1/)
    expect(publish).toMatch(/release-sign\.mjs "\$\{GITHUB_REF_NAME#v\}" release/)
    expect(publish.indexOf('release-sign.mjs')).toBeLessThan(publish.indexOf('gh release create'))
    expect(publish).toMatch(/release\/zumibot-server\.tar\.gz\.sig/)
  })

  it('pins every action by commit', () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((m) => m[1]!)
    expect(uses.length).toBeGreaterThanOrEqual(2)
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
  })

  it('stops before publishing when the tag and the version disagree', () => {
    expect(workflow).toMatch(/does not match version/)
    expect(workflow).toMatch(/npm run typecheck/)
  })

  it('publishes exactly what package.sh wrote, and creates no tag of its own', () => {
    expect(workflow).toMatch(/sh zumi-bot-server\/deploy\/package\.sh release/)
    expect(workflow).toMatch(/release\/zumibot-server\.tar\.gz/)
    expect(workflow).toMatch(/release\/SHA256SUMS/)
    // It names the tag-and-push in a comment for the releaser; it must never run one.
    expect(code(workflow)).not.toMatch(/git tag|git push/)
  })

  it('takes the release notes from CHANGELOG.md, never generated ones', () => {
    expect(workflow).toMatch(/changelog\.mjs notes/)
    expect(workflow).toMatch(/--notes-file/)
    expect(workflow).not.toMatch(/--generate-notes/)
  })

  it('pings the Vercel deploy hook only when the secret is set, from the one step that uses it', () => {
    expect(workflow.match(/secrets\.VERCEL_DEPLOY_HOOK/g)).toHaveLength(1)
    // Step level: no other step's env carries it.
    expect(workflow).toMatch(
      /- name: Rebuild the showcase site\n\s+env:\n\s+VERCEL_DEPLOY_HOOK: \$\{\{ secrets\.VERCEL_DEPLOY_HOOK \}\}\n\s+run: \|\n\s+if \[ -z "\$VERCEL_DEPLOY_HOOK" \]/
    )
    expect(code(workflow)).toMatch(/curl -fsS -X POST "\$VERCEL_DEPLOY_HOOK"/)
  })

  it('pushes the multi-arch image by digest from a job that runs no npm and has only a read token', () => {
    const image = job('image')
    expect(image).toMatch(/needs: build\n/)
    expect(image).toMatch(/permissions:\n( +)contents: read\n(?!\1\S)/)
    expect(code(image)).not.toMatch(/\bnpm\b|\bnpx\b|setup-node/)
    expect(image).toContain('push-by-digest=true')
    // The tags come later, from the publish job, after signing.
    expect(code(image)).not.toMatch(/--tag|\s-t\s/)
    expect(image).toContain('--build-context dist=release/unpacked/zumibot-server/app')
    expect(image).toContain('--platform linux/amd64,linux/arm64')
    expect(image).toMatch(/outputs:\n\s*digest: \$\{\{ steps\.push\.outputs\.digest \}\}/)
    expect(image).toMatch(/containerimage\.digest/)
    expect(image).toMatch(/sha256:\[0-9a-f\]\{64\}/)
  })

  it('logs in to Docker Hub in two steps only, token through env and stdin, failing when a secret is missing', () => {
    expect(workflow.match(/secrets\.DOCKERHUB_TOKEN/g)).toHaveLength(2)
    expect(workflow.match(/secrets\.DOCKERHUB_USERNAME/g)).toHaveLength(2)
    for (const name of ['image', 'publish']) {
      const text = job(name)
      expect(text.match(/secrets\.DOCKERHUB_TOKEN/g), name).toHaveLength(1)
      expect(text, name).toMatch(/\n\s+env:\n(\s+[A-Z_]+: [^\n]+\n)*\s+DOCKERHUB_TOKEN: \$\{\{ secrets\.DOCKERHUB_TOKEN \}\}\n/)
      expect(text, name).toContain('--password-stdin')
    }
    for (const line of code(workflow).split('\n')) {
      if (/docker login/.test(line)) expect(line).not.toMatch(/\s-p\s|--password\s/)
      if (/docker login/.test(line)) expect(line).toContain('--password-stdin')
    }
    expect(job('image')).toMatch(/DOCKERHUB_USERNAME[\s\S]{0,40}DOCKERHUB_TOKEN[\s\S]{0,200}exit 1/)
    expect(job('image')).toMatch(/if: always\(\)[\s\S]*docker logout/)
  })

  it('packs and signs the Docker bundle, tags the image only after signing, then publishes the bundle', () => {
    // Comments name these scripts too, so the order is read from the code.
    const publish = code(job('publish'))
    expect(job('publish')).toMatch(/needs: \[build, image\]\n/)
    expect(publish).toMatch(/DIGEST: \$\{\{ needs\.image\.outputs\.digest \}\}/)
    const at = (needle: string): number => {
      const i = publish.indexOf(needle)
      expect(i, needle).toBeGreaterThan(-1)
      return i
    }
    expect(at('docker-bundle.mjs')).toBeLessThan(at('release-sign.mjs'))
    expect(at('release-sign.mjs')).toBeLessThan(at('imagetools create'))
    expect(at('imagetools create')).toBeLessThan(at('gh release create'))
    expect(at('gh release create')).toBeLessThan(at('Rebuild the showcase site'))
    expect(publish).toMatch(/docker-bundle\.mjs "\$\{GITHUB_REF_NAME#v\}" "\$IMAGE:\$\{GITHUB_REF_NAME#v\}@\$DIGEST" release/)
    expect(publish).toMatch(/imagetools create --tag "\$IMAGE:\$\{GITHUB_REF_NAME#v\}" --tag "\$IMAGE:latest" "\$IMAGE@\$DIGEST"/)
    const create = publish.slice(at('gh release create'))
    expect(create).toContain('release/zumibot-docker.tar.gz \\')
    expect(create).toContain('release/zumibot-docker.tar.gz.sig')
  })

  it('names the same image as the installer bundle code', () => {
    expect(workflow).toMatch(new RegExp(`^  IMAGE: ${DOCKER_IMAGE.replace(/\./g, '\\.')}$`, 'm'))
  })
})

describe('the Docker image check run', () => {
  /** The `on:` block's keys. */
  const triggers = (): string[] => {
    const block = /^on:\n((?: {2,}.*\n|\n)+)/m.exec(checkRun)?.[1] ?? ''
    return [...block.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]!)
  }
  /** The `check` job's text: the last job, so everything from its key. */
  const check = (): string => {
    const start = checkRun.indexOf('\n  check:\n')
    expect(start).toBeGreaterThan(-1)
    return checkRun.slice(start)
  }

  it('runs by hand only, with no default permission and a read-only job', () => {
    expect(triggers()).toEqual(['workflow_dispatch'])
    expect(checkRun).toMatch(/^permissions: \{\}$/m)
    expect(check()).toMatch(/permissions:\n\s*contents: read\n/)
    expect(check()).not.toMatch(/contents: write/)
    expect(checkRun).not.toMatch(/pull-requests|id-token|packages:/)
  })

  it('holds no secret and pushes nothing', () => {
    const text = code(checkRun)
    expect(text).not.toMatch(/secrets\./)
    expect(text).not.toMatch(/docker login|docker logout|--password/)
    expect(text).not.toMatch(/push=true|imagetools|docker push|--push\b/)
    expect(text).not.toMatch(/git tag|git push|gh release/)
  })

  it('pins every action by commit and leaves no git credentials behind', () => {
    const uses = [...checkRun.matchAll(/uses: (\S+)/g)].map((m) => m[1]!)
    expect(uses.length).toBeGreaterThanOrEqual(4)
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
    const checkouts = checkRun.match(/uses: actions\/checkout@/g) ?? []
    expect(checkouts.length).toBeGreaterThanOrEqual(1)
    expect(checkRun.match(/persist-credentials: false/g)).toHaveLength(checkouts.length)
  })

  it('builds the way the release does, so a pass means the release build works', () => {
    const lines = (text: string): string[] =>
      code(text)
        .split('\n')
        .map((l) => l.trim())
    const release = lines(workflow)
    const mine = lines(checkRun)
    const same = [
      '- run: npm ci --ignore-scripts --no-audit --no-fund',
      '- run: npm run build:server',
      '- run: sh zumi-bot-server/deploy/package.sh release',
      'mkdir -p release/unpacked',
      'tar -xzf release/zumibot-server.tar.gz -C release/unpacked',
      ...release.filter((l) => /^- uses: docker\/setup-(qemu|buildx)-action@/.test(l)),
      ...release.filter((l) => /^- uses: actions\/(checkout|setup-node)@/.test(l))
    ]
    expect(same.filter((l) => l.startsWith('- uses: docker/'))).toHaveLength(2)
    for (const line of new Set(same)) {
      expect(release, line).toContain(line)
      expect(mine, line).toContain(line)
    }
    for (const flag of ['--build-context dist=release/unpacked/zumibot-server/app', '--platform linux/amd64,linux/arm64']) {
      expect(workflow, flag).toContain(flag)
      expect(checkRun, flag).toContain(flag)
    }
    expect(checkRun).toMatch(/cache: npm/)
    expect(checkRun).toContain('--output type=cacheonly')
  })

  it('starts the image as the compose file does and waits for the server and the claude CLI', () => {
    const text = code(check())
    expect(text).toMatch(/--load\b[\s\S]*-t zumibot-check/)
    expect(text).toMatch(/--platform linux\/amd64 \\/)
    expect(text).toMatch(/ZUMIBOT_MODE=vps/)
    expect(text).toMatch(/ZUMIBOT_PORT=4317/)
    expect(text).toMatch(/ZUMIBOT_ORIGIN=https:\/\/localhost:8443/)
    expect(text).toMatch(/docker run -d[\s\S]*zumibot-check/)
    expect(text).toMatch(/docker exec "\$c" zumibot-server busy/)
    expect(text).toMatch(/docker exec "\$c" claude --version/)
    expect(text).toMatch(/docker logs/)
    expect(text).toMatch(/60/)
  })

  it("proves the image holds the tarball's server.mjs, so a build context the build ignored cannot pass", () => {
    const text = code(check())
    expect(text).toMatch(/docker exec "\$c" sha256sum \/app\/server\.mjs/)
    expect(text).toMatch(/sha256sum release\/unpacked\/zumibot-server\/app\/server\.mjs/)
    expect(text).toMatch(/!= "\$(want|have)"|\[ "\$\w+" != "\$\w+" \]/)
  })

  it('packs the Docker bundle with a dummy digest and has compose read both profiles', () => {
    const text = code(check())
    expect(text).toMatch(/docker-bundle\.mjs "\$version" "docker\.io\/mhdaljuboori\/zumibot:\$version@sha256:0{64}" release/)
    expect(text).toMatch(/require\('\.\/zumi-bot-server\/backend\/package\.json'\)\.version/)
    expect(text).toMatch(/COMPOSE_PROFILES=local docker compose -f \S+\/docker-compose\.yml config -q/)
    expect(text).toMatch(/COMPOSE_PROFILES=domain ZUMIBOT_DOMAIN=check\.example\.com docker compose -f \S+\/docker-compose\.yml config -q/)
    expect(text).toMatch(/sh -n docker\/install\.sh/)
  })

  it('names the same image as the installer bundle code', () => {
    expect(checkRun).toContain(DOCKER_IMAGE)
  })
})

describe('release-sign.mjs', () => {
  const sign = read('zumi-bot-server/deploy/release-sign.mjs')

  it('signs the Docker bundle too, but only after its hash matches SHA256SUMS', () => {
    expect(sign).toContain('dockerBundleSignedText')
    expect(sign).toContain('DOCKER_BUNDLE')
    expect(sign.indexOf('SHA256SUMS does not match')).toBeGreaterThan(-1)
    expect(sign.indexOf('SHA256SUMS does not match')).toBeLessThan(sign.indexOf('sign(null'))
  })
})

describe('zumibot-rollback', () => {
  const sh = (cmd: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string }) => spawnSync('sh', cmd, { encoding: 'utf8', ...opts })

  it('is a plain sh script that stops at the first failure and refuses root', () => {
    expect(rollback.split('\n')[0]).toBe('#!/bin/sh')
    expect(rollback).toMatch(/^set -eu$/m)
    expect(rollback).toMatch(/\[ "\$\(id -u\)" != 0 \] \|\| die/)
  })

  it('checks both snapshots exist before it stops or moves anything', () => {
    const stop = rollback.indexOf('systemctl --user stop')
    const firstMove = rollback.indexOf('move "$DIR/app"')
    for (const need of ['"$DIR/app.prev"', '"$DIR/data.prev"']) {
      const at = rollback.indexOf(`[ -d ${need} ]`)
      expect(at, need).toBeGreaterThan(0)
      expect(at, need).toBeLessThan(stop)
    }
    expect(stop).toBeGreaterThan(0)
    expect(firstMove).toBeGreaterThan(stop)
    // It starts again only after everything is back. (The hand-finish text earlier names the command too.)
    expect(rollback.lastIndexOf('systemctl --user start')).toBeGreaterThan(firstMove)
    // A move that fails says how to finish, and leaves the server stopped rather than starting half a state.
    expect(rollback).toMatch(/move\(\) \{ STEP=\$\(\(STEP \+ 1\)\); mv -- "\$1" "\$2" \|\| stuck/)
    // It lists only what has not happened yet, from the step that failed.
    expect(rollback).toMatch(/tail -n \+"\$STEP"/)
    // The data comes back through <data>.restoring and a last rename, never a copy straight into the data folder.
    expect(rollback).toMatch(/move "\$DIR\/data\.prev" "\$DATA\.restoring"/)
    expect(rollback).toMatch(/move "\$DATA\.restoring" "\$DATA"/)
  })

  it('writes the marker the server reads at boot, into the restored data folder', () => {
    expect(rollback).toMatch(/update-rolled-back/)
    expect(rollback).toMatch(/\.zumibot-from/)
  })

  // A systemd host's sh script: Git Bash's sh mangles the fakes' ':' PATH and prints C:\ paths.
  describe.skipIf(process.platform === 'win32')('run against a scratch install', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'zumibot-rollback-test-'))
    const fakeBin = join(scratch, 'fakebin')
    const calls = join(scratch, 'systemctl.log')
    afterAll(() => rmSync(scratch, { recursive: true, force: true }))
    const put = (file: string, text: string): void => {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, text)
    }
    const setup = (name: string): { dir: string; data: string; env: NodeJS.ProcessEnv; script: string } => {
      const dir = join(scratch, name, 'install')
      const data = join(scratch, name, 'data')
      mkdirSync(join(dir, 'bin'), { recursive: true })
      const script = join(dir, 'bin', 'zumibot-rollback')
      writeFileSync(script, rollback)
      chmodSync(script, 0o755)
      return { dir, data, script, env: { ...process.env, ZUMIBOT_DATA_DIR: data, PATH: `${fakeBin}:${process.env.PATH}` } }
    }
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(join(fakeBin, 'systemctl'), `#!/bin/sh\necho "$@" >> '${calls}'\n`)
    chmodSync(join(fakeBin, 'systemctl'), 0o755)

    const asRoot = process.getuid?.() === 0
    it.skipIf(asRoot)('swaps the app and the data back, brings the browsers along and leaves the failed ones aside', () => {
      const { dir, data, env, script } = setup('ok')
      put(join(dir, 'app/server.mjs'), 'new')
      put(join(dir, 'app.prev/server.mjs'), 'old')
      put(join(dir, 'VERSION'), '10.7.0\n')
      put(join(dir, 'data.prev/chats/a.json'), 'before')
      put(join(dir, 'data.prev/.zumibot-from'), '10.6.4\n')
      put(join(data, 'chats/a.json'), 'after')
      put(join(data, 'browsers/chrome/bin'), 'browser')
      put(join(data, 'browser-runtime/x'), 'rt')
      const r = sh([script], { env })
      expect(r.status, r.stderr).toBe(0)
      expect(readFileSync(join(dir, 'app/server.mjs'), 'utf8')).toBe('old')
      expect(readFileSync(join(dir, 'app.failed/server.mjs'), 'utf8')).toBe('new')
      expect(readFileSync(join(data, 'chats/a.json'), 'utf8')).toBe('before')
      expect(readFileSync(join(`${data}.failed`, 'chats/a.json'), 'utf8')).toBe('after')
      expect(readFileSync(join(data, 'browsers/chrome/bin'), 'utf8')).toBe('browser')
      expect(existsSync(join(data, 'browser-runtime/x'))).toBe(true)
      expect(existsSync(`${data}.restoring`)).toBe(false)
      expect(existsSync(join(dir, 'app.prev'))).toBe(false)
      expect(existsSync(join(dir, 'data.prev'))).toBe(false)
      expect(existsSync(join(data, '.zumibot-from'))).toBe(false)
      expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toBe('10.6.4')
      expect(JSON.parse(readFileSync(join(data, 'update-rolled-back'), 'utf8'))).toEqual({ from: '10.7.0', to: '10.6.4' })
      expect(readFileSync(calls, 'utf8').trim().split('\n').slice(-2)).toEqual(['--user stop zumibot', '--user start zumibot'])
    })

    it.skipIf(asRoot)('changes nothing, and does not stop the server, when a snapshot is missing', () => {
      const { dir, data, env, script } = setup('missing')
      put(join(dir, 'app/server.mjs'), 'new')
      put(join(dir, 'app.prev/server.mjs'), 'old')
      put(join(data, 'chats/a.json'), 'after')
      rmSync(calls, { force: true })
      const r = sh([script], { env })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/data\.prev/)
      expect(readFileSync(join(dir, 'app/server.mjs'), 'utf8')).toBe('new')
      expect(readFileSync(join(data, 'chats/a.json'), 'utf8')).toBe('after')
      expect(existsSync(calls)).toBe(false)
    })

    it.skipIf(asRoot)('lists only the steps still to do when a move fails, and leaves the server stopped', () => {
      const { dir, data, env, script } = setup('stuck')
      put(join(dir, 'app/server.mjs'), 'new')
      put(join(dir, 'app.prev/server.mjs'), 'old')
      put(join(dir, 'data.prev/chats/a.json'), 'before')
      put(join(data, 'chats/a.json'), 'after')
      // The mv shim below fails the move of the app to app.failed (step 2), after data.prev was staged.
      const bin = join(scratch, 'stuck', 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'mv'), `#!/bin/sh\nfor last; do :; done\ncase "$last" in *app.failed) exit 1 ;; esac\nexec /bin/mv "$@"\n`)
      chmodSync(join(bin, 'mv'), 0o755)
      rmSync(calls, { force: true })
      const r = sh([script], { env: { ...env, PATH: `${bin}:${env.PATH}` } })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/mv '.*\/app' '.*\/app\.failed'/)
      expect(r.stderr).toMatch(/systemctl --user start zumibot/)
      // The step that already happened is not repeated, and nothing is deleted by hand.
      expect(r.stderr).not.toMatch(/data\.prev/)
      expect(r.stderr).not.toMatch(/rm -rf/)
      expect(readFileSync(calls, 'utf8')).not.toMatch(/start/)
    })
  })
})

// The VPS installer targets a systemd Linux host; Git Bash's GNU tar reads C:\ archive paths as a remote host.
describe.skipIf(process.platform === 'win32')('install.sh run against a scratch dir', () => {
  // ENOENT is the only error that says the program is missing.
  const haveTools = ['sh', 'tar'].every((t) => spawnSync(t, ['-c', 'true'], { stdio: 'ignore' }).error === undefined)
  const asRoot = process.getuid?.() === 0
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22

  it.skipIf(asRoot || !haveTools || !nodeOk)('--snapshot-data keeps the data minus what is left out, with the replaced version', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'zumibot-install-test-'))
    try {
      // A minimal release: only what the installer requires.
      const rel = join(scratch, 'rel/zumibot-server')
      const put = (file: string, text: string): void => {
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, text)
      }
      put(join(rel, 'app/server.mjs'), '')
      put(join(rel, 'app/login/setup.html'), '')
      put(join(rel, 'bin/zumibot-server'), '#!/bin/sh\n')
      put(join(rel, 'bin/zumibot-rollback'), '#!/bin/sh\n')
      put(join(rel, 'systemd/zumibot-user.service'), 'ZUMIBOT_ORIGIN=<ZUMIBOT_ORIGIN> <ZUMIBOT_DIR>\n')
      put(join(rel, 'install.sh'), install)
      // The shipped proxy templates: install.sh must swap their template host for --origin's.
      for (const f of ['Caddyfile', 'nginx-zumibot.conf']) put(join(rel, 'proxy', f), read(`zumi-bot-server/deploy/${f}`))
      put(join(rel, 'VERSION'), '2.0.0\n')
      const tarball = join(scratch, 'zumibot-server.tar.gz')
      expect(spawnSync('tar', ['-czf', tarball, '-C', join(scratch, 'rel'), 'zumibot-server']).status).toBe(0)

      const dir = join(scratch, 'install')
      const data = join(scratch, 'data')
      put(join(data, 'chats/a.json'), 'keep me')
      for (const left of ['browsers/x', 'browser-runtime/x', 'claude-tmp/x', 'server.lock']) put(join(data, left), 'x')
      put(join(dir, 'VERSION'), '1.0.0\n')
      mkdirSync(join(dir, 'app'), { recursive: true })

      // The run is offline (--tarball) and must stay so.
      const env = { ...process.env, HOME: join(scratch, 'home'), ZUMIBOT_DATA_DIR: data, ZUMIBOT_INSTALL_DIR: '' }
      const r = spawnSync(
        'sh',
        [
          join(rel, 'install.sh'),
          '--origin',
          'https://c.example.com',
          '--dir',
          dir,
          '--tarball',
          tarball,
          '--no-service',
          '--snapshot-data'
        ],
        { encoding: 'utf8', env }
      )
      expect(r.status, r.stderr + r.stdout).toBe(0)

      const prev = join(dir, 'data.prev')
      expect(readFileSync(join(prev, 'chats/a.json'), 'utf8')).toBe('keep me')
      for (const left of ['browsers', 'browser-runtime', 'claude-tmp', 'control.sock', 'server.lock']) {
        expect(existsSync(join(prev, left)), left).toBe(false)
      }
      expect(readFileSync(join(prev, '.zumibot-from'), 'utf8').trim()).toBe('1.0.0')
      expect(existsSync(join(dir, 'data.prev.new'))).toBe(false)
      // The live data is untouched, and the old app is kept beside the new one.
      expect(existsSync(join(data, 'browsers/x'))).toBe(true)
      expect(existsSync(join(dir, 'app.prev'))).toBe(true)
      expect(readFileSync(join(dir, 'VERSION'), 'utf8').trim()).toBe('2.0.0')
      for (const f of ['Caddyfile', 'nginx-zumibot.conf']) {
        const out = readFileSync(join(dir, 'proxy', f), 'utf8')
        expect(out, f).toContain('c.example.com')
        expect(out, f).not.toContain('mhdaljuboori')
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
