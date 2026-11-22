// Makes the ed25519 key pair that signs releases (see docs/architecture/updates.md):
//
//   node zumi-bot-server/deploy/release-key.mjs <private-key.pem>
//
// Writes the private key as PKCS8 PEM with mode 0600 and prints only the public key, as the raw 32 bytes in base64:
// the format of RELEASE_PUBLIC_KEY in zumi-bot-server/shared/src/update.ts and in deploy/install.sh. The PEM's
// contents go into the GitHub secret RELEASE_SIGNING_KEY. The private key is never printed.
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'))

const die = (msg) => {
  console.error(`release-key: ${msg}`)
  process.exit(1)
}

const target = process.argv[2]
if (!target || process.argv.length > 3) die('usage: node release-key.mjs <private-key.pem>')
const out = resolve(target)
if (!existsSync(dirname(out))) die(`${dirname(out)} does not exist; make it first (mode 0700)`)
// Through symlinks, so a link from outside cannot put the key in the working tree, where a commit would publish it.
const inRepo = (p) => {
  const rel = relative(repo, p)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}
if (inRepo(realpathSync(dirname(out)))) die('refusing a path inside the repository')

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
try {
  // 'wx' refuses an existing file: overwriting would lose the key every installed server trusts.
  writeFileSync(out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' })
} catch (err) {
  die(err?.code === 'EEXIST' ? `${out} already exists; refusing to overwrite it` : `could not write ${out} (${err?.code ?? 'error'})`)
}
// The last 32 bytes of the SPKI DER are the raw key.
const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
console.log(raw.toString('base64'))
