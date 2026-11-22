// Packs the Docker install bundle of a release (see docs/architecture/install.md). Run by the release workflow's
// publish job, before release-sign.mjs:
//
//   node --experimental-strip-types zumi-bot-server/deploy/docker-bundle.mjs <version> <image-ref> <release-dir>
//
// <image-ref> is the pushed image pinned by digest (docker.io/mhdaljuboori/zumibot:<version>@sha256:<64 hex>). Writes
// <release-dir>/zumibot-docker.tar.gz (the compose file with that image, the Caddyfiles, install.sh, .env.example,
// VERSION) and sets its line in <release-dir>/SHA256SUMS, keeping the other lines. Node built-ins only: the publish
// job installs nothing.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOCKER_BUNDLE, DOCKER_BUNDLE_DIR, DOCKER_BUNDLE_FILES, DOCKER_IMAGE, bundleCompose, isBundleImage } from '../shared/src/dockerBundle.ts'

const die = (msg) => {
  console.error(`docker-bundle: ${msg}`)
  process.exit(1)
}

const [version, image, dir] = process.argv.slice(2)
if (!version || !image || !dir) die('usage: docker-bundle.mjs <version> <image-ref> <release-dir>')
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`${version} is not a plain x.y.z`)
// A tag can move, so the bundle only ever names this version's image by digest.
if (!isBundleImage(image, version)) die(`${image} is not ${DOCKER_IMAGE}:${version}@sha256:<64 hex>`)

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const work = mkdtempSync(join(tmpdir(), 'zumibot-docker-bundle.'))
try {
  const stage = join(work, DOCKER_BUNDLE_DIR)
  mkdirSync(join(stage, 'docker'), { recursive: true })
  for (const file of DOCKER_BUNDLE_FILES) {
    const to = join(stage, file)
    if (file === 'VERSION') writeFileSync(to, `${version}\n`)
    else if (file === 'docker-compose.yml') {
      let text
      try {
        text = bundleCompose(readFileSync(join(root, file), 'utf8'), image)
      } catch (e) {
        die(e.message)
      }
      writeFileSync(to, text)
    } else {
      if (!existsSync(join(root, file))) die(`${file} is missing from the repo`)
      copyFileSync(join(root, file), to)
    }
    // Fixed modes, so the same inputs pack to the same bytes whatever the checkout's umask was.
    chmodSync(to, file === 'docker/install.sh' ? 0o755 : 0o644)
  }
  chmodSync(join(stage, 'docker'), 0o755)
  chmodSync(stage, 0o755)

  mkdirSync(dir, { recursive: true })
  const archive = join(dir, DOCKER_BUNDLE)
  // Reproducible where tar supports it (same flags as package.sh), so the same release packs to the same bytes.
  const gnu = spawnSync('tar', ['--sort=name', '--help'], { stdio: 'ignore' }).status === 0
  const flags = gnu ? ['--sort=name', '--mtime=UTC 2020-01-01', '--owner=0', '--group=0', '--numeric-owner'] : []
  const tar = spawnSync('tar', [...flags, '-czf', archive, '-C', work, DOCKER_BUNDLE_DIR], { stdio: 'inherit' })
  if (tar.status !== 0) {
    rmSync(archive, { force: true })
    die('tar failed')
  }

  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
  const sums = join(dir, 'SHA256SUMS')
  // Other releases' lines stay; a line for this bundle (a re-run) is replaced.
  const kept = (existsSync(sums) ? readFileSync(sums, 'utf8') : '')
    .split('\n')
    .filter((l) => l.trim() && /^[0-9a-f]{64} [ *](.+)$/.exec(l.trim())?.[1] !== DOCKER_BUNDLE)
  writeFileSync(sums, `${[...kept, `${sha256}  ${DOCKER_BUNDLE}`].join('\n')}\n`)
  console.log(`docker-bundle: packed ${DOCKER_BUNDLE} ${version} (${sha256})`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
