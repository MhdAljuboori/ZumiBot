import { afterEach, describe, expect, it } from 'vitest'
import type { LookupAddress } from 'node:dns'
import { EventEmitter } from 'node:events'
import type { AddressInfo, Socket } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { AGUI_TEXT, type AguiLaunch } from '@zumibot/shared/agui'
import { engineCaps, missingFeatures } from '@zumibot/shared/engine'
import { createAguiTest, handshake, type AguiTestDeps, type Dialer } from '../../src/core/agui/aguiTest'
import { startFakeAgui, stopFakeAgui } from '../support/fakeAgui'
import { selfSigned, withTlsCheckOff } from '../support/selfSigned'

afterEach(stopFakeAgui)

const answer =
  (...addresses: string[]) =>
  async (): Promise<LookupAddress[]> =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

const REMOTE: AguiLaunch = { endpoint: 'https://agents.example.com/run', authKey: 'REMOTE_KEY', authHeader: null }

// The deps with no dialer: the real one. `make` below swaps in one that the test drives.
const baseDeps = (): AguiTestDeps => ({
  definitionOf: async () => ({ provider: 'ag-ui', launch: REMOTE }),
  trust: () => 'ok',
  allowLocal: false,
  lookup: answer('93.184.216.34'),
  keyNames: () => ['REMOTE_KEY'],
  caps: () => engineCaps('ag-ui')
})

const noDial: Dialer = () => {
  throw new Error('no dial expected')
}

function make(over: Partial<AguiTestDeps> = {}, launch: () => AguiLaunch | null = () => REMOTE) {
  return createAguiTest({ ...baseDeps(), definitionOf: async () => ({ provider: 'ag-ui', launch: launch() }), dial: noDial, ...over })
}

// A socket the test drives: it opens or fails when the test says so.
type Fake = Socket & { destroyed: boolean }
function fakeSocket(): Fake {
  const s = new EventEmitter() as EventEmitter & { destroyed: boolean; destroy(): void }
  s.destroyed = false
  s.destroy = () => {
    s.destroyed = true
  }
  return s as unknown as Fake
}
const opens =
  (event = 'secureConnect'): Dialer =>
  () => {
    const s = fakeSocket()
    queueMicrotask(() => s.emit(event))
    return s
  }

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('createAguiTest', () => {
  it('answers the host, every checked address, the handshake, the key and what ZumiBot hides', async () => {
    const dialed: Array<Parameters<Dialer>[0]> = []
    const test = make({
      lookup: answer('93.184.216.34', '2606:2800:220:1::248'),
      dial: (o) => {
        dialed.push(o)
        return opens()(o)
      }
    })
    expect(await test('rem')).toEqual({
      host: 'agents.example.com',
      addresses: ['93.184.216.34', '2606:2800:220:1::248'],
      tls: true,
      authKey: 'REMOTE_KEY',
      authKeyGranted: true,
      caps: engineCaps('ag-ui'),
      hidden: missingFeatures(engineCaps('ag-ui'))
    })
    expect(dialed).toEqual([{ secure: true, host: 'agents.example.com', port: 443, addresses: ['93.184.216.34', '2606:2800:220:1::248'] }])
  })

  it('names a non-default port in the host, and reports an ungranted or absent key', async () => {
    const r1 = await make({ dial: opens(), keyNames: () => [] }, () => ({ ...REMOTE, endpoint: 'https://agents.example.com:8443/run' }))(
      'rem'
    )
    expect(r1).toMatchObject({ host: 'agents.example.com:8443', authKey: 'REMOTE_KEY', authKeyGranted: false })
    const r2 = await make({ dial: opens() }, () => ({ ...REMOTE, authKey: null }))('rem')
    expect(r2).toMatchObject({ authKey: null, authKeyGranted: false })
  })

  it('a Vault that cannot be opened grants nothing', async () => {
    const r = await make({
      dial: opens(),
      keyNames: () => {
        throw new Error('locked')
      }
    })('rem')
    expect(r).toMatchObject({ authKeyGranted: false })
  })

  it('refuses as a run does: not remote, no endpoint, an endpoint that fails the check, an unconfirmed one', async () => {
    expect(await make({ definitionOf: async () => ({ provider: null, launch: REMOTE }) })('rem')).toEqual({ error: AGUI_TEXT.notAgui })
    expect(await make({ definitionOf: async () => ({ provider: 'acp', launch: REMOTE }) })('rem')).toEqual({ error: AGUI_TEXT.notAgui })
    expect(await make({ definitionOf: async () => null })('rem')).toEqual({ error: AGUI_TEXT.notAgui })
    expect(
      await make({
        definitionOf: async () => {
          throw new Error('x')
        }
      })('rem')
    ).toEqual({ error: AGUI_TEXT.notAgui })
    expect(await make({}, () => null)('rem')).toEqual({ error: AGUI_TEXT.noEndpoint })
    // Plain http is for the dev hook's loopback only.
    expect(await make({}, () => ({ ...REMOTE, endpoint: 'http://agents.example.com/run' }))('rem')).toEqual({
      error: AGUI_TEXT.endpointInvalid
    })
    expect(await make({ trust: () => 'changed' })('rem')).toEqual({ error: AGUI_TEXT.untrusted })
    expect(await make({ trust: () => 'none' })('rem')).toEqual({ error: AGUI_TEXT.untrusted })
  })

  it('refuses a name that resolves to a non-public address, or not at all, before it dials', async () => {
    expect(await make({ lookup: answer('93.184.216.34', '10.0.0.5') })('rem')).toEqual({ error: AGUI_TEXT.notPublic('agents.example.com') })
    expect(await make({ lookup: answer('127.0.0.1') })('rem')).toEqual({ error: AGUI_TEXT.notPublic('agents.example.com') })
    expect(
      await make({
        lookup: async () => {
          throw new Error('ENOTFOUND')
        }
      })('rem')
    ).toEqual({ error: AGUI_TEXT.resolveFailed('agents.example.com') })
  })

  it('a refused handshake or a connection error is a fixed sentence naming the host and a plain code only', async () => {
    const failing = (code: string) =>
      make({
        dial: () => {
          const s = fakeSocket()
          queueMicrotask(() => s.emit('error', Object.assign(new Error('connect to 93.184.216.34 failed'), { code })))
          return s
        }
      })
    expect(await failing('CERT_HAS_EXPIRED')('rem')).toEqual({ error: AGUI_TEXT.testFailed('agents.example.com', 'CERT_HAS_EXPIRED') })
    expect(await failing('ECONNREFUSED')('rem')).toEqual({ error: AGUI_TEXT.testFailed('agents.example.com', 'ECONNREFUSED') })
    // A code that is not a plain code never reaches a sentence.
    expect(await failing('weird code with spaces')('rem')).toEqual({ error: AGUI_TEXT.testFailed('agents.example.com', 'error') })
  })

  it('tests of one agent and one launch made together share one handshake; a changed launch gets its own', async () => {
    const sockets: Fake[] = []
    let launch = REMOTE
    const test = make(
      {
        dial: () => {
          const s = fakeSocket()
          sockets.push(s)
          return s
        }
      },
      () => launch
    )
    const a = test('rem')
    const b = test('rem')
    await settle()
    expect(sockets).toHaveLength(1)
    launch = { ...REMOTE, endpoint: 'https://other.example.com/run' }
    const c = test('rem')
    await settle()
    expect(sockets).toHaveLength(2)
    for (const s of sockets) s.emit('secureConnect')
    expect(await a).toEqual(await b)
    expect(await c).toMatchObject({ host: 'other.example.com' })
    // Once done, a later Test dials again.
    const d = test('rem')
    await settle()
    expect(sockets).toHaveLength(3)
    sockets[2].emit('secureConnect')
    await d
  })

  it('tests of two agents never share a handshake', async () => {
    const sockets: Fake[] = []
    const test = make({
      dial: () => {
        const s = fakeSocket()
        sockets.push(s)
        return s
      }
    })
    const both = Promise.all([test('one'), test('two')])
    await settle()
    expect(sockets).toHaveLength(2)
    for (const s of sockets) s.emit('secureConnect')
    await both
  })
})

describe('handshake', () => {
  const target = { host: 'agents.example.com', port: 443, addresses: ['93.184.216.34'], secure: true }

  it('resolves on the secure handshake (TLS) or on the connect (plain), and closes the socket', async () => {
    const tls = fakeSocket()
    const p = handshake(target, 'agents.example.com', 1000, () => tls)
    tls.emit('secureConnect')
    expect(await p).toBeNull()
    expect(tls.destroyed).toBe(true)
    const plain = fakeSocket()
    const q = handshake({ ...target, secure: false }, 'agents.example.com', 1000, () => plain)
    plain.emit('connect')
    expect(await q).toBeNull()
    expect(plain.destroyed).toBe(true)
  })

  it('a bare connect does not count for TLS: only the secure handshake does', async () => {
    const tls = fakeSocket()
    const p = handshake(target, 'agents.example.com', 40, () => tls)
    tls.emit('connect')
    expect(await p).toBe(AGUI_TEXT.testTimeout('agents.example.com'))
  })

  it('ends at the deadline with the timeout sentence and closes the socket', async () => {
    const s = fakeSocket()
    expect(await handshake(target, 'agents.example.com', 20, () => s)).toBe(AGUI_TEXT.testTimeout('agents.example.com'))
    expect(s.destroyed).toBe(true)
  })

  it('a dial that throws is a failure, not a crash', async () => {
    const dial: Dialer = () => {
      throw Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_VALUE' })
    }
    expect(await handshake(target, 'agents.example.com', 1000, dial)).toBe(
      AGUI_TEXT.testFailed('agents.example.com', 'ERR_INVALID_ARG_VALUE')
    )
  })
})

describe('the real dialer', () => {
  // The connection goes to the pinned loopback address (the dev hook), while the server sees the name in the ClientHello. Node's
  // default verification refuses a certificate no root signed, and nothing turns that off.
  it('connects to the pinned address with SNI = the name, and an unverifiable certificate fails the test', async () => {
    const cert = selfSigned()
    if (cert === null) return
    const names: string[] = []
    const server = createTlsServer(
      {
        ...cert,
        SNICallback: (name, cb) => {
          names.push(name)
          cb(null)
        }
      },
      (s) => s.destroy()
    )
    server.on('tlsClientError', () => {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const test = createAguiTest({
        ...baseDeps(),
        definitionOf: async () => ({
          provider: 'ag-ui',
          launch: { endpoint: `https://agent.test:${port}/run`, authKey: null, authHeader: null }
        }),
        allowLocal: true,
        lookup: answer('127.0.0.1')
      })
      expect(await test('rem')).toEqual({
        error: expect.stringMatching(
          new RegExp(
            `^ZumiBot could not connect to agent\\.test:${port} \\((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\\)\\.$`
          )
        )
      })
      expect(names).toEqual(['agent.test'])
    } finally {
      await new Promise((r) => server.close(r))
    }
  })

  it('refuses an unverifiable certificate even with NODE_TLS_REJECT_UNAUTHORIZED=0: the check is asked for, not inherited', async () => {
    const cert = selfSigned()
    if (cert === null) return
    const server = createTlsServer(cert, (s) => s.destroy())
    server.on('tlsClientError', () => {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const test = createAguiTest({
        ...baseDeps(),
        definitionOf: async () => ({
          provider: 'ag-ui',
          launch: { endpoint: `https://agent.test:${port}/run`, authKey: null, authHeader: null }
        }),
        allowLocal: true,
        lookup: answer('127.0.0.1')
      })
      expect(await withTlsCheckOff(() => test('rem'))).toEqual({
        error: expect.stringMatching(
          /^ZumiBot could not connect to agent\.test:\d+ \((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\)\.$/
        )
      })
    } finally {
      await new Promise((r) => server.close(r))
    }
  })

  it('a plain loopback http endpoint under the dev hook is a TCP connect that sends nothing: the fake server sees no request', async () => {
    const fake = await startFakeAgui([[{ text: 'never' }]])
    const test = createAguiTest({
      ...baseDeps(),
      definitionOf: async () => ({ provider: 'ag-ui', launch: { endpoint: fake.url, authKey: 'REMOTE_KEY', authHeader: null } }),
      allowLocal: true,
      lookup: undefined
    })
    expect(await test('rem')).toMatchObject({ host: `127.0.0.1:${fake.port}`, addresses: ['127.0.0.1'], tls: false })
    await new Promise((r) => setTimeout(r, 50))
    expect(fake.logText()).toBe('')
  })
})
