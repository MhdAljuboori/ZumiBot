import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

const NONCE = 12
const TAG = 16
const KEY_BYTES = 32

export const newKey = (): Buffer => randomBytes(KEY_BYTES)

/** Names a key without revealing it, so a vault file can tell it was sealed by another one. */
// The app was named ClaudeBot when these labels were fixed. They stay: a vault sealed before the rename must still open.
export const keyIdOf = (key: Buffer): string => createHash('sha256').update('claudebot-vault-key-id').update(key).digest('hex').slice(0, 16)

// The id and time are bound in: an item moved to another id, or given another time, fails to open.
const aad = (id: string, updatedAt: number) => Buffer.from(`claudebot-vault:v1:${id}:${updatedAt}`)

/** base64(nonce | ciphertext | tag) of the JSON body. */
export function seal(key: Buffer, id: string, updatedAt: number, body: unknown): string {
  const nonce = randomBytes(NONCE)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(aad(id, updatedAt))
  const data = Buffer.concat([c.update(JSON.stringify(body), 'utf8'), c.final()])
  return Buffer.concat([nonce, data, c.getAuthTag()]).toString('base64')
}

/** Throws on a wrong key, id or time, or any changed byte. */
export function open(key: Buffer, id: string, updatedAt: number, sealed: string): unknown {
  const raw = Buffer.from(sealed, 'base64')
  if (raw.length < NONCE + TAG) throw new Error('sealed item too short')
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE))
  d.setAAD(aad(id, updatedAt))
  d.setAuthTag(raw.subarray(raw.length - TAG))
  const text = Buffer.concat([d.update(raw.subarray(NONCE, raw.length - TAG)), d.final()]).toString('utf8')
  return JSON.parse(text)
}

/** null when there is no key file; throws when it is not 32 bytes of base64. */
export async function readKey(path: string): Promise<Buffer | null> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const key = Buffer.from(text.trim(), 'base64')
  if (key.length !== KEY_BYTES || key.toString('base64') !== text.trim()) throw new Error('vault key file is not a valid key')
  return key
}

/** Exclusive create, so a key is never replaced: that would orphan everything sealed with it. */
export async function writeKey(path: string, key: Buffer): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const fh = await fs.open(path, 'wx', 0o600)
  try {
    await fh.writeFile(key.toString('base64') + '\n')
    // The key is the one thing that cannot be remade: a power cut must not leave the vault sealed under an empty file.
    await fh.sync()
  } catch (err) {
    // Only the file this call made (wx): an empty or partial key left behind would make every later save fail on EEXIST.
    await fh.close().catch(() => undefined)
    await fs.rm(path, { force: true }).catch(() => undefined)
    throw err
  }
  await fh.close()
}
