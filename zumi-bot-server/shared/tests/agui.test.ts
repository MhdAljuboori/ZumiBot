import { describe, expect, it } from 'vitest'
import {
  AGUI_API_KEY_NOTE,
  AGUI_STUDIO_TEXT,
  AGUI_TEXT,
  aguiHost,
  aguiLaunchError,
  aguiLaunchRecord,
  authHeaderError,
  parseAguiLaunch,
  parseAguiThread
} from '@zumibot/shared/agui'

const EP = 'https://agents.example.com/run'

describe('parseAguiLaunch', () => {
  it('reads a full launch', () => {
    expect(parseAguiLaunch({ endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY', authHeader: 'Authorization' })).toEqual({
      endpoint: EP,
      authKey: 'EXAMPLE_AGENT_KEY',
      authHeader: 'Authorization'
    })
  })
  it('defaults authKey and authHeader to null', () => {
    expect(parseAguiLaunch({ endpoint: EP })).toEqual({ endpoint: EP, authKey: null, authHeader: null })
    expect(parseAguiLaunch({ endpoint: EP, authKey: null, authHeader: null })).toEqual({ endpoint: EP, authKey: null, authHeader: null })
    expect(parseAguiLaunch({ endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY' })).toEqual({
      endpoint: EP,
      authKey: 'EXAMPLE_AGENT_KEY',
      authHeader: null
    })
  })
  it('keeps http: for the dev hook to judge, and a path and query', () => {
    expect(parseAguiLaunch({ endpoint: 'http://127.0.0.1:8080/run' })).not.toBeNull()
    expect(parseAguiLaunch({ endpoint: 'https://a.example.com:8443/x/y?mode=1' })).not.toBeNull()
  })
  it.each([null, undefined, EP, 3, [], [{ endpoint: EP }], {}, { endpoint: '' }, { endpoint: 4 }, { endpoint: [EP] }])(
    'rejects %j',
    (v) => {
      expect(parseAguiLaunch(v)).toBeNull()
    }
  )
  it.each([
    'https://user@agents.example.com/run',
    'https://user:pw@agents.example.com/run',
    'https://:pw@agents.example.com/run',
    'https://agents.example.com/run#frag',
    'https://agents.example.com/run#',
    'ftp://agents.example.com/run',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'agents.example.com/run',
    '/run',
    'https://',
    'https://agents.example.com/a b',
    ' https://agents.example.com/run',
    'https://agents.example.com/run\n',
    'https://agents.example.com/\trun',
    'https://agents.example.com/\u0001',
    'https://agents.example.com/\u007f',
    'https://agents.example.com/\u0085',
    'https://agents.example.com/\u009f',
    'https://agents.example.com/\0'
  ])('rejects the endpoint %j', (endpoint) => {
    expect(parseAguiLaunch({ endpoint })).toBeNull()
  })
  it('caps the endpoint at 2048 characters', () => {
    const at = (n: number) => `https://a.example.com/${'a'.repeat(n - 'https://a.example.com/'.length)}`
    expect(at(2048)).toHaveLength(2048)
    expect(parseAguiLaunch({ endpoint: at(2048) })).not.toBeNull()
    expect(parseAguiLaunch({ endpoint: at(2049) })).toBeNull()
  })
  it('rejects a bad authKey', () => {
    for (const authKey of ['lower', 'PATH', '', 'A', 4, ['A_B'], true])
      expect(parseAguiLaunch({ endpoint: EP, authKey, authHeader: null }), String(authKey)).toBeNull()
  })
  it('rejects a bad authHeader', () => {
    const key = 'EXAMPLE_AGENT_KEY'
    for (const authHeader of ['', 'X Api Key', 'X-Api-Key:', 'X\nY', 'é', 'a'.repeat(65), 4, ['X-Api-Key']])
      expect(parseAguiLaunch({ endpoint: EP, authKey: key, authHeader }), String(authHeader)).toBeNull()
    expect(parseAguiLaunch({ endpoint: EP, authKey: key, authHeader: 'a'.repeat(64) })).not.toBeNull()
    expect(parseAguiLaunch({ endpoint: EP, authKey: key, authHeader: 'X-Api-Key' })).not.toBeNull()
  })
  it('allows an authHeader only with an authKey', () => {
    expect(parseAguiLaunch({ endpoint: EP, authHeader: 'X-Api-Key' })).toBeNull()
    expect(parseAguiLaunch({ endpoint: EP, authKey: null, authHeader: 'X-Api-Key' })).toBeNull()
  })
})

describe('authHeaderError', () => {
  it.each(['Authorization', 'X-Api-Key', 'api-key', 'X-Auth-Token', 'Ocp-Apim-Subscription-Key', "x!#$%&'*+-.^_`|~9"])(
    'accepts %s',
    (n) => {
      expect(authHeaderError(n)).toBeNull()
    }
  )
  it.each([
    'Host',
    'host',
    'HOST',
    'Content-Type',
    'content-length',
    'CONTENT-ENCODING',
    'Content-',
    'content-x',
    'Connection',
    'Keep-Alive',
    'Proxy-Authenticate',
    'Proxy-Authorization',
    'Proxy-Connection',
    'TE',
    'te',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
    'Accept',
    'accept',
    'ACCEPT-ENCODING',
    'Accept-Encoding'
  ])('refuses %s whatever its case', (n) => {
    expect(authHeaderError(n)).toBe(AGUI_TEXT.authHeaderInvalid(n))
  })
  it('keeps names that only resemble a refused one: only the exact names and Content-* go', () => {
    for (const n of ['Accept-Language', 'Hosted', 'X-Host', 'Contents', 'Tex', 'Upgrade-Insecure-Requests', 'X-Content-Type'])
      expect(authHeaderError(n), n).toBeNull()
  })
  it('refuses a name that is not a token, with no name in the sentence', () => {
    for (const n of ['', 'a b', 'a:b', 'a\r\nb', 'é', 'a'.repeat(65)]) {
      const e = authHeaderError(n)
      expect(e, JSON.stringify(n)).not.toBeNull()
      expect(e).not.toContain('\n')
      if (n !== '') expect(e).not.toContain(n)
    }
  })
})

describe('aguiLaunchError', () => {
  const shapes: unknown[] = [
    null,
    undefined,
    EP,
    3,
    [],
    {},
    { endpoint: '' },
    { endpoint: 4 },
    { endpoint: 'ftp://a.example.com/' },
    { endpoint: 'https://u:p@a.example.com/' },
    { endpoint: 'https://a.example.com/#x' },
    { endpoint: `https://a.example.com/${'a'.repeat(2048)}` },
    { endpoint: 'https://a.example.com/a b' },
    { endpoint: EP, authKey: 'lower' },
    { endpoint: EP, authKey: 4 },
    { endpoint: EP, authHeader: 'X-Api-Key' },
    { endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY', authHeader: 'Host' },
    { endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY', authHeader: 'Content-Type' },
    { endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY', authHeader: 'Accept' },
    { endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY', authHeader: 'X-Api-Key' },
    { endpoint: EP },
    { endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY', authHeader: 'Authorization' },
    { endpoint: 'http://127.0.0.1:8080/run' }
  ]
  it('is null exactly when parseAguiLaunch reads the value', () => {
    for (const v of shapes) expect([v, aguiLaunchError(v) === null]).toEqual([v, parseAguiLaunch(v) !== null])
  })
  it('names what is wrong with a fixed sentence', () => {
    expect(aguiLaunchError(null)).toBe(AGUI_TEXT.endpointRequired)
    expect(aguiLaunchError({})).toBe(AGUI_TEXT.endpointRequired)
    expect(aguiLaunchError({ endpoint: '' })).toBe(AGUI_TEXT.endpointRequired)
    expect(aguiLaunchError({ endpoint: 4 })).toBe(AGUI_TEXT.endpointInvalid)
    expect(aguiLaunchError({ endpoint: 'ftp://a.example.com/' })).toBe(AGUI_TEXT.endpointInvalid)
    expect(aguiLaunchError({ endpoint: 'https://u:p@a.example.com/' })).toBe(AGUI_TEXT.endpointInvalid)
    expect(aguiLaunchError({ endpoint: 'https://a.example.com/#x' })).toBe(AGUI_TEXT.endpointInvalid)
    expect(aguiLaunchError({ endpoint: EP, authKey: 'lower' })).toBe(AGUI_TEXT.authKeyInvalid)
    expect(aguiLaunchError({ endpoint: EP, authHeader: 'X-Api-Key' })).toBe(AGUI_TEXT.authHeaderWithoutKey)
    expect(aguiLaunchError({ endpoint: EP, authKey: 'EXAMPLE_AGENT_KEY', authHeader: 'Host' })).toBe(AGUI_TEXT.authHeaderInvalid('Host'))
  })
  it('never echoes the endpoint, its credentials or its path', () => {
    for (const endpoint of [
      'https://user:secretpw@a.example.com/hidden-path?token=abc',
      'https://a.example.com/hidden-path?token=abc#frag'
    ]) {
      const e = aguiLaunchError({ endpoint }) as string
      for (const leak of ['secretpw', 'hidden-path', 'token', 'abc']) expect(e).not.toContain(leak)
    }
  })
})

describe('aguiLaunchRecord', () => {
  it('is stable whatever the key order, with the keys in a fixed order', () => {
    const a = aguiLaunchRecord({ endpoint: EP, authKey: 'K_X', authHeader: 'X-Api-Key' })
    const b = aguiLaunchRecord({ authHeader: 'X-Api-Key', authKey: 'K_X', endpoint: EP })
    expect(a).toBe(b)
    expect(a).toBe(`{"endpoint":"${EP}","authKey":"K_X","authHeader":"X-Api-Key"}`)
    expect(JSON.parse(a)).toEqual({ endpoint: EP, authKey: 'K_X', authHeader: 'X-Api-Key' })
    expect(aguiLaunchRecord({ endpoint: EP, authKey: null, authHeader: null })).toBe(
      `{"endpoint":"${EP}","authKey":null,"authHeader":null}`
    )
    expect(aguiLaunchRecord({ endpoint: EP, authKey: 'K_X', authHeader: null })).not.toBe(a)
  })
})

describe('aguiHost', () => {
  it('is URL.host: the name and a non-default port, never the path or query', () => {
    expect(aguiHost('https://agents.example.com/run?x=1')).toBe('agents.example.com')
    expect(aguiHost('https://agents.example.com:8443/run')).toBe('agents.example.com:8443')
    expect(aguiHost('https://agents.example.com:443/run')).toBe('agents.example.com')
    expect(aguiHost('https://[::1]:8443/run')).toBe('[::1]:8443')
  })
  it('is null for an address that does not parse', () => {
    expect(aguiHost('')).toBeNull()
    expect(aguiHost('not a url')).toBeNull()
    expect(aguiHost('/run')).toBeNull()
  })
})

describe('parseAguiThread', () => {
  const ok = {
    v: 1,
    threadId: 'abc-123',
    state: { n: 1 },
    interrupts: [
      { id: 'i1', expiresAt: '2026-11-18T10:00:00Z' },
      { id: 'i2', expiresAt: null }
    ]
  }
  it('reads a thread record', () => {
    expect(parseAguiThread(ok)).toEqual(ok)
    expect(parseAguiThread({ v: 1, threadId: 't', state: null, interrupts: [] })).toEqual({
      v: 1,
      threadId: 't',
      state: null,
      interrupts: []
    })
  })
  it('keeps any JSON as the state, and reads an absent state or expiry as null', () => {
    for (const state of [0, '', false, [], [1], 'x', { a: { b: [1] } }]) expect(parseAguiThread({ ...ok, state })?.state).toEqual(state)
    expect(parseAguiThread({ v: 1, threadId: 't', interrupts: [{ id: 'i' }] })).toEqual({
      v: 1,
      threadId: 't',
      state: null,
      interrupts: [{ id: 'i', expiresAt: null }]
    })
  })
  it('drops any key it does not know', () => {
    expect(parseAguiThread({ ...ok, extra: 1, interrupts: [{ id: 'i1', expiresAt: null, payload: { secret: 1 } }] })).toEqual({
      ...ok,
      interrupts: [{ id: 'i1', expiresAt: null }]
    })
  })
  it.each([
    null,
    undefined,
    'x',
    3,
    [],
    {},
    { v: 2, threadId: 't', state: null, interrupts: [] },
    { threadId: 't', state: null, interrupts: [] },
    { v: 1, state: null, interrupts: [] },
    { v: 1, threadId: '', state: null, interrupts: [] },
    { v: 1, threadId: 4, state: null, interrupts: [] },
    { v: 1, threadId: 't', state: null },
    { v: 1, threadId: 't', state: null, interrupts: 'x' },
    { v: 1, threadId: 't', state: null, interrupts: [null] },
    { v: 1, threadId: 't', state: null, interrupts: [{}] },
    { v: 1, threadId: 't', state: null, interrupts: [{ id: '' }] },
    { v: 1, threadId: 't', state: null, interrupts: [{ id: 3 }] },
    { v: 1, threadId: 't', state: null, interrupts: [{ id: 'i', expiresAt: 5 }] }
  ])('rejects %j', (v) => {
    expect(parseAguiThread(v)).toBeNull()
  })
})

describe('AGUI_API_KEY_NOTE', () => {
  it('says a key reaches a remote agent only as its auth key, in one header', () => {
    expect(AGUI_API_KEY_NOTE).toBe('API keys reach a remote agent only as its auth key, in one request header')
  })
})

describe('AGUI_TEXT', () => {
  it("keeps the design's own wording", () => {
    expect(AGUI_TEXT.untrusted).toBe("This agent's endpoint changed outside Agent Studio. Open it in Agent Studio and save to confirm.")
    expect(AGUI_TEXT.cut).toBe('The connection ended before the agent finished.')
    expect(AGUI_TEXT.noTools).toBe('ZumiBot runs no tools for this agent')
    expect(AGUI_TEXT.unreadable).toBe('The agent sent an event ZumiBot could not read.')
    expect(AGUI_TEXT.redirected).toBe('The endpoint redirected to another host')
    expect(AGUI_TEXT.remoteNotice('agents.example.com')).toBe(
      "Runs outside this machine, at agents.example.com. Every message of its chats, and the chat's history, is sent there."
    )
  })
  it('the old-chat sentence names the way forward', () => {
    expect(AGUI_TEXT.otherEngine).toContain('began on another engine')
    expect(AGUI_TEXT.otherEngine).toContain('start a new chat for this agent')
  })
  it('the unreadable launch sends the user to the Raw view', () => {
    expect(AGUI_TEXT.launchUnreadable).toContain('Raw view')
    expect(AGUI_TEXT.launchUnreadable).toContain('agui:')
  })
  it('names a host, an env name or a status, and nothing else', () => {
    const h = 'agents.example.com'
    expect(AGUI_TEXT.authHeaderInvalid('Host')).toContain('Host')
    expect(AGUI_TEXT.authKeyMissing('EXAMPLE_AGENT_KEY')).toContain('EXAMPLE_AGENT_KEY')
    expect(AGUI_TEXT.authKeyMissing('EXAMPLE_AGENT_KEY')).toContain('authKey')
    expect(AGUI_TEXT.authKeyUnusable('EXAMPLE_AGENT_KEY')).toContain('EXAMPLE_AGENT_KEY')
    expect(AGUI_TEXT.resolveFailed(h)).toContain(h)
    expect(AGUI_TEXT.notPublic(h)).toContain(h)
    expect(AGUI_TEXT.connectTimeout(h)).toContain(h)
    expect(AGUI_TEXT.network(h, 'ECONNRESET')).toContain(h)
    expect(AGUI_TEXT.network(h, 'ECONNRESET')).toContain('ECONNRESET')
    expect(AGUI_TEXT.status(502)).toContain('502')
    expect(AGUI_TEXT.testTimeout(h)).toContain(h)
    expect(AGUI_TEXT.testFailed(h, 'ECONNREFUSED')).toContain(h)
    expect(AGUI_TEXT.testFailed(h, 'ECONNREFUSED')).toContain('ECONNREFUSED')
    expect(AGUI_TEXT.zumiBotPick('remote-one')).toContain('remote-one')
  })
  it('a 401 or 403 names authKey, with the key name only when the agent has one', () => {
    for (const code of [401, 403]) {
      expect(AGUI_TEXT.unauthorized(code, 'EXAMPLE_AGENT_KEY')).toContain(String(code))
      expect(AGUI_TEXT.unauthorized(code, 'EXAMPLE_AGENT_KEY')).toContain('EXAMPLE_AGENT_KEY')
      expect(AGUI_TEXT.unauthorized(code, 'EXAMPLE_AGENT_KEY')).toContain('authKey')
      expect(AGUI_TEXT.unauthorized(code, null)).toContain(String(code))
      expect(AGUI_TEXT.unauthorized(code, null)).toContain('authKey')
    }
  })
  it('shows a RUN_ERROR message with its code', () => {
    expect(AGUI_TEXT.runError('boom', 'E_X')).toContain('boom')
    expect(AGUI_TEXT.runError('boom', 'E_X')).toContain('E_X')
    expect(AGUI_TEXT.runError('boom', null)).toContain('boom')
    expect(AGUI_TEXT.runError('boom', null)).not.toContain('null')
  })
  it('states each limit it enforces', () => {
    expect(AGUI_TEXT.connectTimeout('h')).toContain('10 seconds')
    expect(AGUI_TEXT.headersTimeout).toContain('30 seconds')
    expect(AGUI_TEXT.idleTimeout).toContain('120 seconds')
    expect(AGUI_TEXT.runTimeout).toContain('30 minutes')
    expect(AGUI_TEXT.bodyTooBig).toContain('16 MiB')
    expect(AGUI_TEXT.eventTooBig).toContain('1 MiB')
    expect(AGUI_TEXT.tooManyRounds).toContain('10')
  })
  it('has a fixed sentence for every case that takes no argument, with no address or path in it', () => {
    for (const s of [
      AGUI_TEXT.noEndpoint,
      AGUI_TEXT.endpointRequired,
      AGUI_TEXT.endpointInvalid,
      AGUI_TEXT.authKeyInvalid,
      AGUI_TEXT.authHeaderWithoutKey,
      AGUI_TEXT.notSse,
      AGUI_TEXT.protocol,
      AGUI_TEXT.noAttachments,
      AGUI_TEXT.pendingTools,
      AGUI_TEXT.toolUnfinished,
      AGUI_TEXT.forkIgnored,
      AGUI_TEXT.notAgui,
      AGUI_TEXT.testUnavailable
    ]) {
      expect(s.length).toBeGreaterThan(10)
      expect(s).not.toContain('://')
    }
    expect(AGUI_TEXT.interruptDeclined('approval')).toContain('approval')
    expect(AGUI_TEXT.toolUnfinished).toBe('The tool call did not finish.')
    expect(AGUI_TEXT.noAttachments).toMatch(/attachment/i)
  })
  it('no function takes an endpoint or a key value: what each shows is only the name it is given', () => {
    // The callers pass a host, an env name or a status; a sentence repeats only that argument.
    const secret = 'SENTINEL-secret-value'
    const shown = [
      AGUI_TEXT.authHeaderInvalid('Host'),
      AGUI_TEXT.authKeyMissing('EXAMPLE_AGENT_KEY'),
      AGUI_TEXT.authKeyUnusable('EXAMPLE_AGENT_KEY'),
      AGUI_TEXT.resolveFailed('h.example.com'),
      AGUI_TEXT.notPublic('h.example.com'),
      AGUI_TEXT.connectTimeout('h.example.com'),
      AGUI_TEXT.network('h.example.com', 'ECONNRESET'),
      AGUI_TEXT.status(500),
      AGUI_TEXT.unauthorized(401, 'EXAMPLE_AGENT_KEY'),
      AGUI_TEXT.testTimeout('h.example.com'),
      AGUI_TEXT.testFailed('h.example.com', 'ECONNREFUSED'),
      AGUI_TEXT.zumiBotPick('remote-one')
    ]
    for (const s of shown) expect(s).not.toContain(secret)
    // A bad header name that is not a plain token never reaches a sentence.
    expect(AGUI_TEXT.authHeaderInvalid(`${secret}\n x`)).not.toContain(secret)
  })
})

describe('AGUI_STUDIO_TEXT', () => {
  it("holds the design's notes for the remote agent card", () => {
    expect(AGUI_STUDIO_TEXT.remote('agents.example.com')).toBe(AGUI_TEXT.remoteNotice('agents.example.com'))
    expect(AGUI_STUDIO_TEXT.body).toBe("This agent's instructions are not sent: a remote agent's behaviour is its server's")
    expect(AGUI_STUDIO_TEXT.header).toBe('Authorization sends Bearer <value>, any other header the bare value')
    expect(AGUI_STUDIO_TEXT.testNote).toBe(
      'Test checks the address and connects. It sends no request, so no message or key leaves this machine'
    )
  })
  it('says older chats of the agent start anew', () => {
    expect(AGUI_STUDIO_TEXT.olderChats).toContain('another engine')
    expect(AGUI_STUDIO_TEXT.olderChats).toContain('new chat')
  })
  it('says an endpoint moved to another host takes the existing chats with it', () => {
    expect(AGUI_STUDIO_TEXT.changed).toContain('Existing chats continue')
    expect(AGUI_STUDIO_TEXT.changed).toContain('new host')
  })
  it('has the confirmation, key and Test notes the ACP card has', () => {
    for (const k of [
      'unused',
      'confirmed',
      'current',
      'unconfirmed',
      'changed',
      'noKeys',
      'notGranted',
      'testSaveFirst',
      'testUnsaved'
    ] as const)
      expect(AGUI_STUDIO_TEXT[k].length, k).toBeGreaterThan(5)
    expect(AGUI_STUDIO_TEXT.unconfirmed).toContain("doesn't run until you save it here")
    expect(AGUI_STUDIO_TEXT.testUnsaved).toContain('Save first')
  })
})
