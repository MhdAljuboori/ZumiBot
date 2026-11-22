import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// The vault format of backend/src/core/vault/vaultCrypto.ts, for the sync tool, which runs as plain Node (and from the
// desktop's resources/sync) and cannot import the server's TypeScript. backend/tests/core/vaultCrypto.test.ts checks
// that both seal and open each other's items. Nothing here logs, and no error carries key or item text.

const NONCE = 12
const TAG = 16
const KEY_BYTES = 32

// The app was named ClaudeBot when these labels were fixed. They stay: a vault sealed before the rename must still open.
export const keyIdOf = (key) => createHash('sha256').update('claudebot-vault-key-id').update(key).digest('hex').slice(0, 16)

const aad = (id, updatedAt) => Buffer.from(`claudebot-vault:v1:${id}:${updatedAt}`)

/** base64(nonce | ciphertext | tag) of the JSON body, bound to the item's id and time. */
export function sealItem(key, id, updatedAt, body) {
  const nonce = randomBytes(NONCE)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(aad(id, updatedAt))
  const data = Buffer.concat([c.update(JSON.stringify(body), 'utf8'), c.final()])
  return Buffer.concat([nonce, data, c.getAuthTag()]).toString('base64')
}

/** The item's body, or null for a tombstone. Throws on a wrong key, id or time, or any changed byte. */
export function openItem(key, item) {
  if (item.deleted) return null
  try {
    const raw = Buffer.from(item.sealed, 'base64')
    if (raw.length < NONCE + TAG) throw new Error('short')
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE))
    d.setAAD(aad(item.id, item.updatedAt))
    d.setAuthTag(raw.subarray(raw.length - TAG))
    return JSON.parse(Buffer.concat([d.update(raw.subarray(NONCE, raw.length - TAG)), d.final()]).toString('utf8'))
  } catch {
    // Never the cause: a JSON error quotes the text it failed on, which would be the opened item.
    throw new Error('A vault item does not open with this key.')
  }
}

/** The key in a vault.key file's text; throws unless it is exactly 32 bytes of base64, like the server's readKey. */
export function keyFromText(text) {
  const t = String(text).trim()
  const key = Buffer.from(t, 'base64')
  if (key.length !== KEY_BYTES || key.toString('base64') !== t) throw new Error('Not a valid vault key.')
  return key
}

const isRaw = (r) => {
  if (typeof r !== 'object' || r === null) return false
  if (typeof r.id !== 'string' || typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return false
  return r.deleted === true ? r.sealed === null : r.deleted === false && typeof r.sealed === 'string'
}

/** vault.json's text as the server would accept it; throws on anything else (the server reads that as keyMismatch). */
export function parseVaultFile(text) {
  let f
  try {
    f = JSON.parse(text)
  } catch {
    throw new Error('Not a vault file.')
  }
  if (typeof f !== 'object' || f === null || f.v !== 1 || typeof f.keyId !== 'string' || !Array.isArray(f.items) || !f.items.every(isRaw))
    throw new Error('Not a vault file.')
  if (new Set(f.items.map((i) => i.id)).size !== f.items.length) throw new Error('Not a vault file.')
  return f
}

const hasLive = (file) => !!file && file.items.some((i) => !i.deleted)
const copyItem = (i) => ({ id: i.id, updatedAt: i.updatedAt, deleted: i.deleted, sealed: i.sealed })

// The later updatedAt wins; on a tie the tombstone, so a delete made on either side stays deleted; then the VPS.
function winner(local, vps) {
  if (local.updatedAt !== vps.updatedAt) return local.updatedAt > vps.updatedAt ? local : vps
  if (local.deleted !== vps.deleted) return local.deleted ? local : vps
  return vps
}

/**
 * Joins two vault files by item id, tombstones kept (sync never deletes, and a pruned item would come back).
 * Only ids and times are compared, so no key is needed; callers only join files sealed under one key.
 */
export function mergeVault(local, vps) {
  if (!local && !vps) return null
  const byId = new Map()
  for (const i of local?.items ?? []) byId.set(i.id, i)
  for (const i of vps?.items ?? []) byId.set(i.id, byId.has(i.id) ? winner(byId.get(i.id), i) : i)
  // A side with only tombstones holds nothing sealed, so its key id says nothing about the items.
  const keyId = hasLive(vps) ? vps.keyId : hasLive(local) ? local.keyId : (vps ?? local).keyId
  return { v: 1, keyId, items: [...byId.values()].map(copyItem) }
}

// An opened body must name the record it came from, as the server's VaultStore checks.
function openChecked(key, item) {
  const body = openItem(key, item)
  if (typeof body !== 'object' || body === null || body.id !== item.id || body.updatedAt !== item.updatedAt)
    throw new Error('A vault item does not match its record.')
  return body
}

/** Whether every live item of the file is sealed with this key: the file's key id, and each item opens and names its own record. */
export function opensWith(key, file) {
  if (file.keyId !== keyIdOf(key)) return false
  try {
    for (const i of file.items) if (!i.deleted) openChecked(key, i)
  } catch {
    return false
  }
  return true
}

const at = (path) => (path ? ` at ${path}` : '')
// A missing key names where it was looked for and the setting that moves it: a key kept elsewhere reads as none.
const SIDES = {
  local: {
    own: "This PC's",
    in: "this PC's",
    noKey: (path) =>
      `This PC has vault items but no vault key${at(path)}. Put the key file back, or set ZUMIBOT_VAULT_KEY_FILE (or XDG_CONFIG_HOME) for the sync as the local server has it.`
  },
  vps: {
    own: "The VPS's",
    in: "the VPS's",
    noKey: (path) =>
      `The VPS has vault items but no vault key${at(path)}. If the VPS server keeps its key elsewhere (ZUMIBOT_VAULT_KEY_FILE in its service), set VPS_VAULT_KEY_FILE to that path.`
  }
}

// The side's vault as the server there would load it: null when fine, else why it is keyMissing or keyMismatch.
function sideProblem(key, file, side, keyFile) {
  if (!hasLive(file)) return null
  const s = SIDES[side]
  if (!key) return s.noKey(keyFile)
  if (file.keyId !== keyIdOf(key)) return `${s.own} vault.json was sealed with a different key than its vault key.`
  try {
    for (const i of file.items) if (!i.deleted) openChecked(key, i)
  } catch {
    return `An item in ${s.in} vault does not open with its key.`
  }
  return null
}

/**
 * What the sync does with the two keys (each side's key file path only names it in a refusal). Every action but refuse then joins the files.
 * none: no key on either side. pullKey / pushKey: only one side has a key. merge: the same key on both.
 * reseal: different keys, the VPS's wins. refuse: a side's vault does not match its own key; nothing sealed under
 * different keys is ever joined, so both vaults are left alone.
 */
export function planVaultKeys({ localKey, vpsKey, localFile, vpsFile, localKeyFile, vpsKeyFile }) {
  const reason = sideProblem(localKey, localFile, 'local', localKeyFile) ?? sideProblem(vpsKey, vpsFile, 'vps', vpsKeyFile)
  if (reason) return { action: 'refuse', reason }
  if (!localKey && !vpsKey) return { action: 'none' }
  if (!localKey) return { action: 'pullKey' }
  if (!vpsKey) return { action: 'pushKey' }
  return { action: localKey.equals(vpsKey) ? 'merge' : 'reseal' }
}

/** Each live item opened with fromKey and sealed again with toKey, same id and time. Throws, returning nothing, if any fails. */
export function resealFile(file, fromKey, toKey) {
  if (hasLive(file) && file.keyId !== keyIdOf(fromKey)) throw new Error('The vault file was sealed with another key.')
  const items = file.items.map((i) =>
    i.deleted ? copyItem(i) : { ...copyItem(i), sealed: sealItem(toKey, i.id, i.updatedAt, openChecked(fromKey, i)) }
  )
  return { v: 1, keyId: keyIdOf(toKey), items }
}
