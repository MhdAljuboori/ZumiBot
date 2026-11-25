import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../src/net/rpc'
import { createApi } from '../../src/net/api'

function fakeRpc() {
  const subs = new Map<string, (p: never) => void>()
  const rpc: RpcClient = {
    call: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event, cb) => {
      subs.set(event, cb)
      return () => subs.delete(event)
    }),
    onStatus: vi.fn(() => () => {}),
    status: () => 'connected'
  }
  return { rpc, subs }
}

const make = (
  rpc: RpcClient,
  fetchImpl: typeof fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as never,
  assign = vi.fn()
) =>
  createApi(rpc, {
    fetch: fetchImpl,
    desktop: null,
    openWindow: vi.fn(),
    folderPicker: () => Promise.reject(new Error('not implemented')),
    assignLocation: assign
  })

describe('createApi', () => {
  it('app.setTimeZone maps to app:setTimeZone', async () => {
    const { rpc } = fakeRpc(),
      api = make(rpc)
    await api.app.setTimeZone('Europe/Istanbul')
    expect(rpc.call).toHaveBeenCalledWith('app:setTimeZone', ['Europe/Istanbul'])
  })
  it('processes.run maps to processes:run with the chat, the message and the command', async () => {
    const { rpc } = fakeRpc(),
      api = make(rpc)
    await api.processes.run('c1', 'm1', 'ls -la')
    expect(rpc.call).toHaveBeenCalledWith('processes:run', ['c1', 'm1', 'ls -la'])
  })
  it('btw maps calls and forwards changed entries with unsubscribe', async () => {
    const { rpc, subs } = fakeRpc(),
      api = make(rpc)
    await api.btw.ask('chat', 'why?', 'side')
    await api.btw.list('chat')
    await api.btw.stop('chat', 'side')
    await api.btw.again('chat', 'side')
    expect(rpc.call).toHaveBeenNthCalledWith(1, 'btw:ask', ['chat', 'why?', 'side'])
    expect(rpc.call).toHaveBeenNthCalledWith(2, 'btw:list', ['chat'])
    expect(rpc.call).toHaveBeenNthCalledWith(3, 'btw:stop', ['chat', 'side'])
    expect(rpc.call).toHaveBeenNthCalledWith(4, 'btw:again', ['chat', 'side'])
    const cb = vi.fn(),
      off = api.btw.onChanged(cb),
      payload = { chatId: 'chat', entry: { id: 'side' } }
    subs.get('btw:changed')!(payload as never)
    expect(cb).toHaveBeenCalledWith(payload)
    off()
    expect(subs.has('btw:changed')).toBe(false)
  })

  it('todos maps its calls and forwards every changed event, even at the same rev', async () => {
    const { rpc, subs } = fakeRpc(),
      api = make(rpc)
    await api.todos.board()
    await api.todos.list('c')
    await api.todos.check(['a', 'b'], true)
    await api.todos.remove(['a'])
    await api.todos.restore(['a'])
    await api.todos.add('Buy milk', 'c')
    await api.todos.add('Renew the passport', null)
    await api.todos.move('a', 'mine')
    expect(rpc.call.mock.calls).toEqual([
      ['todos:board', []],
      ['todos:list', ['c']],
      ['todos:check', [['a', 'b'], true]],
      ['todos:remove', [['a']]],
      ['todos:restore', [['a']]],
      ['todos:add', ['Buy milk', 'c']],
      ['todos:add', ['Renew the passport', null]],
      ['todos:move', ['a', 'mine']]
    ])
    const cb = vi.fn(),
      off = api.todos.onChanged(cb)
    subs.get('todos:changed')!({ rev: 3 } as never)
    subs.get('todos:changed')!({ rev: 3 } as never)
    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenCalledWith(3)
    off()
    expect(subs.has('todos:changed')).toBe(false)
  })

  it('extensions map each call to its "extensions:*" RPC, optional arguments as null, and onChanged takes no payload', async () => {
    const { rpc, subs } = fakeRpc(),
      api = make(rpc)
    const server = { command: 'x', env: { A: null } }
    const hook = { event: 'Stop', matcher: '', command: 'a.sh' }
    await api.extensions.loadout('/w', null)
    await api.extensions.loadout('/w', 'dev', true)
    await api.extensions.server('/w', 'user', 'gh')
    await api.extensions.saveServer('/w', 'project', 'gh', server)
    await api.extensions.saveServer('/w', 'local', 'gh2', server, 'gh', 'abc')
    await api.extensions.removeServer('/w', 'user', 'gh')
    await api.extensions.setPlugin('p@m', false)
    await api.extensions.skill('user', '/w', 's')
    await api.extensions.saveSkill('project', '/w', { name: 's', description: 'd', body: 'b' })
    await api.extensions.removeSkill('user', '/w', 's')
    await api.extensions.setSkill('s', true)
    await api.extensions.saveHook('local', '/w', hook, null)
    await api.extensions.removeHook('user', '/w', 'Stop', { group: 0, hook: 1 }, 'abc')
    expect((rpc.call as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['extensions:loadout', ['/w', null, false]],
      ['extensions:loadout', ['/w', 'dev', true]],
      ['extensions:server', ['/w', 'user', 'gh']],
      ['extensions:saveServer', ['/w', 'project', 'gh', server, null, null]],
      ['extensions:saveServer', ['/w', 'local', 'gh2', server, 'gh', 'abc']],
      ['extensions:removeServer', ['/w', 'user', 'gh']],
      ['extensions:setPlugin', ['p@m', false]],
      ['extensions:skill', ['user', '/w', 's']],
      ['extensions:saveSkill', ['project', '/w', { name: 's', description: 'd', body: 'b' }]],
      ['extensions:removeSkill', ['user', '/w', 's']],
      ['extensions:setSkill', ['s', true]],
      ['extensions:saveHook', ['local', '/w', hook, null]],
      ['extensions:removeHook', ['user', '/w', 'Stop', { group: 0, hook: 1 }, 'abc']]
    ])
    const cb = vi.fn(),
      off = api.extensions.onChanged(cb)
    subs.get('extensions:changed')!(null as never)
    expect(cb).toHaveBeenCalledWith()
    off()
    expect(subs.has('extensions:changed')).toBe(false)
  })

  it('approvals.list and remove forward to "approvals:list" and "approvals:remove"', async () => {
    const { rpc } = fakeRpc()
    await make(rpc).approvals.list('a')
    expect(rpc.call).toHaveBeenCalledWith('approvals:list', ['a'])
    await make(rpc).approvals.remove('a', 'k')
    expect(rpc.call).toHaveBeenCalledWith('approvals:remove', ['a', 'k'])
  })

  it('approvals.onChanged subscribes to "approvals:changed" and passes the agent', () => {
    const { rpc, subs } = fakeRpc()
    const cb = vi.fn()
    make(rpc).approvals.onChanged(cb)
    subs.get('approvals:changed')!({ agent: 'a' } as never)
    expect(cb).toHaveBeenCalledWith('a')
  })

  it('chats room clone methods forward their args in order', async () => {
    const { rpc } = fakeRpc()
    await make(rpc).chats.summarizeRoom('c1')
    expect(rpc.call).toHaveBeenLastCalledWith('chats:summarizeRoom', ['c1'])
    await make(rpc).chats.cancelSummary('c1')
    expect(rpc.call).toHaveBeenLastCalledWith('chats:cancelSummary', ['c1'])
    await make(rpc).chats.cloneRoom('c1', 'Next', 'text')
    expect(rpc.call).toHaveBeenLastCalledWith('chats:cloneRoom', ['c1', 'Next', 'text'])
    await make(rpc).chats.cloneRoom('c1', 'Next', null)
    expect(rpc.call).toHaveBeenLastCalledWith('chats:cloneRoom', ['c1', 'Next', null])
  })

  it('chats.answerQuestions forwards to "chats:answerQuestions" with the agent left undefined', async () => {
    const { rpc } = fakeRpc()
    await make(rpc).chats.answerQuestions('c', 'r', null)
    expect(rpc.call).toHaveBeenCalledWith('chats:answerQuestions', ['c', 'r', null, undefined])
  })

  it('chats.answerPlan forwards to "chats:answerPlan"', async () => {
    const { rpc } = fakeRpc()
    await make(rpc).chats.answerPlan('c', 'r', false, 'more')
    expect(rpc.call).toHaveBeenCalledWith('chats:answerPlan', ['c', 'r', false, 'more', undefined])
  })

  it('routines.save forwards the input to "routines:save"', async () => {
    const { rpc } = fakeRpc()
    const input = {
      id: null,
      name: 'n',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      target: { kind: 'chat', chatId: 'c' },
      prompt: 'p'
    } as const
    await make(rpc).routines.save(input)
    expect(rpc.call).toHaveBeenCalledWith('routines:save', [input])
    await make(rpc).routines.webhook('r1')
    expect(rpc.call).toHaveBeenCalledWith('routines:webhook', ['r1'])
    await make(rpc).routines.draftWebhook()
    expect(rpc.call).toHaveBeenCalledWith('routines:draftWebhook', [])
  })

  it('routines.onChanged subscribes to "routines:changed" and passes the snapshot', () => {
    const { rpc, subs } = fakeRpc()
    const cb = vi.fn()
    make(rpc).routines.onChanged(cb)
    subs.get('routines:changed')!({ routines: [], runs: {} } as never)
    expect(cb).toHaveBeenCalledWith({ routines: [], runs: {} })
  })

  it('workflows map each call to its "workflows:*" RPC and onChanged passes the snapshot', async () => {
    const { rpc, subs } = fakeRpc(),
      api = make(rpc)
    const input = { id: null, name: 'n', enabled: false, timeZone: 'UTC', trigger: { kind: 'manual' }, steps: [], edges: [] } as const
    await api.workflows.list()
    await api.workflows.getRun('r1')
    await api.workflows.save(input)
    await api.workflows.remove('w1')
    await api.workflows.setEnabled('w1', true)
    await api.workflows.run('w1', 'hi')
    await api.workflows.stop('r1')
    await api.workflows.retry('r1', 'v1')
    await api.workflows.approve('r1', 'v1', true, 'text', 'note')
    await api.workflows.testStep(input, 's1', 'in')
    await api.workflows.webhook('w1')
    await api.workflows.newSecret('w1')
    expect((rpc.call as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['workflows:list', []],
      ['workflows:getRun', ['r1']],
      ['workflows:save', [input]],
      ['workflows:remove', ['w1']],
      ['workflows:setEnabled', ['w1', true]],
      ['workflows:run', ['w1', 'hi']],
      ['workflows:stop', ['r1']],
      ['workflows:retry', ['r1', 'v1']],
      ['workflows:approve', ['r1', 'v1', true, 'text', 'note']],
      ['workflows:testStep', [input, 's1', 'in']],
      ['workflows:webhook', ['w1']],
      ['workflows:newSecret', ['w1']]
    ])
    const cb = vi.fn(),
      off = api.workflows.onChanged(cb)
    subs.get('workflows:changed')!({ workflows: [], runs: {} } as never)
    expect(cb).toHaveBeenCalledWith({ workflows: [], runs: {} })
    off()
    expect(subs.has('workflows:changed')).toBe(false)
  })

  it('chats.items forwards (chatId, before, until) to "chats:items"', async () => {
    const { rpc } = fakeRpc()
    await make(rpc).chats.items('c1', 'u9')
    expect(rpc.call).toHaveBeenCalledWith('chats:items', ['c1', 'u9', undefined])
    await make(rpc).chats.items('c1', undefined, 'u2')
    expect(rpc.call).toHaveBeenLastCalledWith('chats:items', ['c1', undefined, 'u2'])
  })

  it('chats.search forwards (query, offset) to "chats:search"', async () => {
    const { rpc } = fakeRpc()
    await make(rpc).chats.search('deploy', 30)
    expect(rpc.call).toHaveBeenCalledWith('chats:search', ['deploy', 30])
  })

  it('chats.send forwards (chatId, text, ids, replyTo, messageId, command) to "chats:send"', async () => {
    const { rpc } = fakeRpc()
    await make(rpc).chats.send('c1', 'hi', ['a'], 'm1', 'u1')
    expect(rpc.call).toHaveBeenCalledWith('chats:send', ['c1', 'hi', ['a'], 'm1', 'u1', undefined])
    await make(rpc).chats.send('c1', '/check L', [], undefined, 'u2', { agent: 'wk', name: 'check' })
    expect(rpc.call).toHaveBeenLastCalledWith('chats:send', ['c1', '/check L', [], undefined, 'u2', { agent: 'wk', name: 'check' }])
  })

  it('agents.onChanged subscribes to agents:changed and defaults to []', () => {
    const { rpc, subs } = fakeRpc()
    const cb = vi.fn()
    make(rpc).agents.onChanged(cb)
    subs.get('agents:changed')!(undefined as never)
    expect(cb).toHaveBeenCalledWith([])
  })

  it('session.signOutEverywhere posts /api/logout-all', async () => {
    const { rpc } = fakeRpc()
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const assign = vi.fn()
    await make(rpc, f as never, assign).session.signOutEverywhere()
    expect(f).toHaveBeenCalledWith('/api/logout-all', { method: 'POST' })
    expect(assign).toHaveBeenCalledWith('/login')
  })

  it('session.signOut posts /api/logout and mode uses app:mode', async () => {
    const { rpc } = fakeRpc()
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const api = make(rpc, f as never)
    await api.session.signOut()
    expect(f).toHaveBeenCalledWith('/api/logout', { method: 'POST' })
    await api.session.mode()
    expect(rpc.call).toHaveBeenCalledWith('app:mode', [])
  })

  it('app.pickFolder asks app:folderStart then the folder picker', async () => {
    const { rpc } = fakeRpc()
    ;(rpc.call as ReturnType<typeof vi.fn>).mockResolvedValue({ fixed: false, path: '/home' })
    const picker = vi.fn().mockResolvedValue('/home/x')
    const api = createApi(rpc, { fetch: vi.fn() as never, desktop: null, openWindow: vi.fn(), folderPicker: picker })
    expect(await api.app.pickFolder('a')).toBe('/home/x')
    expect(rpc.call).toHaveBeenCalledWith('app:folderStart', ['a'])
    expect(picker).toHaveBeenCalledWith('/home')
  })

  it('app.pickFolder skips the picker when the folder is fixed', async () => {
    const { rpc } = fakeRpc()
    ;(rpc.call as ReturnType<typeof vi.fn>).mockResolvedValue({ fixed: true, path: '/fixed' })
    const picker = vi.fn()
    const api = createApi(rpc, { fetch: vi.fn() as never, desktop: null, openWindow: vi.fn(), folderPicker: picker })
    expect(await api.app.pickFolder(null)).toBe('/fixed')
    expect(picker).not.toHaveBeenCalled()
  })

  it('attachments.open answers false when the HEAD says 404', async () => {
    const { rpc } = fakeRpc()
    const open = vi.fn()
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 404 }))
    const api = createApi(rpc, { fetch: f as never, desktop: null, openWindow: open, folderPicker: vi.fn() })
    expect(await api.attachments.open('c1', 'a1', 'x.png')).toBe(false)
    expect(f).toHaveBeenCalledWith('/api/attachments/chat/c1/a1', { method: 'HEAD' })
    expect(open).not.toHaveBeenCalled()
  })

  it('attachments.open opens a window in the browser and the bridge in the desktop shell', async () => {
    const { rpc } = fakeRpc()
    const ok = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const open = vi.fn()
    expect(
      await createApi(rpc, { fetch: ok as never, desktop: null, openWindow: open, folderPicker: vi.fn() }).attachments.open(
        'c1',
        'a1',
        'x.png'
      )
    ).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    const desktop = { openAttachment: vi.fn().mockResolvedValue(true) }
    const api = createApi(rpc, { fetch: ok as never, desktop: desktop as never, openWindow: open, folderPicker: vi.fn() })
    expect(await api.attachments.open('c1', 'a1', 'x.png')).toBe(true)
    expect(desktop.openAttachment).toHaveBeenCalledWith(expect.stringContaining('a1'), 'x.png')
  })

  it('app.setEditorDirty guards the tab in the browser and forwards to the desktop shell', () => {
    const { rpc } = fakeRpc()
    const guard = vi.fn()
    createApi(rpc, {
      fetch: vi.fn() as never,
      desktop: null,
      openWindow: vi.fn(),
      folderPicker: vi.fn(),
      setBeforeUnload: guard
    }).app.setEditorDirty(true)
    expect(guard).toHaveBeenLastCalledWith(expect.any(Function))
    const api = createApi(rpc, {
      fetch: vi.fn() as never,
      desktop: null,
      openWindow: vi.fn(),
      folderPicker: vi.fn(),
      setBeforeUnload: guard
    })
    api.app.setEditorDirty(false)
    expect(guard).toHaveBeenLastCalledWith(null)
    const desktop = { setEditorDirty: vi.fn() }
    createApi(rpc, {
      fetch: vi.fn() as never,
      desktop: desktop as never,
      openWindow: vi.fn(),
      folderPicker: vi.fn(),
      setBeforeUnload: guard
    }).app.setEditorDirty(true)
    expect(desktop.setEditorDirty).toHaveBeenCalledWith(true)
  })
})

it('browser status and explicit clear use ordinary RPC without opening a viewer', async () => {
  const { rpc } = fakeRpc()
  await make(rpc).browsers.status('helper')
  expect(rpc.call).toHaveBeenCalledWith('browsers:status', ['helper'])
  await make(rpc).browsers.clear('helper')
  expect(rpc.call).toHaveBeenCalledWith('browsers:clear', ['helper'])
})

it('desktop status and explicit clear use ordinary RPC', async () => {
  const { rpc } = fakeRpc()
  await make(rpc).desktops.status('helper')
  expect(rpc.call).toHaveBeenCalledWith('desktops:status', ['helper'])
  await make(rpc).desktops.clear('helper')
  expect(rpc.call).toHaveBeenCalledWith('desktops:clear', ['helper'])
})
