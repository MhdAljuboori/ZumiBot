// Signs a packaged release (see docs/architecture/updates.md). Run by the release workflow's publish job:
//
//   RELEASE_SIGNING_KEY="$(cat key.pem)" node --experimental-strip-types zumi-bot-server/deploy/release-sign.mjs <version> <release-dir>
//
// Reads <release-dir>/zumibot-server.tar.gz and zumibot-docker.tar.gz with their SHA256SUMS, signs
// releaseSignedText(version, sha256) and dockerBundleSignedText(version, sha256) with the ed25519 key in
// RELEASE_SIGNING_KEY (PKCS8 PEM), and writes each base64 signature next to its file as <name>.sig.
// The key comes from the environment, not argv, so it is never in a process listing; it is never printed.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOCKER_BUNDLE } from '../shared/src/dockerBundle.ts'
import { RELEASE_PUBLIC_KEY, dockerBundleSignedText, releaseSignedText } from '../shared/src/update.ts'

const TARBALL = 'zumibot-server.tar.gz'
const die = (msg) => {
  console.error(`release-sign: ${msg}`)
  process.exit(1)
}

const [version, dir] = process.argv.slice(2)
if (!version || !dir) die('usage: release-sign.mjs <version> <release-dir>')
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`${version} is not a plain x.y.z`)
const pem = process.env.RELEASE_SIGNING_KEY
if (!pem) die('RELEASE_SIGNING_KEY is not set')

let key
try {
  key = createPrivateKey(pem)
} catch {
  die('RELEASE_SIGNING_KEY is not a PEM private key')
}
if (key.asymmetricKeyType !== 'ed25519') die('RELEASE_SIGNING_KEY is not an ed25519 key')
// A secret that is not the pinned key's pair would publish a release no server accepts: stop here instead.
const pub = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
if (pub !== RELEASE_PUBLIC_KEY) die('RELEASE_SIGNING_KEY does not match RELEASE_PUBLIC_KEY in shared/src/update.ts')

const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8')
  .split('\n')
  .map((l) => /^([0-9a-f]{64}) [ *](.+)$/.exec(l.trim()))
// Both files are checked before either is signed, so a bad one leaves no signature behind.
const toSign = []
for (const [name, signedText] of [
  [TARBALL, releaseSignedText],
  [DOCKER_BUNDLE, dockerBundleSignedText]
]) {
  let bytes
  try {
    bytes = readFileSync(join(dir, name))
  } catch {
    die(`${name} is missing from ${dir}`)
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const listed = sums.find((m) => m && m[2] === name)
  if (!listed || listed[1] !== sha256) die(`SHA256SUMS does not match ${name}`)
  toSign.push({ name, sha256, message: Buffer.from(signedText(version, sha256), 'utf8') })
}

for (const { name, sha256, message } of toSign) {
  const signature = sign(null, message, key)
  if (!verify(null, message, createPublicKey(key), signature)) die('the signature did not verify')
  writeFileSync(join(dir, `${name}.sig`), `${signature.toString('base64')}\n`)
  console.log(`release-sign: signed ${name} ${version} (${sha256})`)
}
