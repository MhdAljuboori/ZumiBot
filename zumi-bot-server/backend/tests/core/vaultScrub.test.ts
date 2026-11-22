import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../../src/core/store/chatStore'
import { TodoService } from '../../src/core/todos/todoService'
import type { AskOwner } from '../../src/core/asks/askIpc'
import { scrubbedAsks, scrubbedHandoffs, scrubbedTodos } from '../../src/core/vault/scrubBridges'
import { DeltaScrubber, scrubBrowserResult, scrubEvent, scrubText } from '../../src/core/vault/scrub'
import { vaultEnvOf } from '../../src/core/vault/vaultEnv'
import { cutBrowserResult } from '../../src/core/browser/browserTools'
import { BROWSER_CUTS, SCRUB_MARGIN, SECRET_MAX, pageTextCap } from '../../src/core/browser/browserLimits'
import { COMPUTED_STYLE_PROPS } from '../../src/core/browser/browserStyle'
import { browserPrompt } from '../../src/core/browser/browserPrompt'
import type { RunEvent } from '../../src/core/chat/streamParser'
import { luhnOk, type VaultItem } from '@zumibot/shared/vault'

const V = 'SECRET-VALUE-1'
const map = new Map([[V, '[vault: K]']])
const has = (x: unknown) => JSON.stringify(x).includes(V)

describe('vaultEnvOf', () => {
  it('maps API key items to env vars and labels, and ignores the other kinds', () => {
    const items = [
      {
        id: '1',
        updatedAt: 1,
        name: 'Azure PAT',
        agents: ['a'],
        kind: 'apiKey',
        env: 'AZURE_DEVOPS_EXT_PAT',
        value: 'pat-value-123',
        description: ''
      },
      {
        id: '2',
        updatedAt: 1,
        name: 'Mail',
        agents: ['a'],
        kind: 'login',
        sites: ['x.com'],
        username: 'u',
        password: 'login-password',
        totp: null
      }
    ] as VaultItem[]
    const { env, scrub } = vaultEnvOf(items)
    expect(env).toEqual({ AZURE_DEVOPS_EXT_PAT: 'pat-value-123' })
    expect([...scrub]).toEqual([['pat-value-123', '[vault: Azure PAT]']])
  })
})

describe('scrubText', () => {
  it('scrubs literally', () => {
    const value = 'a.b*c(d)+e$'
    const m = new Map([[value, '[vault: K]']])
    expect(scrubText(`x ${value} y ${value}`, m)).toBe('x [vault: K] y [vault: K]')
    // Regex characters are never interpreted: the dot, star and group do not match other text.
    expect(scrubText('abXcde', m)).toBe('abXcde')
    expect(scrubText('aXb', new Map([['a.b', '[vault: K]']]))).toBe('aXb')
  })

  it('replaces the longest value first', () => {
    const m = new Map([
      ['token-abcd', '[vault: short]'],
      ['token-abcdefgh', '[vault: long]']
    ])
    expect(scrubText('use token-abcdefgh now', m)).toBe('use [vault: long] now')
  })
})

describe('scrubEvent', () => {
  it('scrubs every string of every event kind', () => {
    const cost = { totalUsd: 0, models: {} }
    const events: RunEvent[] = [
      { kind: 'init', sessionId: V, version: V },
      { kind: 'entry', uuid: V },
      { kind: 'textDelta', text: V },
      { kind: 'assistantText', text: V },
      { kind: 'toolUse', id: V, name: V, input: { command: `echo ${V}`, nested: [V, { deep: V }] }, message: V },
      { kind: 'toolResult', toolUseId: V, content: V, isError: false, detail: { stdout: V, list: [V] } },
      { kind: 'subText', parent: V, text: V },
      { kind: 'subToolUse', parent: V, id: V, name: V, input: { a: V }, subagent: V },
      { kind: 'subToolResult', parent: V, toolUseId: V, content: V, isError: false, detail: { x: V } },
      { kind: 'taskStarted', toolUseId: V, taskId: V, description: V, subagentType: V, prompt: V },
      { kind: 'taskProgress', toolUseId: V, description: V, tokens: 1, toolUses: 1, durationMs: 1 },
      { kind: 'taskUpdated', taskId: V, status: V, endTime: 1 },
      {
        kind: 'result',
        subtype: V,
        isError: false,
        numTurns: 1,
        sessionId: V,
        denials: [{ toolUseId: V, toolName: V }],
        windows: { [V]: 5 },
        uuid: V,
        cost: { ...cost } as never
      },
      { kind: 'permissionCancel', requestId: V },
      { kind: 'controlUnknown', requestId: V, subtype: V }
    ]
    for (const e of events) {
      expect(has(e)).toBe(true)
      const out = scrubEvent(e, map)
      expect(has(out), e.kind).toBe(false)
      expect(JSON.stringify(out)).toContain('[vault: K]')
    }
    // Numbers, booleans and null are kept.
    expect(scrubEvent(events[4], map)).toMatchObject({
      kind: 'toolUse',
      input: { command: 'echo [vault: K]', nested: ['[vault: K]', { deep: '[vault: K]' }] }
    })
    expect(scrubEvent({ kind: 'context', model: null, tokens: 5 }, map)).toEqual({ kind: 'context', model: null, tokens: 5 })
  })

  it('leaves permissionRequest unchanged', () => {
    const e: RunEvent = {
      kind: 'permissionRequest',
      requestId: 'r',
      toolName: 'Bash',
      input: { command: `curl -H ${V}` },
      description: V,
      reason: V,
      toolUseId: 't'
    }
    expect(scrubEvent(e, map)).toBe(e)
  })

  it('returns the event itself when there is nothing to scrub', () => {
    const e: RunEvent = { kind: 'assistantText', text: V }
    expect(scrubEvent(e, new Map())).toBe(e)
  })
})

describe('DeltaScrubber', () => {
  it('catches a value split across deltas', () => {
    const d = new DeltaScrubber(new Map([['ABCD1234', '[vault: K]']]))
    expect(d.push('tok-ABC') + d.push('D1234-end') + d.flush()).toBe('tok-[vault: K]-end')
  })

  it('catches a value split one character at a time and never emits a prefix of it', () => {
    const d = new DeltaScrubber(new Map([['ABCD1234', '[vault: K]']]))
    let out = ''
    for (const ch of 'xx ABCD1234 yy ABCD123') {
      out += d.push(ch)
      expect(out).not.toMatch(/ABC/)
    }
    expect(out + d.flush()).toBe('xx [vault: K] yy ABCD123')
  })

  it('passes text through untouched when there is nothing to scrub', () => {
    const d = new DeltaScrubber(new Map())
    expect(d.push('abc')).toBe('abc')
    expect(d.flush()).toBe('')
  })

  it('holds back at most longest - 1 characters', () => {
    const d = new DeltaScrubber(new Map([['ABCD1234', '[vault: K]']]))
    expect(d.push('0123456789')).toBe('012')
    expect(d.flush()).toBe('3456789')
  })
})

describe('bridges that carry text outside the stream', () => {
  const KEY = 'tok-secret-ABCD1234'
  const scrubOf = (agent: string): ReadonlyMap<string, string> => (agent === 'helper' ? new Map([[KEY, '[vault: Azure PAT]']]) : new Map())

  it('a to-do add whose text holds the value is stored scrubbed', async () => {
    const dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-vscrub-'))
    try {
      const store = new ChatStore(dir)
      const chatId = (await store.create('helper', '/a')).id
      let n = 0
      const todos = new TodoService({ store, now: () => 1000 + ++n, newId: () => `t${n}`, onChanged: () => {} })
      const bridge = scrubbedTodos(todos, scrubOf)
      const answer = await bridge.agentAdd(chatId, 'helper', 'turn', 'Digest', [{ text: `Rotate ${KEY} today`, group: `about ${KEY}` }])
      expect(answer).not.toContain(KEY)
      const { items } = await todos.list(chatId)
      expect(items.map((i) => i.text)).toEqual(['Rotate [vault: Azure PAT] today'])
      expect(JSON.stringify(await store.loadBoard())).not.toContain(KEY)
      // An agent with no grants is left alone.
      await bridge.agentAdd(chatId, 'other', 'turn', 'Digest', [{ text: `keep ${KEY}` }])
      expect((await todos.list(chatId)).items.map((i) => i.text)).toContain(`keep ${KEY}`)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it("scrubs a task agent's questions, options, review summary and comments before the card stores them", async () => {
    const calls: unknown[][] = []
    const bridge = scrubbedTodos(
      {
        agentList: async () => '',
        agentAdd: async () => '',
        agentCheck: async () => '',
        agentRemove: async () => '',
        agentAskUser: async (...a) => {
          calls.push(a)
          return 'q'
        },
        agentReview: async (...a) => {
          calls.push(a)
          return 'v'
        },
        agentComment: async (...a) => {
          calls.push(a)
          return 'm'
        }
      },
      scrubOf
    )
    await bridge.agentAskUser('c', 'helper', 't', [{ text: `Use ${KEY}?`, options: [`yes ${KEY}`] }])
    await bridge.agentReview('c', 'helper', 't', `rotated ${KEY}`)
    await bridge.agentComment('c', 'helper', 't', 'card', `found ${KEY}`)
    expect(JSON.stringify(calls)).not.toContain(KEY)
    expect(JSON.stringify(calls)).toContain('[vault: Azure PAT]')
  })

  it('the to-do read, tick and remove calls pass through', async () => {
    const calls: unknown[][] = []
    const bridge = scrubbedTodos(
      {
        agentList: async (...a) => {
          calls.push(['list', ...a])
          return 'l'
        },
        agentAdd: async (...a) => {
          calls.push(['add', ...a])
          return 'a'
        },
        agentCheck: async (...a) => {
          calls.push(['check', ...a])
          return 'c'
        },
        agentRemove: async (...a) => {
          calls.push(['remove', ...a])
          return 'r'
        },
        agentAskUser: async (...a) => {
          calls.push(['ask', ...a])
          return 'q'
        },
        agentReview: async (...a) => {
          calls.push(['review', ...a])
          return 'v'
        },
        agentComment: async (...a) => {
          calls.push(['comment', ...a])
          return 'm'
        }
      },
      scrubOf
    )
    expect(await bridge.agentList('c', 'helper')).toBe('l')
    expect(await bridge.agentCheck('c', 'helper', 't', ['1'], true)).toBe('c')
    expect(await bridge.agentRemove('c', 'helper', 't', ['1'])).toBe('r')
    expect(calls).toEqual([
      ['list', 'c', 'helper'],
      ['check', 'c', 'helper', 't', ['1'], true],
      ['remove', 'c', 'helper', 't', ['1']]
    ])
  })

  it("ask messages and side_question questions are scrubbed with the owner agent's keys", async () => {
    const seen: unknown[] = []
    const bridge = scrubbedAsks(
      {
        ask: async (_o, call) => {
          seen.push(call)
          return 'ok'
        },
        sideAsk: async (_o, call) => {
          seen.push(call)
          return 'ok'
        }
      },
      scrubOf
    )
    const owner = (agent: string): AskOwner => ({ chatId: 'c', agent: () => agent, chain: [], turn: 't' })
    const signal = new AbortController().signal
    await bridge.ask(owner('helper'), { agent: 'b', message: `use ${KEY}` }, signal)
    await bridge.sideAsk(owner('helper'), { agent: 'b', question: `is ${KEY} valid?` }, signal)
    await bridge.ask(owner('other'), { agent: 'b', message: `use ${KEY}` }, signal)
    expect(seen).toEqual([
      { agent: 'b', message: 'use [vault: Azure PAT]' },
      { agent: 'b', question: 'is [vault: Azure PAT] valid?' },
      { agent: 'b', message: `use ${KEY}` }
    ])
  })

  it("a browser or desktop handoff reason is scrubbed with the owner agent's keys before its card is stored", async () => {
    type Handoff = import('@zumibot/shared/browser').BrowserHandoff
    const stored: Handoff[] = []
    const made: unknown[][] = []
    const turns = {
      plan: async () => 'off' as const,
      create: async (owner: { profileId: string }, onHandoff: (h: Handoff) => Promise<void>, o?: { side?: boolean }) => {
        made.push([owner, o])
        const base = {
          id: 'h1',
          profileId: owner.profileId,
          generation: 'g',
          chatId: 'c',
          turnId: 't',
          site: 'https://x.test',
          createdAt: 1,
          status: 'pending' as const
        }
        await onHandoff({ ...base, agent: 'helper', reason: `Paste ${KEY} into the form` })
        await onHandoff({ ...base, agent: 'other', reason: `keep ${KEY}` })
        return 'turn'
      }
    }
    const bridge = scrubbedHandoffs(turns, scrubOf)
    expect(await bridge.plan()).toBe('off')
    expect(
      await bridge.create(
        { profileId: 'p' },
        async (h) => {
          stored.push(h)
        },
        { side: true }
      )
    ).toBe('turn')
    expect(made).toEqual([[{ profileId: 'p' }, { side: true }]])
    expect(stored.map((h) => h.reason)).toEqual(['Paste [vault: Azure PAT] into the form', `keep ${KEY}`])
    expect(stored[0]).toMatchObject({ id: 'h1', agent: 'helper', status: 'pending', site: 'https://x.test' })
  })
})

describe('scrubBrowserResult', () => {
  const secrets = { values: ['p4ss.w*rd(1)', 'az-pat-value-0001'], cards: ['4242424242424242'] }
  const H = '[hidden by vault]'

  it('replaces values literally and card numbers with spaces or dashes in every string', () => {
    const r = scrubBrowserResult(
      {
        ok: true,
        data: {
          stamp: { generation: 'g', tabId: 't', observationId: 'o' },
          text: 'Your password is p4ss.w*rd(1) and p4ssXwXrd(1) stays; card 4242 4242 4242 4242, 4242-4242-4242-4242 or 4242424242424242',
          elements: [{ ref: 'e1', role: 'textbox', name: 'Token az-pat-value-0001', text: '' }],
          tabs: [{ id: 't', title: 'Paid with 4242 4242-4242 4242', url: 'https://x.test/?k=az-pat-value-0001' }]
        }
      },
      secrets
    )
    const json = JSON.stringify(r)
    for (const v of [
      'p4ss.w*rd(1)',
      'az-pat-value-0001',
      '4242 4242 4242 4242',
      '4242-4242-4242-4242',
      '4242424242424242',
      '4242 4242-4242 4242'
    ])
      expect(json).not.toContain(v)
    // Literal: the regex characters of a value never match other text.
    expect(json).toContain('p4ssXwXrd(1) stays')
    expect(r).toMatchObject({
      ok: true,
      data: {
        text: `Your password is ${H} and p4ssXwXrd(1) stays; card ${H}, ${H} or ${H}`,
        tabs: [{ title: `Paid with ${H}`, url: `https://x.test/?k=${H}` }]
      }
    })
    // Two separators in a row end a digit run: the first group stays. The 12 digits after it are a Luhn-valid run ending in the
    // saved card's last 4, so they go like any such run (see the guess tests below).
    expect(scrubBrowserResult({ ok: true, data: { text: '4242  4242 4242 4242' } }, secrets)).toEqual({
      ok: true,
      data: { text: `4242  ${H}` }
    })
  })

  describe('card number guesses', () => {
    const SAVED = '4242424242424242'
    // Luhn-valid numbers with the saved card's issuer start and last 4, as a page that knows both would try them.
    const guesses = (count: number, start = '424242', end = '4242'): string[] => {
      const out: string[] = []
      for (let middle = 0; out.length < count; middle++) {
        const n = `${start}${String(middle).padStart(16 - start.length - end.length, '0')}${end}`
        if (luhnOk(n)) out.push(n)
      }
      return out
    }
    const scrub = (text: string, cards: string[]) =>
      (scrubBrowserResult({ ok: true, data: { text } }, { values: [], cards }) as { data: { text: string } }).data.text

    it("hides every Luhn-valid run ending in a saved card's last 4, so the answer never says which guess is the card", () => {
      const list = guesses(999)
      list.splice(500, 0, SAVED)
      expect(new Set(list).size).toBe(1000)
      // Another saved card with the same last 4: what the page gets back must not depend on which number is saved.
      const other = list.find((n) => n !== SAVED)!
      for (const shape of [
        (n: string) => n,
        (n: string) => n.replace(/(\d{4})(?=\d)/g, '$1 '),
        (n: string) => n.replace(/(\d{4})(?=\d)/g, '$1-')
      ]) {
        const page = list.map(shape).join(', ')
        expect(scrub(page, [SAVED])).toBe(list.map(() => H).join(', '))
        expect(scrub(page, [other])).toBe(scrub(page, [SAVED]))
        // Run into other digits, or with a 13-19 digit length, it still answers the same for every guess.
        for (const wrap of [(n: string) => `1${n}`, (n: string) => `${n}5`, (n: string) => `07${n}`]) {
          const wrapped = list.map((n) => wrap(shape(n))).join(', ')
          expect(scrub(wrapped, [other])).toBe(scrub(wrapped, [SAVED]))
          expect(scrub(wrapped, [SAVED])).not.toMatch(/\d{4}[\s-]?\d{4}[\s-]?\d{4}/)
        }
      }
    })

    it('leaves numbers alone that are not Luhn-valid, or end in other last 4, or are too short', () => {
      const notLuhn = guesses(5).map((n) => `${n.slice(0, 6)}${(Number(n[6]) + 1) % 10}${n.slice(7)}`)
      expect(notLuhn.every((n) => !luhnOk(n) && n.endsWith('4242'))).toBe(true)
      const otherEnd = guesses(5, '411111', '1111')
      const ordinary = [
        `Order total $1,234.42, order #4242, ref 10024242`,
        `Call +1 555-014-4242 or +44 20 7946 4242`,
        `Card ending 4242, ${notLuhn.join(', ')}`,
        `Other cards: ${otherEnd.join(', ')}`,
        '4242 4242 4242'.slice(0, 11) + ' 42'
      ]
      // The phone numbers above are not Luhn-valid 12+ digit runs, which is why they stay; check it rather than assume it.
      expect(luhnOk('442079464242')).toBe(false)
      for (const text of ordinary) expect(scrub(text, [SAVED])).toBe(text)
    })

    it('hides every 12-19 digit run ending in the last 4 of a saved card that is not Luhn-valid, whatever its checksum', () => {
      const typo = '4242424242424241'
      expect(luhnOk(typo)).toBe(false)
      const list = [...guesses(20, '424242', '4241'), '4242424242414241', typo, '987654324241']
      expect(scrub(list.join(', '), [typo])).toBe(list.map(() => H).join(', '))
      expect(scrub('4242424242424242, 12344241', [typo])).toBe('4242424242424242, 12344241')
    })
  })

  it('never answers whether a string starts a secret: only whole secrets are replaced', () => {
    const scrub = (text: string, saved = secrets) =>
      (scrubBrowserResult({ ok: true, data: { text } }, saved) as { data: { text: string } }).data.text
    // Each of these ends in the first 4+ characters of a saved secret; blanking them would tell a page which guesses are right.
    for (const text of ['Card: 4242 4242', 'Card: 4242-42', 'Option 4242424242', 'Token az-pat-va', 'Pass p4ss', 'Pass p4ss.w*rd('])
      expect(scrub(text)).toBe(text)
    // An ordinary label that starts a saved password stays as it is, so the agent can still find the field to fill.
    const login = { values: ['Password123!'], cards: ['5412751234123456'] }
    const r = scrubBrowserResult(
      {
        ok: true,
        data: {
          stamp: { generation: 'g', tabId: 't', observationId: 'o' },
          text: 'Order total 5412',
          elements: [
            { ref: 'r1', role: 'textbox', name: 'Password', text: '' },
            { ref: 'r2', role: 'textbox', name: 'Password123', text: '' }
          ]
        }
      },
      login
    )
    expect(r).toEqual({
      ok: true,
      data: {
        stamp: { generation: 'g', tabId: 't', observationId: 'o' },
        text: 'Order total 5412',
        elements: [
          { ref: 'r1', role: 'textbox', name: 'Password', text: '' },
          { ref: 'r2', role: 'textbox', name: 'Password123', text: '' }
        ]
      }
    })
    expect(scrub('Your password is Password123! ok', login)).toBe(`Your password is ${H} ok`)
    // The same for tab titles and URLs.
    const tabs = { tabs: [{ id: 't', title: 'x p4ss.w', url: 'https://evil.test/#az-pat-val' }], activeTabId: 't' }
    expect(scrubBrowserResult({ ok: true, data: tabs }, secrets)).toEqual({ ok: true, data: tabs })
  })

  it('never alters a server-made id (stamp, ref, tab id), even one whose digits a card run or a saved value would match', () => {
    // A valid v4 UUID whose digits, joined across its dashes, are a Luhn-valid run ending in the saved card's last 4.
    const U = '00000000-0000-4000-8000-000000004242'
    const saved = { values: ['0000-4000'], cards: ['4242424242424242'] }
    const ids = { generation: U, tabId: U, observationId: U }
    const r = scrubBrowserResult(
      {
        ok: true,
        data: {
          stamp: ids,
          text: `id ${U}`,
          elements: [{ ref: U, role: 'button', name: `Order ${U}`, text: '', frame: 'x.test' }],
          tabs: [{ id: U, title: 'Shop', url: `https://x.test/o/${U}` }],
          activeTabId: U,
          dialog: { tabId: U, type: 'alert', message: U, defaultValue: '' },
          downloads: [{ id: U, name: 'a.txt', size: 1 }]
        }
      },
      saved
    ) as { ok: true; data: Record<string, any> }
    expect(r.data.stamp).toEqual(ids)
    expect(r.data.elements[0].ref).toBe(U)
    expect(r.data.tabs[0].id).toBe(U)
    expect(r.data.activeTabId).toBe(U)
    expect(r.data.dialog.tabId).toBe(U)
    expect(r.data.downloads[0].id).toBe(U)
    // The same text in what a page wrote is still scrubbed: only the id fields are left alone.
    for (const shown of [r.data.text, r.data.elements[0].name, r.data.tabs[0].url, r.data.dialog.message])
      expect(shown).toContain('[hidden by vault]')
    // A field with an id's name but not an id's shape (never server-made) is scrubbed as before.
    expect(scrubBrowserResult({ ok: true, data: { id: 'pay 4242 4242 4242 4242' } }, saved)).toEqual({
      ok: true,
      data: { id: 'pay [hidden by vault]' }
    })
  })

  it('scrubs error messages and keeps image data untouched', () => {
    expect(scrubBrowserResult({ ok: false, code: 'wrong_site', message: 'Typed p4ss.w*rd(1)' }, secrets)).toEqual({
      ok: false,
      code: 'wrong_site',
      message: `Typed ${H}`
    })
    const image = { ok: true as const, data: { mimeType: 'image/jpeg', base64: 'NDI0MjQyNDI0MjQyNDI0Mg==' } }
    expect(scrubBrowserResult(image, { values: ['NDI0MjQyNDI0MjQyNDI0Mg=='], cards: [] })).toEqual(image)
    expect(scrubBrowserResult({ ok: true, data: null }, secrets)).toEqual({ ok: true, data: null })
    expect(scrubBrowserResult({ ok: true, data: { text: 'abc' } }, { values: [''], cards: ['12'] })).toEqual({
      ok: true,
      data: { text: 'abc' }
    })
  })
})

describe('cutBrowserResult after the scrub', () => {
  // Page text the worker cut at its own limit (no elements): 32 000 + the margin.
  const cutText = (removed: number) => {
    const raw = pageTextCap(0)
    const r = cutBrowserResult(
      { ok: true, data: { stamp: { generation: 'g', tabId: 't', observationId: 'o' }, text: 'a'.repeat(raw), elements: [] } },
      new Map([['data/text', { raw, removed }]])
    ) as { data: { text: string } }
    return r.data.text.length
  }

  it('moves the cut only in steps of 256, so its length never tells how long a secret it hid was', () => {
    expect(cutText(0)).toBe(BROWSER_CUTS.pageText)
    const lengths = Array.from({ length: 1300 }, (_, removed) => cutText(removed))
    for (let removed = 1; removed < lengths.length; removed++) {
      const step = Math.ceil(removed / 256)
      expect(lengths[removed], `removed ${removed}`).toBe(lengths[(step - 1) * 256 + 1])
      // Never longer than the exact rule allows: still at least SECRET_MAX - 1 short of the worker's cut, counted after the scrub.
      expect(lengths[removed]).toBeLessThanOrEqual(pageTextCap(0) - (SECRET_MAX - 1) - removed)
    }
    const distinct = [...new Set(lengths.slice(1))]
    for (let i = 1; i < distinct.length; i++) expect(distinct[i - 1] - distinct[i]).toBe(256)
  })
})

describe('a computed style result', () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 }
  const style = (s: unknown, r: unknown = rect) => ({ ok: true as const, data: { style: s, rect: r } })
  const secrets = { values: ['p4ss.w*rd(1)'], cards: [] as string[] }
  const cut = (r: ReturnType<typeof style>, trace?: Map<string, { raw: number; removed: number }>) =>
    cutBrowserResult(r, trace) as { ok: true; data: { style: Record<string, string>; rect: Record<string, number> } }

  it('hides a saved secret that a value equals', () => {
    const scrubbed = scrubBrowserResult(style({ 'background-color': 'p4ss.w*rd(1)', color: 'rgb(0, 0, 0)' }), secrets)
    expect(scrubbed).toEqual(style({ 'background-color': '[hidden by vault]', color: 'rgb(0, 0, 0)' }))
  })

  it("cuts a value at the limit, and shows nothing within SECRET_MAX - 1 characters of the worker's own cut", () => {
    const long = 'a'.repeat(BROWSER_CUTS.styleValue + 500)
    expect(cut(style({ 'font-family': long })).data.style['font-family']).toHaveLength(BROWSER_CUTS.styleValue)
    // A value as long as the worker's cut may end in the start of a secret: the limit sits SECRET_MAX - 1 or more before that cut,
    // so it alone applies until the replacements pull the cut in (in steps of 256, as for page text).
    const raw = BROWSER_CUTS.styleValue + SCRUB_MARGIN
    const shown = (removed: number) =>
      cut(style({ 'font-family': 'a'.repeat(raw) }), new Map([['data/style/font-family', { raw, removed }]])).data.style['font-family']
        .length
    expect(shown(0)).toBe(BROWSER_CUTS.styleValue)
    expect(shown(SCRUB_MARGIN)).toBe(0)
    // cap - (SECRET_MAX - 1) - stepped(removed): 8392 - 7999 = 393, so one removed character leaves 393 - 256 = 137 (under the
    // limit of 200), and 257 removed steps to 512, past it.
    expect(shown(1)).toBe(137)
    expect(shown(257)).toBe(0)
  })

  it('keeps only the fixed property names with string values, at most 40', () => {
    const hostile: Record<string, unknown> = {
      color: 'red',
      'custom-prop': 'x',
      '--secret': 'y',
      width: 12,
      display: { a: 1 },
      height: null,
      opacity: ['1']
    }
    Object.defineProperty(hostile, '__proto__', { value: 'z', enumerable: true })
    expect(cut(style(hostile)).data.style).toEqual({ color: 'red' })
    const all = Object.fromEntries(COMPUTED_STYLE_PROPS.map((n) => [n, 'v']))
    const out = cut(style({ ...all, extra1: 'a', extra2: 'b' })).data.style
    expect(Object.keys(out).sort()).toEqual([...COMPUTED_STYLE_PROPS].sort())
    expect(Object.keys(out)).toHaveLength(40)
  })

  it('answers an empty style for anything that is not a plain object', () => {
    for (const bad of ['color: red', 7, null, ['red'], undefined]) expect(cut(style(bad)).data.style).toEqual({})
  })

  it('replaces a rect field that is not a finite number with 0', () => {
    expect(cut(style({}, { x: '1', y: NaN, width: Infinity, height: null })).data.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(cut(style({}, null)).data.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(cut(style({}, { x: -3.5, y: 2, width: 10, height: 0, extra: 'x' })).data.rect).toEqual({ x: -3.5, y: 2, width: 10, height: 0 })
  })

  it('recognises a result with a style but no rect, and zeroes the rect', () => {
    const out = cutBrowserResult({ ok: true, data: { style: { color: 'red', extra: 'x' } } }) as { data: unknown }
    expect(out.data).toEqual({ style: { color: 'red' }, rect: { x: 0, y: 0, width: 0, height: 0 } })
  })

  it('caps the property count at 40 whatever the fixed list holds', () => {
    expect(BROWSER_CUTS.styleProps).toBe(40)
    expect(COMPUTED_STYLE_PROPS.length).toBeLessThanOrEqual(BROWSER_CUTS.styleProps)
  })
})

it('names the four audit tools in the browser prompt', () => {
  for (const tool of ['browser_save_screenshot', 'browser_computed_style', 'browser_hover', 'browser_set_viewport', 'dialog_interrupted'])
    expect(browserPrompt).toContain(tool)
  // Every browser agent reads it: no product of one user's workflow is named.
  expect(browserPrompt.toLowerCase()).not.toContain('workiom')
  expect(browserPrompt).toContain('attach the returned file path where the task needs the file, or read it; never paste it as a link')
  expect(browserPrompt).toContain(
    "browser_set_viewport lasts until you release the browser or the lease goes idle; if a saved shot's width differs from what you set, set it again."
  )
})
