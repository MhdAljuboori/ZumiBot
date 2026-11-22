// Runs before every build (npm prebuild). Writes src/release.json (the latest release as ReleaseInfo, or null) for the
// page, and re-publishes that release under public/releases/ for servers to update from, with no token:
//   releases/latest.json                     the manifest the updater reads (publishRelease.ts)
//   releases/<x.y.z>/{zumibot-server.tar.gz,SHA256SUMS,zumibot-server.tar.gz.sig}  the package it downloads
//   releases/latest/{zumibot-server.tar.gz,SHA256SUMS,zumibot-server.tar.gz.sig,install.sh}  stable names for install.sh
//   releases/<x.y.z>/{zumibot-docker.tar.gz,zumibot-docker.tar.gz.sig}  the Docker bundle docker/install.sh downloads
//   releases/latest/docker/install.sh        the Docker installer, taken out of that bundle (first install by URL)
//   releases/<x.y.z>/{SHA256SUMS-desktop,<each installer it lists>}  the desktop installers the page offers
//   releases/fingerprint.txt                 which release this deploy holds, for scripts/shouldBuild.mjs
// The Docker bundle is optional too: a release from before it existed has none and is published without it (the
// installer then says so). One that is present but not listed in SHA256SUMS, or not matching it, fails the build.
// Installers are optional: a release without SHA256SUMS-desktop (electron-build.yml uploads it after them, and a site
// build can start before that) is published without them, and a listed file that is missing is skipped with a
// warning, so a slow or failed desktop build never holds back the update channel. One that does not match its hash
// fails the build. They live under the version only, since each is large and the page links to that folder.
// The signature is the publisher's (release.yml signs every release); it is carried, not trusted, here: servers and
// install.sh check it against their pinned key, so this site cannot change what they run. A release without one is
// still published, and every server refuses it.
// No GITHUB_TOKEN: writes null, publishes nothing and exits 0, so a local build works. A token that fails anywhere:
// exits 1 and leaves the old files, so a bad deploy never replaces a good one. The token is never printed.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadAsset, fetchLatestRelease } from '../src/latestRelease.ts'
import { DOCKER_BUNDLE, DOCKER_INSTALLER, DOCKER_SIG, SIG, SUMS, TARBALL, manifestFor, signatureOf, sumOf } from '../src/publishRelease.ts'
import { INSTALLER_SUMS, installersIn } from '../src/downloads.ts'
import { FINGERPRINT_FILE, releaseFingerprint } from '../src/buildCheck.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'src', 'release.json')
const pub = join(root, 'public', 'releases')
const token = process.env.GITHUB_TOKEN

// Streamed: an installer is far bigger than the server tarball.
const sha256File = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

try {
  const rel = await fetchLatestRelease(token)
  // Built next to the real folder and swapped in at the end, so a failure leaves the last published files alone.
  const next = `${pub}.next`
  rmSync(next, { recursive: true, force: true })
  const downloads = []
  if (rel) {
    const asset = (name) => {
      const a = rel.assets.find((x) => x.name === name)
      if (!a) throw new Error(`the release has no ${name}`)
      return a
    }
    const vdir = join(next, rel.info.version)
    mkdirSync(vdir, { recursive: true })
    await downloadAsset(asset(TARBALL), token, join(vdir, TARBALL))
    await downloadAsset(asset(SUMS), token, join(vdir, SUMS))
    const want = sumOf(readFileSync(join(vdir, SUMS), 'utf8'), TARBALL)
    if (!want) throw new Error(`${SUMS} does not list ${TARBALL}`)
    const got = createHash('sha256')
      .update(readFileSync(join(vdir, TARBALL)))
      .digest('hex')
    if (got !== want) throw new Error(`${TARBALL} does not match ${SUMS}`)
    let signature
    if (rel.assets.some((x) => x.name === SIG)) {
      await downloadAsset(asset(SIG), token, join(vdir, SIG))
      signature = signatureOf(readFileSync(join(vdir, SIG), 'utf8'))
      if (!signature) throw new Error(`${SIG} is not a signature`)
    } else {
      console.warn(`fetchRelease: v${rel.info.version} has no ${SIG}; servers will refuse it`)
    }
    const latest = join(next, 'latest')
    mkdirSync(latest)
    copyFileSync(join(vdir, TARBALL), join(latest, TARBALL))
    copyFileSync(join(vdir, SUMS), join(latest, SUMS))
    if (signature) copyFileSync(join(vdir, SIG), join(latest, SIG))
    // The installer that matches this package, for a first install by URL.
    writeFileSync(join(latest, 'install.sh'), execFileSync('tar', ['-xzOf', join(vdir, TARBALL), 'zumibot-server/install.sh']))
    writeFileSync(join(next, 'latest.json'), `${JSON.stringify(manifestFor(rel.info, got, signature))}\n`)
    if (rel.assets.some((x) => x.name === DOCKER_BUNDLE)) {
      await downloadAsset(asset(DOCKER_BUNDLE), token, join(vdir, DOCKER_BUNDLE))
      const dockerWant = sumOf(readFileSync(join(vdir, SUMS), 'utf8'), DOCKER_BUNDLE)
      if (!dockerWant) throw new Error(`${SUMS} does not list ${DOCKER_BUNDLE}`)
      if ((await sha256File(join(vdir, DOCKER_BUNDLE))) !== dockerWant) throw new Error(`${DOCKER_BUNDLE} does not match ${SUMS}`)
      if (rel.assets.some((x) => x.name === DOCKER_SIG)) {
        await downloadAsset(asset(DOCKER_SIG), token, join(vdir, DOCKER_SIG))
        if (!signatureOf(readFileSync(join(vdir, DOCKER_SIG), 'utf8'))) throw new Error(`${DOCKER_SIG} is not a signature`)
      } else {
        console.warn(`fetchRelease: v${rel.info.version} has no ${DOCKER_SIG}; the Docker installer will refuse it`)
      }
      // The installer that matches this bundle, for a first install by URL.
      mkdirSync(join(latest, 'docker'))
      writeFileSync(join(latest, 'docker', 'install.sh'), execFileSync('tar', ['-xzOf', join(vdir, DOCKER_BUNDLE), DOCKER_INSTALLER]))
    } else {
      console.warn(`fetchRelease: v${rel.info.version} has no ${DOCKER_BUNDLE}; publishing it without a Docker bundle`)
    }
    if (rel.assets.some((x) => x.name === INSTALLER_SUMS)) {
      await downloadAsset(asset(INSTALLER_SUMS), token, join(vdir, INSTALLER_SUMS))
      for (const { file, sha256 } of installersIn(readFileSync(join(vdir, INSTALLER_SUMS), 'utf8'))) {
        const a = rel.assets.find((x) => x.name === file)
        if (!a) {
          console.warn(`fetchRelease: ${INSTALLER_SUMS} lists ${file}, which the release does not have; skipped`)
          continue
        }
        await downloadAsset(a, token, join(vdir, file))
        if ((await sha256File(join(vdir, file))) !== sha256) throw new Error(`${file} does not match ${INSTALLER_SUMS}`)
        downloads.push({ file, size: statSync(join(vdir, file)).size })
      }
    } else {
      console.warn(`fetchRelease: v${rel.info.version} has no ${INSTALLER_SUMS} yet; publishing it without installers`)
    }
  }
  mkdirSync(dirname(out), { recursive: true })
  // The page's copy: version, date, notes and the installers' names and sizes. Never a GitHub URL.
  writeFileSync(out, `${JSON.stringify(rel ? { ...rel.info, downloads } : null)}\n`)
  rmSync(pub, { recursive: true, force: true })
  if (rel) renameSync(next, pub)
  // What scripts/shouldBuild.mjs compares the next build's release with. Written with no release too, so a site
  // without one does not rebuild on every push; not without a token (a local build compared nothing).
  if (token) {
    mkdirSync(pub, { recursive: true })
    writeFileSync(join(pub, FINGERPRINT_FILE), `${releaseFingerprint(rel)}\n`)
  }
  console.log(rel ? `fetchRelease: published v${rel.info.version} with ${downloads.length} installer(s)` : `fetchRelease: wrote null (${token ? 'no release yet' : 'no token'})`)
} catch (err) {
  console.error(`fetchRelease: ${err instanceof Error ? err.message : 'failed'}`)
  process.exit(1)
}
