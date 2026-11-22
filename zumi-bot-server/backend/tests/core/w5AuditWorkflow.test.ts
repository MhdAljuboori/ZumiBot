import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { problemsOf } from '@zumibot/shared/workflowGraph'
import { deliver, newState, takeStarts } from '@zumibot/shared/workflowEngine'
import { portsOf, PROMPT_MAX, type Step, type Visit, type Workflow } from '@zumibot/shared/workflows'
import { parseWorkflowInput } from '../../src/core/workflows/workflowInput'

const run = promisify(execFile)
const script = resolve(__dirname, '../../../deploy/workflows/w5-design-audit.mjs')
const AGENTS = ['code-specialist', 'work-assistant', 'ui-ux-specialist', 'structure-reviewer', 'workiom5-assistance'].map((name) => ({
  name,
  error: null
}))

// A variable path keeps tsc from asking for types of a plain .mjs script.
const load = async (): Promise<{
  NAME: string
  definition: Pick<Workflow, 'trigger' | 'steps' | 'edges'> & { name: string; enabled: boolean }
  asWorkflow(zone: string): Workflow
}> => import(/* @vite-ignore */ script)

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-w5-audit-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('W5 design audit workflow definition', () => {
  it('has no problems: one trigger, every step reachable, known agents, no unknown handles, For each uses {{item}}', async () => {
    const { definition } = await load()
    expect(problemsOf(definition, AGENTS, 'zumi-bot')).toEqual([])
  })

  it('survives the save parser unchanged, so the editor and the runner accept it', async () => {
    const { asWorkflow } = await load()
    const w = asWorkflow('UTC')
    const parsed = parseWorkflowInput({
      id: null,
      name: w.name,
      enabled: w.enabled,
      timeZone: w.timeZone,
      trigger: w.trigger,
      steps: w.steps,
      edges: w.edges
    })
    expect(parsed.steps).toEqual(w.steps)
    expect(parsed.edges).toEqual(w.edges)
  })

  it('every edge leaves a real port of its step and no prompt passes the size cap', async () => {
    const { definition } = await load()
    const byId = new Map<string, Step>(definition.steps.map((s) => [s.id, s]))
    for (const e of definition.edges) expect(portsOf(byId.get(e.from)!.kind)).toContain(e.port)
    for (const s of definition.steps) {
      if ('prompt' in s) expect(s.prompt.length).toBeLessThanOrEqual(PROMPT_MAX)
      if ('question' in s) expect(s.question.length).toBeLessThanOrEqual(PROMPT_MAX)
    }
  })

  it('uses the agent browser and the Vault login: no Playwright scripts, no password variable, the login item named, the audit tools named', async () => {
    const { definition } = await load()
    const text = definition.steps.flatMap((s) => ('prompt' in s ? [s.prompt] : [])).join('\n')
    expect(text).not.toMatch(/W5_QA_PASSWORD|product-state|pair\.mjs|lib\.mjs/i)
    // The one mention is the instruction not to use scripts.
    expect(text.match(/playwright/gi)).toHaveLength(1)
    expect(text).toContain('never Playwright scripts')
    expect(text).toContain('E2e Workspace')
    for (const tool of [
      'browser_fill_from_vault',
      'browser_set_viewport',
      'browser_computed_style',
      'browser_hover',
      'browser_save_screenshot',
      'browser_release'
    ]) {
      expect(definition.steps.find((s) => s.id === 's-scan' && 'prompt' in s && s.prompt.includes(tool))).toBeTruthy()
    }
  })

  it('reaches Clean up on every way out: failed setup, unresolved areas, rejection and the finished path', async () => {
    const { definition } = await load()
    const into = definition.edges
      .filter((e) => e.to === 's-cleanup')
      .map((e) => `${e.from}:${e.port}`)
      .sort()
    expect(into).toEqual(['s-file:out', 's-prepare-ok:no', 's-resolve-ok:no', 's-review:rejected'])
  })
})

describe('W5 design audit join at Clean up', () => {
  // Four exclusive branches lead into Clean up: whichever arrives must start it at once, never wait for the others.
  it.each([
    ['s-prepare-ok', 'no'],
    ['s-resolve-ok', 'no'],
    ['s-review', 'rejected'],
    ['s-file', 'out']
  ] as const)('starts Clean up when %s ends on %s', async (stepId, port) => {
    const { definition } = await load()
    const state = newState({ steps: definition.steps, edges: definition.edges })
    const visit: Visit = { id: 'v', stepId, n: 1, status: 'done', input: '', inputs: [], output: 'x', port, startedAt: 1, endedAt: 2 }
    const delivered = deliver({ ...state, visits: [visit] }, visit)
    expect(takeStarts(delivered).starts.map((s) => s.stepId)).toEqual(['s-cleanup'])
  })

  it('starts the For each step with only the area list as its input', async () => {
    const { definition } = await load()
    const state = newState({ steps: definition.steps, edges: definition.edges })
    const visit: Visit = {
      id: 'v',
      stepId: 's-resolve-ok',
      n: 1,
      status: 'done',
      input: 'Parent-226 Gallery View',
      inputs: [],
      output: 'Parent-226 Gallery View',
      port: 'yes',
      startedAt: 1,
      endedAt: 2
    }
    const { starts } = takeStarts(deliver({ ...state, visits: [visit] }, visit))
    expect(starts).toHaveLength(1)
    expect(starts[0]!.stepId).toBe('s-scan')
    expect(starts[0]!.inputs.map((d) => d.text)).toEqual(['Parent-226 Gallery View'])
  })
})

describe('W5 design audit importer', () => {
  const file = () => join(dir, 'workflows.json')
  const exec = (...args: string[]) => run(process.execPath, [script, '--data-dir', dir, '--time-zone', 'UTC', ...args])

  it('adds the workflow beside the others, off the clock and with its own id, and keeps the others as they were', async () => {
    const other = {
      id: 'o1',
      name: 'Other',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      steps: [],
      edges: [],
      nextRunAt: null,
      createdAt: 1,
      updatedAt: 1
    }
    await fs.writeFile(file(), JSON.stringify([other]))
    await exec()
    const list = JSON.parse(await fs.readFile(file(), 'utf8')) as Workflow[]
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual(other)
    expect(list[1]!.name).toBe((await load()).NAME)
    expect(list[1]!.id).not.toBe('o1')
    expect(list[1]!.nextRunAt).toBeNull()
  })

  it('creates the file when there is none, and refuses to add a second copy', async () => {
    await exec()
    expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toHaveLength(1)
    await expect(exec()).rejects.toMatchObject({ code: 1 })
    expect(JSON.parse(await fs.readFile(file(), 'utf8'))).toHaveLength(1)
  })

  it('refuses a workflows.json that is not a list and leaves it alone', async () => {
    await fs.writeFile(file(), '{"not":"a list"}')
    await expect(exec()).rejects.toMatchObject({ code: 1 })
    expect(await fs.readFile(file(), 'utf8')).toBe('{"not":"a list"}')
  })

  it('--update replaces the steps in place and keeps the id, the switch, the zone, the creation time and the other workflows', async () => {
    const other = {
      id: 'o1',
      name: 'Other',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      steps: [],
      edges: [],
      nextRunAt: null,
      createdAt: 1,
      updatedAt: 1
    }
    const old = {
      id: 'w5id',
      name: (await load()).NAME,
      enabled: false,
      timeZone: 'Asia/Baghdad',
      trigger: { kind: 'manual' },
      steps: [{ id: 'x', kind: 'trigger', handle: 'x', name: 'Old', x: 0, y: 0 }],
      edges: [],
      nextRunAt: null,
      createdAt: 5,
      updatedAt: 5
    }
    await fs.writeFile(file(), JSON.stringify([other, old]))
    await exec('--update')
    const list = JSON.parse(await fs.readFile(file(), 'utf8')) as Workflow[]
    const { definition } = await load()
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual(other)
    expect(list[1]).toMatchObject({ id: 'w5id', enabled: false, timeZone: 'Asia/Baghdad', createdAt: 5 })
    expect(list[1]!.steps).toEqual(definition.steps)
    expect(list[1]!.edges).toEqual(definition.edges)
    expect(list[1]!.updatedAt).toBeGreaterThan(5)
  })

  it('--update refuses when there is no such workflow, and adding refuses when there is one', async () => {
    await fs.writeFile(file(), '[]')
    await expect(exec('--update')).rejects.toMatchObject({ code: 1 })
    expect(await fs.readFile(file(), 'utf8')).toBe('[]')
    await exec()
    await expect(exec()).rejects.toMatchObject({ code: 1 })
  })

  it('--print writes nothing', async () => {
    const { stdout } = await exec('--print')
    expect(JSON.parse(stdout).name).toBe((await load()).NAME)
    await expect(fs.stat(file())).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
