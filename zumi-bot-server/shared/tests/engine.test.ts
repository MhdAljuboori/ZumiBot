import { expect, test } from 'vitest'
import {
  AGUI_REFUSALS,
  bridgeRefusal,
  byEngine,
  capRefusal,
  chatEngine,
  CODEX_REFUSALS,
  commentAskRefusal,
  engineCaps,
  engineOfAgent,
  ENGINE_LABEL,
  ENGINES,
  isolationRefusal,
  markEngine,
  parseProvider,
  providerOf,
  roomRefusal,
  sessionMark,
  spendCapRefusal,
  todoRefusal,
  unguardedNoticeText
} from '@zumibot/shared/engine'
import { modelFits } from '@zumibot/shared/chatModel'
import { NOTICE_TEXT, type AgentSummary } from '@zumibot/shared/types'

const agent = (name: string, provider?: 'codex'): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...(provider ? { provider } : {})
})

test('engineCaps: every flag true for claude but remote, false for codex except rewind, compact, btw, questions, files, vaultKeys, pause, dispatch, rooms and the 1b flags', () => {
  const { remote: claudeRemote, ...claudeRest } = engineCaps('claude')
  const claude = Object.values(claudeRest)
  const { rewind, compact, btw, questions, files, vaultKeys, pause, dispatch, rooms, resend, fork, cost, models, bridges, ...rest } =
    engineCaps('codex')
  expect(claude.length).toBe(20)
  expect(claude.every((v) => v === true)).toBe(true)
  // Claude runs on this machine.
  expect(claudeRemote).toBe(false)
  expect(Object.keys(rest).sort()).toEqual(['desktop', 'isolation', 'keepWarm', 'memory', 'plan', 'processes', 'remote'])
  expect(Object.values(rest).every((v) => v === false)).toBe(true)
  // Phase 1b's flags keep what Codex always had: Edit, Resend, Fork, spend caps, the model picker and the bridges.
  expect([resend, fork, cost, models, bridges]).toEqual([true, true, true, true, true])
  expect(rewind).toBe(true)
  expect(compact).toBe(true)
  expect(btw).toBe(true)
  expect(questions).toBe(true)
  expect(files).toBe(true)
  // Phase 3: the vault guard runs as a trusted Codex hook, so granted API keys reach Codex runs too.
  expect(vaultKeys).toBe(true)
  // The pause hook runs as a trusted Codex hook beside the vault's, so a Codex reply can be paused.
  expect(pause).toBe(true)
  // Codex subagents (multi_agent) show in the Dispatched agents panel, stopped with the process and finishing under a pause.
  expect(dispatch).toBe(true)
  // A Codex agent joins a room: each member runs on its own engine, the moderator stays Claude.
  expect(rooms).toBe(true)
})

test('engineOfAgent: only provider codex is codex', () => {
  expect(engineOfAgent(agent('x', 'codex'))).toBe('codex')
  expect(engineOfAgent(agent('x'))).toBe('claude')
  expect(engineOfAgent(undefined)).toBe('claude')
})

test('chatEngine: a single chat follows its agent; a room member follows its own agent, and the room itself is claude', () => {
  const agents = [agent('x', 'codex'), agent('y')]
  expect(chatEngine({ agentName: 'x' }, agents)).toBe('codex')
  expect(chatEngine({ agentName: 'y' }, agents)).toBe('claude')
  expect(chatEngine({ agentName: 'gone' }, agents)).toBe('claude')
  // A member names nothing in a single chat: its agent decides.
  expect(chatEngine({ agentName: 'x' }, agents, 'y')).toBe('codex')
  const group = { members: ['x', 'y'] } as any
  // The room as a whole (its moderator, the CLI it needs to route) is Claude's.
  expect(chatEngine({ agentName: '', group }, agents)).toBe('claude')
  expect(chatEngine({ agentName: 'x', group }, agents)).toBe('claude')
  expect(chatEngine({ agentName: '', group }, agents, 'x')).toBe('codex')
  expect(chatEngine({ agentName: '', group }, agents, 'y')).toBe('claude')
  expect(chatEngine({ agentName: '', group }, agents, 'gone')).toBe('claude')
})

test('CODEX_REFUSALS copy', () => {
  expect(CODEX_REFUSALS.btw).toBe('Side questions are not available for Codex agents yet.')
  expect(CODEX_REFUSALS.pause).toBe('Pause is not available for Codex agents yet.')
  expect(CODEX_REFUSALS.room('Bo')).toBe("Bo runs on Codex, and Codex agents can't join a room yet.")
  expect(CODEX_REFUSALS.notFound).toBe('Codex CLI not found. Install it and run `codex login` on this machine.')
  expect(CODEX_REFUSALS.signedOut).toBe('Codex is not signed in on this machine. Run `codex login` in a terminal.')
  // Phase 1's, back for a compact flag turned off.
  expect(CODEX_REFUSALS.compact).toBe('Compact is not available for Codex agents yet.')
  expect(CODEX_REFUSALS.threadGone).toBe('The Codex thread to answer from is gone.')
})

test('CODEX_REFUSALS.forkIgnored names Codex and its version when known, never Claude Code or --fork-session', () => {
  const named = CODEX_REFUSALS.forkIgnored('0.164.0')
  expect(named).toBe(
    "Codex 0.164.0 did not fork the thread, so this reply was stopped before it could change an earlier version's memory. Edit, Resend, Fork and switching versions need an update for this Codex version."
  )
  expect(CODEX_REFUSALS.forkIgnored(undefined)).toBe(named.replace('Codex 0.164.0', 'Codex'))
  expect(named).not.toMatch(/Claude|--fork-session/)
})

test('unguardedNoticeText names only what the hookless run lost', () => {
  const all = unguardedNoticeText({ vault: true, keys: true, pause: true })
  expect(all).toBe(
    "Codex didn't confirm ZumiBot's hooks, so this reply runs without the vault guard or the agent's API keys, and Pause takes effect only when it ends."
  )
  // The stored kind's default is the full text.
  expect(NOTICE_TEXT.unguarded).toBe(all)
  // No keys granted: none to lose.
  expect(unguardedNoticeText({ vault: true, keys: false, pause: true })).toBe(
    "Codex didn't confirm ZumiBot's hooks, so this reply runs without the vault guard, and Pause takes effect only when it ends."
  )
  expect(unguardedNoticeText({ vault: true, keys: true, pause: false })).toBe(
    "Codex didn't confirm ZumiBot's hooks, so this reply runs without the vault guard or the agent's API keys."
  )
  expect(unguardedNoticeText({ vault: true, keys: false, pause: false })).toBe(
    "Codex didn't confirm ZumiBot's hooks, so this reply runs without the vault guard."
  )
  // Keys ride only beside the vault guard: without it there were none to lose.
  expect(unguardedNoticeText({ vault: false, keys: true, pause: true })).toBe(
    "Codex didn't confirm ZumiBot's hooks, so Pause takes effect only when this reply ends."
  )
  expect(unguardedNoticeText({ vault: false, keys: false, pause: false })).toBe(
    "Codex didn't confirm ZumiBot's hooks, so this reply runs without them."
  )
})

test('unguardedNoticeText names a room member', () => {
  expect(unguardedNoticeText({ vault: true, keys: true, pause: true, member: 'Code Smith' })).toBe(
    "Codex didn't confirm ZumiBot's hooks, so Code Smith's reply runs without the vault guard or the agent's API keys, and Pause takes effect only when it ends."
  )
  expect(unguardedNoticeText({ vault: false, keys: false, pause: true, member: 'Code Smith' })).toBe(
    "Codex didn't confirm ZumiBot's hooks, so Pause takes effect only when Code Smith's reply ends."
  )
})

test('only Claude agents get background processes: a Codex start card could not be forced', () => {
  expect(engineCaps('claude').processes).toBe(true)
  expect(engineCaps('codex').processes).toBe(false)
})

test('parseProvider: only an exact known engine name, never claude or a near miss', () => {
  expect(parseProvider('codex')).toBe('codex')
  expect(parseProvider('acp')).toBe('acp')
  expect(parseProvider('ag-ui')).toBe('ag-ui')
  for (const v of [
    'Codex',
    'codex ',
    'claude',
    '',
    undefined,
    null,
    1,
    'constructor',
    '__proto__',
    'ACP',
    'acp ',
    'AG-UI',
    'ag-ui ',
    'agui',
    'ag_ui'
  ])
    expect(parseProvider(v)).toBeNull()
})

test('sessionMark and markEngine: Claude is the absent mark, every other engine marks itself', () => {
  expect(sessionMark('claude')).toBeUndefined()
  expect(sessionMark('codex')).toBe('codex')
  expect(markEngine(undefined)).toBe('claude')
  expect(markEngine('codex')).toBe('codex')
  expect(providerOf('claude')).toBeNull()
  expect(providerOf('codex')).toBe('codex')
})

test('ENGINES lists every engine once, with its label', () => {
  expect(ENGINES).toEqual(['claude', 'codex', 'acp', 'ag-ui'])
  expect(ENGINES.map((e) => ENGINE_LABEL[e])).toEqual(['Claude', 'Codex', 'ACP', 'AG-UI'])
})

test("engineCaps: ACP has only files, rooms and questions (the design's column)", () => {
  const caps = engineCaps('acp')
  expect(Object.keys(caps).length).toBe(21)
  expect(
    Object.entries(caps)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort()
  ).toEqual(['files', 'questions', 'rooms'])
})

test('ACP: its own refusal sentences, a mark of its own, and no model picked by hand', () => {
  expect(capRefusal('acp', 'btw')).toBe('Side questions are not available for ACP agents.')
  expect(capRefusal('acp', 'compact')).toBe('Compact is not available for ACP agents.')
  expect(capRefusal('acp', 'pause')).toBe('Pause is not available for ACP agents.')
  expect(roomRefusal('acp', 'Gem')).toBe("Gem runs on an ACP agent, and it can't join a room.")
  for (const text of [capRefusal('acp', 'btw'), roomRefusal('acp', 'Gem')]) expect(text).not.toMatch(/Codex|Claude/)
  expect(sessionMark('acp')).toBe('acp')
  expect(markEngine('acp')).toBe('acp')
  expect(providerOf('acp')).toBe('acp')
  expect(engineOfAgent({ provider: 'acp' })).toBe('acp')
  for (const m of ['opus', 'gpt-5', 'gemini-2.5-pro']) expect(modelFits('acp', m)).toBe(false)
})

test('engineOfAgent ignores a provider value no engine has', () => {
  expect(engineOfAgent({ provider: 'nope' as unknown as 'codex' })).toBe('claude')
})

test('byEngine: a stored name no engine has gets the fallback, never a prototype member', () => {
  const table = { claude: 1, codex: 2, acp: 3, 'ag-ui': 4 }
  expect(byEngine(table, 'codex', 0)).toBe(2)
  for (const name of ['toString', 'constructor', '__proto__', 'gemini']) expect(byEngine(table, name, 0)).toBe(0)
  expect(engineCaps('toString' as 'claude')).toEqual(engineCaps('claude'))
})

test('resend, fork, spend caps and bridges: a fixed sentence per engine, naming the agent where there is one', () => {
  expect(capRefusal('acp', 'resend')).toBe('Edit, Resend and switching versions are not available for ACP agents.')
  expect(capRefusal('acp', 'fork')).toBe('Fork is not available for ACP agents.')
  expect(capRefusal('codex', 'resend')).toMatch(/Codex/)
  expect(capRefusal('claude', 'fork')).not.toMatch(/Codex|ACP/)
  expect(spendCapRefusal('acp', 'Gem')).toBe("Gem is an ACP agent, whose cost may not be in dollars, so a spend cap can't hold for it.")
  expect(bridgeRefusal('acp', 'Gem')).toBe(
    "Gem is an ACP agent and gets none of ZumiBot's to-do, vault, ask or browser tools, so it can't be given cards."
  )
  for (const engine of ENGINES)
    for (const text of [spendCapRefusal(engine, 'Gem'), bridgeRefusal(engine, 'Gem')]) expect(text).toContain('Gem')
  // The ACP sentences name no other engine.
  for (const text of [capRefusal('acp', 'resend'), capRefusal('acp', 'fork'), spendCapRefusal('acp', 'Gem'), bridgeRefusal('acp', 'Gem')])
    expect(text).not.toMatch(/Codex|Claude(?!Bot)/)
})

test('/todo: a sentence of its own per engine, naming the agent, never the card sentence', () => {
  expect(todoRefusal('acp', 'Gem')).toBe(
    "Gem is an ACP agent and gets none of ZumiBot's to-do tools, so /todo and commands that make to-dos can't be used with it."
  )
  expect(todoRefusal('ag-ui', 'Rem')).toBe(
    "Rem is a remote agent and gets none of ZumiBot's to-do tools, so /todo and commands that make to-dos can't be used with it."
  )
  for (const engine of ENGINES) {
    expect(todoRefusal(engine, 'Gem')).toContain('Gem')
    expect(todoRefusal(engine, 'Gem')).not.toBe(bridgeRefusal(engine, 'Gem'))
    expect(todoRefusal(engine, 'Gem')).not.toMatch(/cards/)
  }
  for (const engine of ['acp', 'ag-ui'] as const) expect(todoRefusal(engine, 'Gem')).not.toMatch(/Codex|Claude(?!Bot)/)
})

test("engineCaps: AG-UI has only questions, resend, fork and remote (the design's column)", () => {
  const caps = engineCaps('ag-ui')
  expect(Object.keys(caps).length).toBe(21)
  expect(
    Object.entries(caps)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort()
  ).toEqual(['fork', 'questions', 'remote', 'resend'])
  // Only AG-UI runs outside this machine.
  expect(ENGINES.filter((e) => engineCaps(e).remote)).toEqual(['ag-ui'])
})

test('AG-UI: its own refusal sentences, a mark of its own, and no model picked by hand', () => {
  expect(capRefusal('ag-ui', 'btw')).toBe(AGUI_REFUSALS.btw)
  expect(capRefusal('ag-ui', 'compact')).toBe('Compact is not available for remote agents.')
  expect(capRefusal('ag-ui', 'pause')).toBe('Pause is not available for remote agents.')
  expect(capRefusal('ag-ui', 'resend')).toBe('Edit, Resend and switching versions are not available for remote agents.')
  expect(capRefusal('ag-ui', 'fork')).toBe('Fork is not available for remote agents.')
  expect(roomRefusal('ag-ui', 'Rem')).toBe("Rem is a remote agent, and it can't join a room.")
  expect(spendCapRefusal('ag-ui', 'Rem')).toBe("Rem runs on a remote server that reports no cost, so a spend cap can't hold for it.")
  expect(bridgeRefusal('ag-ui', 'Rem')).toBe(
    "Rem is a remote agent and gets none of ZumiBot's to-do, vault, ask or browser tools, so it can't be given cards."
  )
  const texts = [
    ...(['btw', 'compact', 'pause', 'resend', 'fork'] as const).map((c) => capRefusal('ag-ui', c)),
    roomRefusal('ag-ui', 'Rem'),
    spendCapRefusal('ag-ui', 'Rem'),
    bridgeRefusal('ag-ui', 'Rem')
  ]
  for (const text of texts) expect(text).not.toMatch(/Codex|ACP|Claude(?!Bot)/)
  expect(sessionMark('ag-ui')).toBe('ag-ui')
  expect(markEngine('ag-ui')).toBe('ag-ui')
  expect(providerOf('ag-ui')).toBe('ag-ui')
  expect(engineOfAgent({ provider: 'ag-ui' })).toBe('ag-ui')
  for (const m of ['opus', 'gpt-5', 'gemini-2.5-pro']) expect(modelFits('ag-ui', m)).toBe(false)
  // A remote agent's notice carries its own text; the kind's stand-in names nothing local.
  expect(NOTICE_TEXT.remote).toMatch(/remote agent/)
})

test('isolation: only Claude has the cap; every other engine gets a fixed refusal per level, Codex word for word as before', () => {
  expect(ENGINES.filter((e) => engineCaps(e).isolation)).toEqual(['claude'])
  expect(isolationRefusal('codex', 'sandbox')).toBe('Sandboxed isolation is not available for Codex agents yet.')
  expect(isolationRefusal('codex', 'container')).toBe('Container isolation is not available for Codex agents yet.')
  expect(isolationRefusal('codex', null)).toBe('Isolation is not available for Codex agents yet.')
  for (const engine of ['acp', 'ag-ui'] as const) {
    for (const level of ['sandbox', 'container'] as const) {
      expect(isolationRefusal(engine, level)).toMatch(/not available/)
      expect(isolationRefusal(engine, level)).toMatch(/the run was not started/)
      expect(isolationRefusal(engine, level)).not.toMatch(/Codex|Claude(?!Bot)/)
    }
    expect(isolationRefusal(engine, null)).not.toMatch(/Codex|Claude(?!Bot)/)
  }
  expect(isolationRefusal('acp', 'sandbox')).toMatch(/^Sandboxed isolation is not available for ACP agents/)
  expect(isolationRefusal('ag-ui', 'container')).toMatch(/^Container isolation is not available for remote agents/)
})

test('commentAskRefusal: an agent without bridges answers no comment, named by engine', () => {
  expect(commentAskRefusal('acp', 'Gem')).toBe(
    "Gem is an ACP agent and gets none of ZumiBot's to-do tools, so it can't answer comments on a card."
  )
  expect(commentAskRefusal('ag-ui', 'Rem')).toBe(
    "Rem is a remote agent and gets none of ZumiBot's to-do tools, so it can't answer comments on a card."
  )
})
