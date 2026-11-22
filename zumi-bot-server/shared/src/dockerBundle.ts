// The Docker bundle a release ships: a compose file pinned to the image by digest, plus the files it mounts and the
// installer. No imports on purpose: deploy/*.mjs runs this with `node --experimental-strip-types` and no node_modules.
export const DOCKER_IMAGE = 'docker.io/mhdaljuboori/zumibot'
export const DOCKER_BUNDLE = 'zumibot-docker.tar.gz'
export const DOCKER_BUNDLE_DIR = 'zumibot-docker'
export const DOCKER_BUNDLE_FILES: readonly string[] = [
  'docker-compose.yml',
  'docker/Caddyfile',
  'docker/Caddyfile.local',
  'docker/install.sh',
  '.env.example',
  'VERSION',
]

/** Only this version's image, by digest: a tag can move, so the installer refuses a ref without one. */
export function isBundleImage(ref: string, version: string): boolean {
  const prefix = `${DOCKER_IMAGE}:${version}@sha256:`
  return ref.startsWith(prefix) && /^[0-9a-f]{64}$/.test(ref.slice(prefix.length))
}

/**
 * The repo's compose file with its source build swapped for the released image. Plain text, no YAML library (the
 * publish job installs nothing), so it throws on any shape it does not know rather than ship a wrong file.
 */
export function bundleCompose(compose: string, image: string): string {
  const lines = compose.split('\n')
  const builds = lines.flatMap((l, i) => (l === '  build:' ? [i] : []))
  if (builds.length !== 1) throw new Error(`docker-compose.yml: expected one "  build:" line, found ${builds.length}`)
  const images = lines.flatMap((l, i) => (l.startsWith('  image: zumibot:') ? [i] : []))
  if (images.length !== 1) throw new Error(`docker-compose.yml: expected one "  image: zumibot:" line, found ${images.length}`)
  const buildAt = builds[0]!
  let buildEnd = buildAt + 1
  while (buildEnd < lines.length && /^ {3,}/.test(lines[buildEnd]!)) buildEnd++ // the block's own, deeper-indented lines
  const imageAt = images[0]!
  const out: string[] = []
  lines.forEach((line, i) => {
    if (i >= buildAt && i < buildEnd) return
    if (i === imageAt) {
      out.push('  # Pinned by digest when this release was published. The installer replaces this file on every update, so do not edit it.')
      out.push(`  image: ${image}`)
      return
    }
    out.push(line)
  })
  return out.join('\n')
}
