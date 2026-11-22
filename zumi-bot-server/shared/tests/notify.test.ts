import { describe, expect, it } from 'vitest'
import { DEFAULT_TOGGLES, PAYLOAD_KEYS, buildPayload, isPayload, isToggles, mergeAgents, notifyText, slotTag } from '@zumibot/shared/notify'

const pl = (kind: Parameters<typeof buildPayload>[0]['kind'], agent?: string, title = 'Fix login') =>
  buildPayload({ kind, tag: 'chat:c1', chatId: 'c1', title, agent, at: 1 })

describe('slotTag', () => {
  it('gives waiting its own slot per chat', () => {
    expect(slotTag({ kind: 'waiting', chatId: 'c1', routineId: null })).toBe('chat:c1:waiting')
  })
  it('shares one slot for replied, error and routine-failed', () => {
    for (const kind of ['replied', 'error', 'routine-failed'] as const)
      expect(slotTag({ kind, chatId: 'c1', routineId: null })).toBe('chat:c1')
  })
  it('keys by routine when one is given, over the chat', () => {
    expect(slotTag({ kind: 'waiting', chatId: 'c1', routineId: 'r1' })).toBe('routine:r1:waiting')
    expect(slotTag({ kind: 'replied', chatId: 'c1', routineId: 'r1' })).toBe('routine:r1')
    expect(slotTag({ kind: 'routine-failed', chatId: null, routineId: 'r1' })).toBe('routine:r1')
  })
  it('uses the kind for test and paused', () => {
    expect(slotTag({ kind: 'test', chatId: null, routineId: null })).toBe('test')
    expect(slotTag({ kind: 'paused', chatId: null, routineId: null })).toBe('paused')
  })
})

describe('slotTag for workflows', () => {
  it('slotTag for workflow run', () => {
    expect(slotTag({ kind: 'workflow', chatId: null, routineId: null, runId: 'r9' })).toBe('workflow:r9')
    expect(slotTag({ kind: 'waiting', chatId: null, routineId: null, runId: 'r9' })).toBe('workflow:r9:waiting')
    expect(slotTag({ kind: 'routine-failed', chatId: null, routineId: null, runId: 'r9' })).toBe('workflow:r9')
  })
})

describe('buildPayload', () => {
  it('buildPayload keeps run and cuts body to 200', () => {
    const p = buildPayload({
      kind: 'workflow',
      tag: 'workflow:r1',
      chatId: null,
      title: 'T',
      at: 1,
      run: { workflowId: 'w1', runId: 'r1' },
      body: 'b'.repeat(900)
    })
    expect(p.run).toEqual({ workflowId: 'w1', runId: 'r1' })
    expect(p.body).toHaveLength(200)
    expect(isPayload(JSON.parse(JSON.stringify(p)))).toBe(true)
    expect(JSON.stringify(p).length).toBeLessThan(3993)
    expect('body' in pl('error')).toBe(false)
    expect('run' in pl('error')).toBe(false)
  })

  it('cuts title and agent to 100 characters', () => {
    const p = pl('replied', 'y'.repeat(500), 'x'.repeat(500))
    expect(p.title).toHaveLength(100)
    expect(p.agent).toHaveLength(100)
  })
  it('omits agent when undefined and keeps only known keys', () => {
    const p = pl('error')
    expect('agent' in p).toBe(false)
    for (const k of Object.keys(pl('error', 'news'))) expect(PAYLOAD_KEYS).toContain(k)
    expect(p.v).toBe(1)
  })
  it('always fits one 4096-byte push record', () => {
    const p = pl('replied', 'y'.repeat(5000), 'x'.repeat(5000))
    expect(JSON.stringify(p).length).toBeLessThan(3993)
  })
})

describe('notifyText', () => {
  it('writes the copy for each kind', () => {
    expect(notifyText(pl('waiting', 'news'))).toEqual({ title: 'Fix login', body: 'News needs you' })
    expect(notifyText(pl('replied', 'news'), ['writer', 'news']).body).toBe('Writer, News replied')
    expect(notifyText(pl('error', 'news')).body).toBe("News's reply ended with an error")
    expect(notifyText(pl('routine-failed')).body).toBe('Routine failed')
    expect(notifyText(pl('test')).body).toBe('Notifications work on this device')
    expect(notifyText(buildPayload({ kind: 'paused', tag: 'paused', chatId: null, title: 'ZumiBot', at: 1 }))).toEqual({
      title: 'ZumiBot',
      body: 'Signed out. Notifications are paused until you sign in again.'
    })
  })
  it('a failed workflow run reads Workflow failed, a routine Routine failed', () => {
    const p = buildPayload({
      kind: 'routine-failed',
      tag: 'workflow:r1',
      chatId: null,
      title: 'Release flow',
      at: 1,
      run: { workflowId: 'w1', runId: 'r1' }
    })
    expect(notifyText(p)).toEqual({ title: 'Release flow', body: 'Workflow failed' })
    expect(notifyText(pl('routine-failed')).body).toBe('Routine failed')
  })
  it('notifyText workflow returns body', () => {
    const p = buildPayload({
      kind: 'workflow',
      tag: 'workflow:r1',
      chatId: null,
      title: 'Done',
      at: 1,
      run: { workflowId: 'w1', runId: 'r1' },
      body: 'All 3 files synced'
    })
    expect(notifyText(p)).toEqual({ title: 'Done', body: 'All 3 files synced' })
    expect(notifyText({ ...p, body: undefined })).toEqual({ title: 'Done', body: '' })
  })
  it('names agents as the UI does, not by their file handle', () => {
    expect(notifyText(pl('waiting', 'work-assistant')).body).toBe('Work Assistant needs you')
    expect(notifyText(pl('replied', 'news'), ['work-assistant', 'news']).body).toBe('Work Assistant, News replied')
  })
  it('falls back when there is no agent', () => {
    expect(notifyText(pl('waiting')).body).toBe('An agent needs you')
    expect(notifyText(pl('replied')).body).toBe('An agent replied')
  })
})

describe('mergeAgents', () => {
  it('appends new names once', () => {
    expect(mergeAgents(['writer'], 'news')).toEqual(['writer', 'news'])
    expect(mergeAgents(['news'], 'news')).toEqual(['news'])
    expect(mergeAgents(undefined, undefined)).toEqual([])
  })
})

describe('validators', () => {
  it('isToggles', () => {
    expect(isToggles(DEFAULT_TOGGLES)).toBe(true)
    expect(isToggles({ waiting: true, replied: true, error: true })).toBe(false)
    expect(isToggles({ ...DEFAULT_TOGGLES, error: 'yes' })).toBe(false)
    expect(isToggles(null)).toBe(false)
  })
  it('isPayload round-trips and rejects extras', () => {
    const p = pl('replied', 'news')
    expect(isPayload(JSON.parse(JSON.stringify(p)))).toBe(true)
    expect(isPayload(pl('error'))).toBe(true)
    expect(isPayload({ ...p, extra: 1 })).toBe(false)
    expect(isPayload({ ...p, kind: 'nope' })).toBe(false)
    expect(isPayload({ ...p, v: 2 })).toBe(false)
    expect(isPayload(null)).toBe(false)
  })

  it('only a workflow payload carries a message id, and isPayload accepts it', () => {
    const base = { tag: 't', chatId: null, title: 'x', at: 1, message: 'm1' }
    const w = buildPayload({ ...base, kind: 'workflow' })
    expect(w.message).toBe('m1')
    expect(isPayload(JSON.parse(JSON.stringify(w)))).toBe(true)
    expect(buildPayload({ ...base, kind: 'waiting' })).not.toHaveProperty('message')
    expect(isPayload({ ...w, message: 5 })).toBe(false)
  })
})

describe('spend-cap notifications', () => {
  it('carry their amounts as the body, open the chat or the run, and pass the payload check', () => {
    const p = buildPayload({
      kind: 'spend-cap',
      tag: 'cap:routine:r1',
      chatId: 'c1',
      title: 'Daily',
      at: 1,
      body: 'Paused at its spend cap: $2.10 of $2.00.'
    })
    expect(isPayload(p)).toBe(true)
    expect(notifyText(p)).toEqual({ title: 'Daily', body: 'Paused at its spend cap: $2.10 of $2.00.' })
    const run = buildPayload({
      kind: 'spend-cap',
      tag: 'cap:workflow:x',
      chatId: null,
      title: 'Flow',
      at: 1,
      run: { workflowId: 'w', runId: 'x' }
    })
    expect(isPayload(run)).toBe(true)
    expect(notifyText(run).body).toBe('A spend cap paused it')
  })
})

describe('a task card question', () => {
  it('carries inbox on a waiting payload only, reads as a question, and passes the payload check', () => {
    const p = buildPayload({
      kind: 'waiting',
      tag: 'chat:c1:waiting',
      chatId: 'c1',
      title: 'Export the report',
      agent: 'news',
      at: 1,
      inbox: true
    })
    expect(p.inbox).toBe(true)
    expect(notifyText(p)).toEqual({ title: 'Export the report', body: 'News has a question for you' })
    expect(isPayload(JSON.parse(JSON.stringify(p)))).toBe(true)
    expect('inbox' in buildPayload({ kind: 'replied', tag: 'chat:c1', chatId: 'c1', title: 'T', at: 1, inbox: true })).toBe(false)
    expect(isPayload({ ...p, inbox: 'yes' })).toBe(false)
  })
})
