// Vercel's ignoreCommand (vercel.json): exit 1 builds, exit 0 skips. Every deploy stores the whole release again, so
// a push that touches nothing the site is built from (most commits) is skipped. A deploy hook (a new release, or its
// installers attached) changes no file, so the release on GitHub is compared with the one the live site was built
// from (releases/fingerprint.txt). Anything unknown builds: a skipped build that was needed would leave servers on an
// old release, while an extra build only costs storage. The token is never printed.
import { execFileSync } from 'node:child_process'
import { FINGERPRINT_FILE, SITE_INPUTS, releaseFingerprint } from '../src/buildCheck.ts'
import { fetchLatestRelease } from '../src/latestRelease.ts'
import { SITE } from '../src/serverInstall.ts'

const build = (why) => {
  console.log(`shouldBuild: building (${why})`)
  process.exit(1)
}
const skip = (why) => {
  console.log(`shouldBuild: skipped (${why})`)
  process.exit(0)
}
const git = (args) => {
  try {
    execFileSync('git', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const prev = process.env.VERCEL_GIT_PREVIOUS_SHA
if (!prev) build('no previous deployment to compare with')
// Vercel's clone is shallow; a previous commit outside it cannot be compared.
if (!git(['cat-file', '-e', `${prev}^{commit}`])) build('previous commit not in the clone')
if (!git(['diff', '--quiet', prev, 'HEAD', '--', ...SITE_INPUTS])) build('site files changed')
// Only production serves the update channel; a preview with no file changes has nothing new to show.
if (process.env.VERCEL_ENV !== 'production') skip('no site files changed')

const token = process.env.GITHUB_TOKEN
if (!token) build('no GITHUB_TOKEN to compare releases with')
let want
try {
  want = releaseFingerprint(await fetchLatestRelease(token))
} catch (err) {
  build(`release check failed: ${err instanceof Error ? err.message : 'error'}`)
}
let live = ''
try {
  const res = await fetch(`${SITE}/releases/${FINGERPRINT_FILE}`, { signal: AbortSignal.timeout(15_000), cache: 'no-store' })
  // A 404 is a live site from before fingerprints, or one with no release: compare as empty, so it builds.
  if (res.ok) live = (await res.text()).trim()
} catch {
  build('live site did not answer')
}
if (live !== want) build('the release changed')
skip('no site files or release changed')
