import { describe, expect, it } from 'vitest'
import type { AcpLaunch } from '@zumibot/shared/acp'
import { engineCaps } from '@zumibot/shared/engine'
import type { AcpProbeOptions, AcpProbeResult } from '../../src/core/acp/acpProbe'
import { createAcpTest } from '../../src/core/acp/acpTest'

const info = (title: string): AcpProbeResult => ({
  agentInfo: { name: 'fake', title, version: null },
  protocolVersion: 1,
  loadSession: false,
  resume: false,
  systemPrompt: false,
  image: false,
  authMethods: []
})

// A Test service whose saved file and probe the test drives: each probe waits until the test lets it answer.
function make() {
  let launch: AcpLaunch = { command: 'gemini', args: ['--acp'], authEnv: [] }
  const probes: Array<{ o: AcpProbeOptions; answer: (r: AcpProbeResult) => void }> = []
  const test = createAcpTest({
    definitionOf: async () => ({ provider: 'acp', launch }),
    trust: () => 'ok',
    locate: async (c) => `/bin/${c}`,
    env: async () => ({}),
    vaultEnv: () => ({ env: {}, scrub: new Map() }),
    caps: () => engineCaps('acp'),
    probe: (o) => new Promise((resolve) => probes.push({ o, answer: resolve }))
  })
  return {
    test,
    probes,
    setLaunch: (l: AcpLaunch) => {
      launch = l
    }
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('createAcpTest', () => {
  it('tests of one agent and one launch made together share one probe', async () => {
    const { test, probes } = make()
    const a = test('gem')
    const b = test('gem')
    await settle()
    expect(probes).toHaveLength(1)
    probes[0].answer(info('one'))
    expect(await a).toEqual(await b)
  })

  it("a test made after the saved launch changed gets its own probe of the new launch, not the running one's answer", async () => {
    const { test, probes, setLaunch } = make()
    const before = test('gem')
    await settle()
    setLaunch({ command: 'gemini', args: ['--acp', '--debug'], authEnv: [] })
    const after = test('gem')
    await settle()
    expect(probes.map((p) => p.o.args)).toEqual([['--acp'], ['--acp', '--debug']])
    probes[0].answer(info('old launch'))
    probes[1].answer(info('new launch'))
    expect(await before).toMatchObject({ agentInfo: { title: 'old launch' } })
    expect(await after).toMatchObject({ agentInfo: { title: 'new launch' } })
  })

  it('tests of two agents never share a probe', async () => {
    const { test, probes } = make()
    void test('gem')
    void test('other')
    await settle()
    expect(probes).toHaveLength(2)
    for (const p of probes) p.answer(info('x'))
  })
})
