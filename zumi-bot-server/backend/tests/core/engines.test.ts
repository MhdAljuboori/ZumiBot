import { describe, expect, it } from 'vitest'
import { engineCaps } from '@zumibot/shared/engine'
import { turnStart, type RunHandle, type TurnAction } from '../../src/core/engines/engine'
import { claudeEngine, claudeResume } from '../../src/core/engines/claudeEngine'
import { codexActionOf, codexEngine, codexStartOf } from '../../src/core/engines/codexEngine'
import type { RunOptions } from '../../src/core/chat/claudeRunner'
import type { CodexRunOptions } from '../../src/core/codex/codexRunner'

// The seam both engines sit behind: one reading of a start point and one shape for an action, so neither call site can drift
// into resuming a point it meant to fork. See docs/architecture/engines.md.
const handle: RunHandle = {
  stop: () => {},
  send: () => false,
  done: Promise.resolve({ exitCode: 0, signal: null, stderr: '', spawnError: null, result: null, stopped: false })
}
const onEvent = () => {}
const turn = (start = turnStart(null), action: TurnAction = { kind: 'turn', prompt: 'hi' }) => ({
  bin: '/bin/cli',
  cwd: '/w',
  start,
  action,
  onEvent
})

describe('turnStart', () => {
  it('reads no session as a fresh one, a session alone as a resume, and a session with a point as a fork', () => {
    expect(turnStart(null)).toEqual({ kind: 'new' })
    expect(turnStart(null, 'u1')).toEqual({ kind: 'new' })
    expect(turnStart('s1')).toEqual({ kind: 'resume', sessionId: 's1' })
    expect(turnStart('s1', 'u1')).toEqual({ kind: 'fork', sessionId: 's1', at: 'u1' })
    expect(turnStart('s1', 'u1', 'p1')).toEqual({ kind: 'fork', sessionId: 's1', at: 'u1', drops: 'p1' })
    // A fork is the only kind that can declare what it discards.
    expect(turnStart('s1', undefined, 'p1')).toEqual({ kind: 'resume', sessionId: 's1' })
    expect(turnStart(null, undefined, 'p1')).toEqual({ kind: 'new' })
  })
})

describe('claudeResume', () => {
  it('names the hidden pair only for a fork', () => {
    expect(claudeResume(turnStart(null))).toEqual({ resumeSessionId: null })
    expect(claudeResume(turnStart('s1'))).toEqual({ resumeSessionId: 's1' })
    expect(claudeResume(turnStart('s1', 'u1'))).toEqual({ resumeSessionId: 's1', resumeAt: 'u1' })
    expect(claudeResume(turnStart('s1', 'u1', 'p1'))).toEqual({ resumeSessionId: 's1', resumeAt: 'u1', resumeDrops: 'p1' })
  })
})

describe('codexStartOf', () => {
  it('maps each kind to its thread request, with ephemeral on a fork alone', () => {
    expect(codexStartOf(turnStart(null))).toEqual({ kind: 'new' })
    expect(codexStartOf(turnStart('t1'))).toEqual({ kind: 'resume', threadId: 't1' })
    expect(codexStartOf(turnStart('t1', 'turn-9'))).toEqual({ kind: 'fork', threadId: 't1', lastTurnId: 'turn-9' })
    // Codex names its own turns: a declared prompt has no place in its fork.
    expect(codexStartOf(turnStart('t1', 'turn-9', 'p1'))).toEqual({ kind: 'fork', threadId: 't1', lastTurnId: 'turn-9' })
    expect(codexStartOf(turnStart('t1', 'turn-9'), { ephemeral: true })).toEqual({
      kind: 'fork',
      threadId: 't1',
      lastTurnId: 'turn-9',
      ephemeral: true
    })
    expect(codexStartOf(turnStart(null), { ephemeral: true })).toEqual({ kind: 'new' })
  })
})

describe('codexActionOf', () => {
  it("keeps a turn's prompt and drops a compaction's, which codex has no field for", () => {
    expect(codexActionOf({ kind: 'turn', prompt: 'hi' })).toEqual({ kind: 'turn', prompt: 'hi' })
    expect(codexActionOf({ kind: 'compact', prompt: '/compact note' })).toEqual({ kind: 'compact' })
  })
})

describe('claudeEngine', () => {
  const adapter = (seen: RunOptions[]) =>
    claudeEngine({
      caps: () => engineCaps('claude'),
      locate: async () => '/bin/claude',
      run: (o) => {
        seen.push(o)
        return handle
      }
    })

  it('spawns one claude per turn with the session in its argv and the prompt on stdin', () => {
    const seen: RunOptions[] = []
    adapter(seen).start(turn(turnStart('s1', 'u1')), { agentName: 'ann', permissionMode: 'manual', disallowedTools: [], extraArgs: [] })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ bin: '/bin/cli', cwd: '/w', stdin: 'hi', onEvent })
    expect(seen[0].env).toBeUndefined()
    expect(seen[0].args).toContain('--agent')
    expect(seen[0].args.join(' ')).toContain('--resume s1 --resume-session-at u1 --fork-session')
  })

  it('compacts by sending the prompt, as the CLI does, and passes the env through when there is one', () => {
    const seen: RunOptions[] = []
    adapter(seen).start(
      { ...turn(turnStart('s1'), { kind: 'compact', prompt: '/compact' }), env: { A: '1' } },
      { agentName: 'ann', permissionMode: 'manual', disallowedTools: [], extraArgs: [] }
    )
    expect(seen[0].stdin).toBe('/compact')
    expect(seen[0].env).toEqual({ A: '1' })
    expect(seen[0].args.join(' ')).toContain('--resume s1')
    expect(seen[0].args).not.toContain('--fork-session')
  })

  it('reports the engine, its caps and its binary', async () => {
    const a = adapter([])
    expect(a.engine).toBe('claude')
    expect(a.caps()).toEqual(engineCaps('claude'))
    expect(await a.locate()).toBe('/bin/claude')
  })
})

describe('codexEngine', () => {
  const thread = { cwd: '/w', permissionMode: 'manual' as const, baseInstructions: 'be brief', mcpServers: [] }
  const adapter = (seen: CodexRunOptions[], caps = engineCaps('codex')) =>
    codexEngine({
      caps: () => caps,
      locate: async () => '/bin/codex',
      run: (o) => {
        seen.push(o)
        return handle
      },
      definitionOf: async () => ({ body: 'be brief', model: 'gpt-5' })
    })

  it('forks the thread at the stamped turn and keeps the rest of its config', () => {
    const seen: CodexRunOptions[] = []
    adapter(seen).start(turn(turnStart('t1', 'turn-9')), { thread, requestTag: 'tag-1', subagents: true, ephemeral: true })
    expect(seen[0]).toMatchObject({
      bin: '/bin/cli',
      cwd: '/w',
      requestTag: 'tag-1',
      subagents: true,
      thread,
      start: { kind: 'fork', threadId: 't1', lastTurnId: 'turn-9', ephemeral: true },
      action: { kind: 'turn', prompt: 'hi' }
    })
    // `ephemeral` belongs to the fork, so it never reaches the runner as an option of its own.
    expect('ephemeral' in seen[0]).toBe(false)
  })

  it('sends a compaction as its own request, with no prompt', () => {
    const seen: CodexRunOptions[] = []
    adapter(seen).start(turn(turnStart('t1'), { kind: 'compact', prompt: 'ignored' }), { thread, requestTag: 'tag-2' })
    expect(seen[0].start).toEqual({ kind: 'resume', threadId: 't1' })
    expect(seen[0].action).toEqual({ kind: 'compact' })
  })

  it('reads the caps it is given, so a flag a probe turns off reaches it', () => {
    const off = { ...engineCaps('codex'), compact: false }
    expect(adapter([], off).caps().compact).toBe(false)
    expect(adapter([]).caps().compact).toBe(true)
  })

  it('reports the engine, its binary and the agent file Codex needs for want of --agent', async () => {
    const a = adapter([])
    expect(a.engine).toBe('codex')
    expect(await a.locate()).toBe('/bin/codex')
    expect(await a.definitionOf('ann')).toEqual({ body: 'be brief', model: 'gpt-5' })
  })
})

describe('the prompt uuid and the declared turn on the CLI adapter', () => {
  it('writes the prompt under the id it was given and names the flag only with a fork', () => {
    const seen: RunOptions[] = []
    const adapter = claudeEngine({
      caps: () => engineCaps('claude'),
      locate: async () => '/bin/claude',
      run: (o) => {
        seen.push(o)
        return handle
      }
    })
    const config = { agentName: 'ann', permissionMode: 'manual' as const, disallowedTools: [], extraArgs: [] }
    adapter.start({ ...turn(turnStart('s1', 'u1', 'p1')), action: { kind: 'turn', prompt: 'hi', promptUuid: 'p9' } }, config)
    expect(seen[0].stdinUuid).toBe('p9')
    expect(seen[0].args.join(' ')).toContain('--resume s1 --resume-session-at u1 --fork-session --resume-drops-turn p1')
    // A plain resume has nothing to declare, and a turn with no uuid writes none.
    adapter.start(turn(turnStart('s1')), config)
    expect(seen[1].stdinUuid).toBeUndefined()
    expect(seen[1].args).not.toContain('--resume-drops-turn')
  })
})
