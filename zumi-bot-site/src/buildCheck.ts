// Pure parts of scripts/shouldBuild.mjs (Vercel's ignoreCommand) and the fingerprint scripts/fetchRelease.mjs
// publishes, kept here so tests can check them. Every deploy carries the whole release (hundreds of MB of installers),
// so a push that changes nothing the site is built from must not make a new one.
import { createHash } from 'node:crypto'
import type { LatestRelease } from './latestRelease.ts'

// What the built site is made from, relative to zumi-bot-site/. The shared package is left out on purpose: the site
// imports only types from it, which the build erases. A value import from outside this folder must be added here.
export const SITE_INPUTS = ['.', '../zumi-bot-server/frontend/src/botShapes.ts', '../package.json', '../package-lock.json']

// Published at releases/fingerprint.txt. It names which release and which of its assets the deploy was built from, so
// the deploy hooks (a new release, then its installers attached) still build when no file changed. The asset URL
// holds GitHub's asset id, so a re-uploaded asset changes it too. A hash, so no asset list reaches the site.
export const FINGERPRINT_FILE = 'fingerprint.txt'

export function releaseFingerprint(rel: LatestRelease | null): string {
  const lines = rel ? [rel.info.version, ...rel.assets.map((a) => `${a.name} ${a.url}`).sort()] : ['none']
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}
