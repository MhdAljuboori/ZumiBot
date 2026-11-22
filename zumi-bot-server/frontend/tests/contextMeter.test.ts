import { describe, expect, it } from 'vitest'
import type { AgentSummary, ChatMeta, GroupInfo } from '@zumibot/shared/types'
import {
  CACHE_TTL_MS,
  canCompact,
  coldContexts,
  coldNotice,
  compactAtOf,
  compactChoices,
  compactNoteShown,
  coldNoticeShown,
  contextMeter,
  fullest,
  meterLimit,
  memberMeters,
  selfCompactText,
  tokens
} from '../src/state/contextMeter'

describe('tokens', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [17_000, '17K'],
    [17_499, '17K'],
    [312_400, '312K'],
    [880_412, '880K'],
    [999_600, '1M'],
    [1_000_000, '1M'],
    [1_500_000, '1.5M'],
    [1_049_000, '1M']
  ])('%i is %s', (n, out) => expect(tokens(n)).toBe(out))
})

describe('contextMeter', () => {
  it('shows nothing before a turn reported one, or without a window', () => {
    expect(contextMeter(undefined)).toBeNull()
    expect(contextMeter({ used: 5, window: null })).toBeNull()
  })

  it('fills to the share used, amber from 75%, with the numbers in its title', () => {
    expect(contextMeter({ used: 312_000, window: 1_000_000 })).toEqual({
      fraction: 0.312,
      percent: 31,
      warn: false,
      compacted: false,
      title: 'Context 31% · 312K / 1M'
    })
    expect(contextMeter({ used: 150_000, window: 200_000 })).toMatchObject({ percent: 75, warn: true })
    expect(contextMeter({ used: 148_000, window: 200_000 })).toMatchObject({ percent: 74, warn: false })
  })

  it('never shows more than full', () => {
    expect(contextMeter({ used: 250_000, window: 200_000 })).toMatchObject({ fraction: 1, percent: 100, warn: true })
  })

  it('a compaction empties it and says the size comes with the next reply', () => {
    expect(contextMeter({ used: null, window: 1_000_000, compacted: { pre: 970_000, post: 17_000 } })).toEqual({
      fraction: 0,
      percent: 0,
      warn: false,
      compacted: true,
      title: 'Compacted 970K → 17K · exact size after the next reply'
    })
    expect(contextMeter({ used: null, window: 1_000_000 })).toMatchObject({
      fraction: 0,
      title: 'Compacted · exact size after the next reply'
    })
  })
})

describe('contextMeter with Compact at', () => {
  it("measures against the agent's Compact at size, which is where the session compacts", () => {
    expect(contextMeter({ used: 300_000, window: 1_000_000 }, 400_000)).toEqual({
      fraction: 0.75,
      percent: 75,
      warn: true,
      compacted: false,
      title: 'Context 75% · 300K / 400K before compacting'
    })
  })

  it('a size at or past the Compact at size is full and compacts on the next request', () => {
    expect(contextMeter({ used: 730_000, window: 1_000_000 }, 400_000)).toEqual({
      fraction: 1,
      percent: 100,
      warn: true,
      compacted: false,
      title: 'Context full · 730K, compacts on its next request'
    })
  })

  it('a Compact at size above the window changes nothing', () => {
    expect(contextMeter({ used: 150_000, window: 200_000 }, 400_000)).toEqual(contextMeter({ used: 150_000, window: 200_000 }))
    expect(meterLimit(200_000, 400_000)).toBe(200_000)
    expect(meterLimit(1_000_000, 400_000)).toBe(400_000)
    expect(meterLimit(1_000_000, undefined)).toBe(1_000_000)
  })

  it("finds an agent's Compact at size by name", () => {
    const agents = [
      {
        filePath: '/a/ui.md',
        name: 'ui',
        description: '',
        color: null,
        icon: null,
        error: null,
        builtIn: false,
        autoCompactWindow: 400_000
      }
    ]
    expect(compactAtOf(agents, 'ui')).toBe(400_000)
    expect(compactAtOf(agents, 'wk')).toBeUndefined()
  })
})

describe('canCompact', () => {
  it('needs a session that is not waiting to be seeded', () => {
    expect(canCompact('s1', undefined)).toBe(true)
    expect(canCompact('s1', { at: 'e1' })).toBe(true)
    expect(canCompact(null, undefined)).toBe(false)
    expect(canCompact(undefined, undefined)).toBe(false)
    expect(canCompact('s1', { seed: true })).toBe(false)
  })
})

describe('room meters', () => {
  const g: GroupInfo = {
    members: ['ui', 'wk', 'ps'],
    sessions: { ui: 's1', wk: 's2', ps: null },
    seen: {},
    role: '',
    active: [],
    queue: [],
    context: { ui: { used: 60_000, window: 200_000 }, wk: { used: 172_000, window: 200_000 } }
  }

  it('lists every member in order, with its meter and whether it can compact', () => {
    expect(memberMeters(g)).toEqual([
      { member: 'ui', meter: expect.objectContaining({ percent: 30 }), canCompact: true },
      { member: 'wk', meter: expect.objectContaining({ percent: 86, warn: true }), canCompact: true },
      { member: 'ps', meter: null, canCompact: false }
    ])
    expect(memberMeters({ ...g, context: undefined, next: { wk: { seed: true } } }).map((r) => [r.meter, r.canCompact])).toEqual([
      [null, true],
      [null, false],
      [null, false]
    ])
  })

  it("each member's meter measures against its own Compact at size", () => {
    const agents = [
      {
        filePath: '/a/wk.md',
        name: 'wk',
        description: '',
        color: null,
        icon: null,
        error: null,
        builtIn: false,
        autoCompactWindow: 200_000
      }
    ]
    const wide = { ...g, context: { ui: { used: 60_000, window: 1_000_000 }, wk: { used: 150_000, window: 1_000_000 } } }
    expect(memberMeters(wide, agents).map((r) => r.meter?.percent)).toEqual([6, 75, undefined])
  })

  it('the ring shows the fullest member', () => {
    expect(fullest(memberMeters(g))).toMatchObject({ percent: 86 })
    expect(fullest(memberMeters({ ...g, context: undefined }))).toBeNull()
  })
})

describe('compact choices', () => {
  it("offers the CLI's own window and four sizes, the file's one picked", () => {
    expect(compactChoices(null).map((c) => [c.label, c.active])).toEqual([
      ['Default', true],
      ['200K', false],
      ['300K', false],
      ['400K', false],
      ['600K', false]
    ])
    expect(
      compactChoices(400_000)
        .filter((c) => c.active)
        .map((c) => c.value)
    ).toEqual([400_000])
  })

  it('a size set in the raw file shows as custom', () => {
    expect(compactChoices(250_000).map((c) => [c.label, c.active])).toEqual([
      ['Default', false],
      ['200K', false],
      ['300K', false],
      ['400K', false],
      ['600K', false],
      ['Custom: 250K', true]
    ])
  })
})

describe('cold contexts', () => {
  const H = CACHE_TTL_MS
  const chat: ChatMeta = {
    id: 'c',
    agentName: 'ui',
    sessionId: 's1',
    cwd: '/w',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    inFlight: false,
    context: { used: 730_000, window: 1_000_000, at: 10_000 }
  }
  const agent = (name: string, autoCompactWindow?: number): AgentSummary => ({
    filePath: `/a/${name}.md`,
    name,
    description: '',
    color: null,
    icon: null,
    error: null,
    builtIn: false,
    ...(autoCompactWindow ? { autoCompactWindow } : {})
  })

  it('a Codex session has no cache hour to keep: never cold', () => {
    expect(coldContexts({ ...chat, sessionEngine: 'codex' }, [], 10_000 + H)).toEqual([])
  })

  it("in a room, a Codex member's context is never cold, nor one whose agent is now on Codex; a Claude member's still is", () => {
    const ctx = { used: 730_000, window: 1_000_000, at: 10_000 }
    const room: ChatMeta = {
      ...chat,
      agentName: '',
      sessionId: null,
      context: undefined,
      group: {
        members: ['ui', 'cx', 'mv'],
        sessions: { ui: 's1', cx: 'th-1', mv: 's2' },
        seen: {},
        role: '',
        active: [],
        queue: [],
        sessionEngines: { cx: 'codex' },
        context: { ui: ctx, cx: ctx, mv: ctx }
      }
    }
    const agents = [agent('ui'), { ...agent('cx'), provider: 'codex' as const }, { ...agent('mv'), provider: 'codex' as const }]
    expect(coldContexts(room, agents, 10_000 + H)).toEqual([{ member: 'ui', used: 730_000, since: 10_000 }])
    // Without the agents the stored mark alone still keeps the Codex thread out.
    expect(coldContexts(room, [], 10_000 + H).map((r) => r.member)).toEqual(['ui', 'mv'])
  })

  it('a big chat idle for the cache hour would reload its whole context', () => {
    expect(coldContexts(chat, [], 10_000 + H)).toEqual([{ member: null, used: 730_000, since: 10_000 }])
  })

  it('not while small, still warm, running, compacted, or waiting to be seeded', () => {
    const later = 10_000 + 2 * H
    expect(coldContexts({ ...chat, context: { used: 150_000, window: 1_000_000, at: 10_000 } }, [], later)).toEqual([])
    expect(coldContexts(chat, [], 10_000 + H - 1)).toEqual([])
    expect(coldContexts({ ...chat, inFlight: true }, [], later)).toEqual([])
    expect(coldContexts({ ...chat, context: { used: null, window: 1_000_000, at: 10_000 } }, [], later)).toEqual([])
    expect(coldContexts({ ...chat, next: { seed: true } }, [], later)).toEqual([])
  })

  it('not when the agent compacts below that size by itself on the next request', () => {
    expect(coldContexts(chat, [agent('ui', 400_000)], 10_000 + H)).toEqual([])
    expect(coldContexts(chat, [agent('ui', 800_000)], 10_000 + H)).toHaveLength(1)
  })

  it('a context saved before request times goes by the last reply', () => {
    const old = { ...chat, context: { used: 730_000, window: 1_000_000 }, replyAt: 5_000 }
    expect(coldContexts(old, [], 5_000 + H)).toEqual([{ member: null, used: 730_000, since: 5_000 }])
  })

  it('a room lists each cold member in order', () => {
    const room: ChatMeta = {
      ...chat,
      agentName: '',
      sessionId: null,
      context: undefined,
      group: {
        members: ['ui', 'wk', 'ps'],
        sessions: { ui: 's1', wk: 's2', ps: 's3' },
        seen: {},
        role: '',
        active: [],
        queue: [],
        context: {
          ui: { used: 730_000, window: 1_000_000, at: 10_000 },
          wk: { used: 500_000, window: 1_000_000, at: 10_000 + H },
          ps: { used: 300_000, window: 1_000_000, at: 0 }
        }
      }
    }
    expect(coldContexts(room, [], 10_000 + H)).toEqual([
      { member: 'ui', used: 730_000, since: 10_000 },
      { member: 'ps', used: 300_000, since: 0 }
    ])
  })

  it('says what the next message costs and what compacting changes', () => {
    expect(coldNotice([{ member: null, used: 730_000, since: 0 }], 3 * H)).toBe(
      "This chat's context is 730K tokens and its cache expired (idle 3 h): your next message reloads all of it at full price. Compacting first makes every message after it much cheaper."
    )
    expect(
      coldNotice(
        [
          { member: 'ui-ux', used: 730_000, since: 0 },
          { member: 'wk', used: 300_000, since: H }
        ],
        26 * H
      )
    ).toBe(
      'The cache expired for Ui Ux (730K) and Wk (300K) (idle 1 d): whoever answers next reloads their whole context at full price. Compacting first makes every reply after it much cheaper.'
    )
  })
})

describe('selfCompactText', () => {
  it("names Claude and the agent's Compact at size on a Claude chat", () => {
    expect(selfCompactText(300_000, 1_000_000, 'claude')).toBe(
      "Compacts by itself at about 300K, this agent's Compact at size (window 1M)."
    )
    expect(selfCompactText(undefined, 1_000_000, 'claude')).toBe('Claude compacts by itself when it is nearly full.')
    expect(selfCompactText(1_000_000, 1_000_000, 'claude')).toBe('Claude compacts by itself when it is nearly full.')
  })
  it('a Codex agent uses its Compact at size too, and never says Claude', () => {
    expect(selfCompactText(100_000, 258_400, 'codex')).toBe("Compacts by itself at about 100K, this agent's Compact at size (window 258K).")
    expect(selfCompactText(undefined, 258_400, 'codex')).toBe('The agent compacts by itself when it is nearly full.')
    expect(selfCompactText(258_400, 258_400, 'codex')).toBe('The agent compacts by itself when it is nearly full.')
  })
})

describe('compactNoteShown', () => {
  it('a Claude chat or room takes a note; Codex compacts with none, so the field is hidden', () => {
    expect(compactNoteShown('claude')).toBe(true)
    expect(compactNoteShown('codex')).toBe(false)
  })
})

describe('coldNoticeShown', () => {
  it('a Claude chat keeps the cold notice; a Codex chat has no prompt cache to go cold, though it can compact', () => {
    expect(coldNoticeShown('claude')).toBe(true)
    expect(coldNoticeShown('codex')).toBe(false)
  })
})
