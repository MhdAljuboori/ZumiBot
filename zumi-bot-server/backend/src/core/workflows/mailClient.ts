import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { ImapFlow } from 'imapflow'
import PostalMime, { type Address } from 'postal-mime'
import { MAIL_TEXT_MAX, type EventBodies } from '@zumibot/shared/workflowEvents'
import { writeFileAtomic } from '../fsutil'
import type { MailClient, MailDeps, MailState } from './mailWatchers'

/** The part of ImapFlow a check uses, so the wrapper can be tested without a server. */
export type ImapLike = Pick<ImapFlow, 'mailboxOpen' | 'search' | 'fetch' | 'logout' | 'close'>

// Headers and the text come before attachments, so a cut message still parses to what the event carries; ten
// messages with large attachments would otherwise all sit in memory at once.
const SOURCE_MAX = 2_000_000

/** A MailClient over one signed-in connection, the folder opened read-only (EXAMINE), so nothing is marked read. */
export function imapClient(c: ImapLike, folder: string): MailClient {
  return {
    async open() {
      const box = await c.mailboxOpen(folder, { readOnly: true })
      if (typeof box.uidNext !== 'number') throw new Error("The mail server did not report the folder's next message number")
      return { uidValidity: String(box.uidValidity), uidNext: box.uidNext, exists: box.exists }
    },
    async fetchSince(uid, max) {
      const found = await c.search({ uid: `${uid + 1}:*` }, { uid: true })
      // `n:*` past the last UID still matches the last message, so the range alone is not enough.
      const want = (found || [])
        .filter((u) => u > uid)
        .sort((a, b) => a - b)
        .slice(0, max)
      if (!want.length) return []
      const out: { uid: number; source: Buffer }[] = []
      for await (const m of c.fetch(want, { uid: true, source: { maxLength: SOURCE_MAX } }, { uid: true })) {
        if (m.source) out.push({ uid: m.uid, source: m.source })
      }
      return out.sort((a, b) => a.uid - b.uid)
    },
    async close() {
      await c.logout().catch(() => c.close())
    }
  }
}

type ImapOptions = ConstructorParameters<typeof ImapFlow>[0]

/**
 * TLS from the first byte with the certificate checked (no `tls` override), and imapflow's logging off (its log would
 * carry the mailbox and the server's lines).
 */
export const imapOptions = (o: { host: string; port: number; user: string; password: string }): ImapOptions => ({
  host: o.host,
  port: o.port,
  secure: true,
  auth: { user: o.user, pass: o.password },
  logger: false,
  disableAutoIdle: true,
  connectionTimeout: 30_000,
  greetingTimeout: 30_000,
  socketTimeout: 60_000
})

/** Signs in with imapOptions and opens a MailClient on the folder. */
export async function connectImap(o: { host: string; port: number; user: string; password: string; folder: string }): Promise<MailClient> {
  const client = new ImapFlow(imapOptions(o))
  // An unheard 'error' event would end the process; every failure also rejects the command that was waiting.
  client.on('error', () => undefined)
  await client.connect()
  return imapClient(client, o.folder)
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

// indexOf, not a lazy regex: a message of unclosed `<style` openers would make `<style[\s\S]*?<\/style>` quadratic.
function dropBlocks(html: string, tag: string): string {
  const lower = html.toLowerCase()
  let out = ''
  let at = 0
  for (;;) {
    const start = lower.indexOf(`<${tag}`, at)
    if (start < 0) break
    out += html.slice(at, start)
    const end = lower.indexOf(`</${tag}`, start)
    const close = end < 0 ? -1 : lower.indexOf('>', end)
    at = close < 0 ? html.length : close + 1
  }
  return out + html.slice(at)
}

/** A text-only mail's stand-in: the HTML without style, script and tags, entities decoded, whitespace collapsed. */
export function htmlText(html: string): string {
  const s = dropBlocks(dropBlocks(html, 'style'), 'script')
    // `[^<>]*`, not `[^>]*`: a stray `<` must end the match, or a page of them makes the scan quadratic.
    .replace(/<\/?(br|p|div|li|tr|h[1-6])\b[^<>]*>/gi, '\n')
    .replace(/<[^<>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? all
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all
    })
  return s
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n')
}

const mailboxes = (list: Address[] | undefined): { name: string; address: string }[] =>
  (list ?? []).flatMap((a) => (a.group ? a.group : [a])).map((m) => ({ name: m.name ?? '', address: m.address ?? '' }))

/** The event body of one message (postal-mime); text cut to MAIL_TEXT_MAX. */
export async function parseMail(source: Buffer): Promise<EventBodies['email']> {
  const m = await PostalMime.parse(source)
  const text = m.text?.trim() ? m.text : m.html ? htmlText(m.html) : ''
  return {
    from: mailboxes(m.from ? [m.from] : [])[0] ?? { name: '', address: '' },
    to: mailboxes(m.to)
      .map((a) => a.address)
      .filter(Boolean)
      .join(', '),
    subject: m.subject ?? '',
    date: m.date ?? '',
    messageId: m.messageId ?? '',
    text: text.slice(0, MAIL_TEXT_MAX)
  }
}

const isEntry = (v: unknown): v is MailState[string] => {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.key === 'string' &&
    typeof e.uidValidity === 'string' &&
    typeof e.lastUid === 'number' &&
    Number.isInteger(e.lastUid) &&
    e.lastUid >= 0
  )
}

/** `workflow-mail.json`: a missing or broken file reads as empty (every trigger then starts over, firing nothing). */
export function mailStateFile(path: string): MailDeps['state'] {
  return {
    async read() {
      let raw: unknown
      try {
        raw = JSON.parse(await fs.readFile(path, 'utf8'))
      } catch {
        return {}
      }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
      const out: MailState = {}
      for (const [id, v] of Object.entries(raw)) if (isEntry(v)) out[id] = { key: v.key, uidValidity: v.uidValidity, lastUid: v.lastUid }
      return out
    },
    async write(s) {
      await fs.mkdir(dirname(path), { recursive: true })
      // 0600: the keys name the mail server and the user.
      await writeFileAtomic(path, JSON.stringify(s, null, 2), 0o600)
    }
  }
}
