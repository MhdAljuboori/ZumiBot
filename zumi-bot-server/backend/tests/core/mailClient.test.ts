import { promises as fs } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAIL_TEXT_MAX } from '@zumibot/shared/workflowEvents'
import {
  connectImap,
  htmlText,
  imapClient,
  imapOptions,
  mailStateFile,
  parseMail,
  type ImapLike
} from '../../src/core/workflows/mailClient'
import { checkMailbox } from '../../src/core/workflows/mailWatchers'

const mail = (headers: string, body: string, type = 'text/plain; charset=utf-8'): Buffer =>
  Buffer.from(`${headers}\r\nMIME-Version: 1.0\r\nContent-Type: ${type}\r\n\r\n${body}\r\n`)

describe('parseMail', () => {
  it('reads the sender, recipients, subject, date, id and text', async () => {
    const body = await parseMail(
      mail(
        'From: "Ann Example" <ann@example.com>\r\nTo: me@example.com, Bob <bob@example.com>\r\nSubject: =?UTF-8?Q?Invoice_=E2=82=AC5?=\r\n' +
          'Date: Fri, 13 Nov 2026 09:30:00 +0000\r\nMessage-ID: <abc@example.com>',
        'Hello,\r\nthe invoice is attached.'
      )
    )
    expect(body).toEqual({
      from: { name: 'Ann Example', address: 'ann@example.com' },
      to: 'me@example.com, bob@example.com',
      subject: 'Invoice €5',
      date: '2026-11-13T09:30:00.000Z',
      messageId: '<abc@example.com>',
      text: 'Hello,\nthe invoice is attached.\n'
    })
  })

  it('leaves missing headers empty and takes group members as recipients', async () => {
    const body = await parseMail(mail('To: Team: a@example.com, b@example.com;', 'x'))
    expect(body).toMatchObject({
      from: { name: '', address: '' },
      to: 'a@example.com, b@example.com',
      subject: '',
      date: '',
      messageId: ''
    })
  })

  it('uses the HTML without tags when there is no text part', async () => {
    const html =
      '<html><head><style>p { color: red }</style><script>alert(1)</script></head><body><p>Hi&nbsp;Ann,</p>\r\n<div>Total:   <b>5 &amp; 6</b></div><br>Bye</body></html>'
    const body = await parseMail(mail('From: a@example.com', html, 'text/html; charset=utf-8'))
    expect(body.text).toBe('Hi Ann,\nTotal: 5 & 6\nBye')
  })

  it(`cuts the text to ${MAIL_TEXT_MAX} characters`, async () => {
    const body = await parseMail(mail('From: a@example.com', 'x'.repeat(MAIL_TEXT_MAX + 500)))
    expect(body.text).toHaveLength(MAIL_TEXT_MAX)
  })
})

describe('htmlText', () => {
  it('drops style and script blocks, tags and entities, keeping line breaks', () => {
    expect(htmlText('<STYLE>x</STYLE>a<br/>b<p>c</p>d &lt;e&gt; &#39;f&#x27; &quot;g&quot;')).toBe('a\nb\nc\nd <e> \'f\' "g"')
  })

  it('stays fast on a page of stray brackets and unclosed blocks', () => {
    const start = Date.now()
    htmlText('<'.repeat(200_000) + '<style'.repeat(50_000) + '<script'.repeat(50_000))
    expect(Date.now() - start).toBeLessThan(2_000)
  })
})

describe('mailStateFile', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-mail-state-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reads nothing from a missing or broken file, writes 0600 and reads back what it wrote', async () => {
    const path = join(dir, 'workflow-mail.json')
    const f = mailStateFile(path)
    expect(await f.read()).toEqual({})
    const s = { a: { key: 'h|u|INBOX', uidValidity: '7', lastUid: 41 } }
    await f.write(s)
    expect(await f.read()).toEqual(s)
    if (process.platform !== 'win32') expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
    await fs.writeFile(path, '{not json')
    expect(await f.read()).toEqual({})
    await fs.writeFile(path, JSON.stringify({ a: s.a, b: { key: 1 }, c: null, d: { key: 'k', uidValidity: '1', lastUid: -1 } }))
    expect(await f.read()).toEqual({ a: s.a })
  })
})

describe('imapClient', () => {
  let calls: string[]
  let fake: ImapLike
  beforeEach(() => {
    calls = []
    fake = {
      mailboxOpen: async (path: string, o?: { readOnly?: boolean }) => {
        calls.push(`open ${path} ${o?.readOnly}`)
        return { uidValidity: 123456789012n, uidNext: 50, exists: 7 }
      },
      // `n:*` past the last UID still matches the last message, as a real server answers.
      search: async (q: { uid?: string }) => {
        calls.push(`search ${q.uid}`)
        return [49, 12, 47, 48]
      },
      fetch: async function* (range: number[], q: { source?: unknown }) {
        calls.push(`fetch ${range.join(',')} ${JSON.stringify(q.source)}`)
        for (const uid of [...range].reverse()) yield { uid, source: Buffer.from(`m${uid}`) }
      },
      logout: async () => {
        calls.push('logout')
      },
      close: () => {
        calls.push('close')
      }
    } as unknown as ImapLike
  })

  it('opens the folder read-only and reports its UIDVALIDITY as text', async () => {
    expect(await imapClient(fake, 'Work').open()).toEqual({ uidValidity: '123456789012', uidNext: 50, exists: 7 })
    expect(calls).toEqual(['open Work true'])
  })

  it('fetches only UIDs past the one given, oldest first, at most max, each source capped', async () => {
    const got = await imapClient(fake, 'INBOX').fetchSince(46, 2)
    expect(got.map((m) => m.uid)).toEqual([47, 48])
    expect(got[0]?.source.toString()).toBe('m47')
    expect(calls[0]).toBe('search 47:*')
    expect(calls[1]).toMatch(/^fetch 47,48 \{"maxLength":\d+\}$/)
  })

  it('fetches nothing when no UID is past the one given', async () => {
    expect(await imapClient(fake, 'INBOX').fetchSince(49, 10)).toEqual([])
    expect(calls).toEqual(['search 50:*'])
  })

  it('logs out, and closes the socket when the logout fails', async () => {
    await imapClient(fake, 'INBOX').close()
    expect(calls).toEqual(['logout'])
    calls = []
    fake.logout = async () => {
      calls.push('logout')
      throw new Error('gone')
    }
    await imapClient(fake, 'INBOX').close()
    expect(calls).toEqual(['logout', 'close'])
  })
})

describe('imapClient over imapflow', () => {
  // A plaintext stand-in for a server (connectImap itself always uses TLS): just the lines a check sends.
  const MSGS: Record<number, string> = {
    101: 'From: a@x.io\r\nSubject: one\r\n\r\nbody one\r\n',
    102: 'From: b@x.io\r\nSubject: two\r\n\r\nbody two\r\n',
    103: 'From: c@x.io\r\nSubject: three\r\n\r\nbody three\r\n'
  }
  const serve = (seen: string[]) =>
    createServer((s: Socket) => {
      s.write('* OK [CAPABILITY IMAP4rev1] ready\r\n')
      let buf = ''
      s.on('data', (chunk) => {
        buf += chunk.toString()
        for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 2)
          seen.push(line)
          const [tag, ...rest] = line.split(' ')
          const cmd = rest.join(' ').toUpperCase()
          if (cmd.startsWith('EXAMINE'))
            s.write(`* 3 EXISTS\r\n* OK [UIDVALIDITY 777] ok\r\n* OK [UIDNEXT 104] ok\r\n${tag} OK [READ-ONLY] done\r\n`)
          else if (cmd.startsWith('UID SEARCH')) s.write(`* SEARCH 101 102 103\r\n${tag} OK done\r\n`)
          else if (cmd.startsWith('UID FETCH')) {
            const uids = rest[2]!.split(',').flatMap((p) => {
              const [a, b] = p.split(':').map(Number)
              return Array.from({ length: (b ?? a!) - a! + 1 }, (_, k) => a! + k)
            })
            for (const u of uids) s.write(`* ${u - 100} FETCH (UID ${u} BODY[]<0> {${Buffer.byteLength(MSGS[u]!)}}\r\n${MSGS[u]})\r\n`)
            s.write(`${tag} OK done\r\n`)
          } else if (cmd.startsWith('LOGOUT')) {
            s.write(`* BYE bye\r\n${tag} OK done\r\n`)
            s.end()
          } else s.write(`${tag} OK done\r\n`)
        }
      })
    })

  it('examines the folder, searches past the UID and fetches capped sources', async () => {
    const seen: string[] = []
    const server = serve(seen)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const c = new ImapFlow({ host: '127.0.0.1', port, secure: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true })
    c.on('error', () => undefined)
    try {
      await c.connect()
      const client = imapClient(c, 'INBOX')
      expect(await client.open()).toEqual({ uidValidity: '777', uidNext: 104, exists: 3 })
      const got = await client.fetchSince(101, 10)
      expect(got.map((m) => m.uid)).toEqual([102, 103])
      expect(await parseMail(got[1]!.source)).toMatchObject({ subject: 'three', from: { address: 'c@x.io' } })
      expect((await client.fetchSince(102, 1)).map((m) => m.uid)).toEqual([103])
      await client.close()
      expect(seen.some((l) => /EXAMINE INBOX$/.test(l))).toBe(true)
      expect(seen.some((l) => /UID SEARCH UID 102:\*$/.test(l))).toBe(true)
      expect(seen.some((l) => /UID FETCH 102,103 \(UID BODY\.PEEK\[\]<0\.\d+>\)$/.test(l))).toBe(true)
    } finally {
      c.close()
      server.close()
    }
  })
})

describe('connectImap', () => {
  it("signs in over TLS with the certificate checked (no tls override) and imapflow's logger off", () => {
    const o = imapOptions({ host: 'imap.example.com', port: 993, user: 'ann', password: 'hunter22' })
    expect(o).toMatchObject({ host: 'imap.example.com', port: 993, secure: true, logger: false, auth: { user: 'ann', pass: 'hunter22' } })
    // A `tls` object could turn off rejectUnauthorized; none is passed, so Node's own checks hold.
    expect(o).not.toHaveProperty('tls')
    expect(o).not.toHaveProperty('doSTARTTLS')
  })

  it('fails on a closed port with an error that never holds the password', async () => {
    const server = createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((r) => server.close(() => r()))
    const r = await checkMailbox(
      { connect: connectImap, account: () => ({ username: 'ann', password: 'hunter22' }) },
      { kind: 'email', account: 'acc', host: '127.0.0.1', port, folder: 'INBOX', filters: [] }
    )
    expect(r).toHaveProperty('error')
    expect(JSON.stringify(r)).not.toContain('hunter22')
  })
})
