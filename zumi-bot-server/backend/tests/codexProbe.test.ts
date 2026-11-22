// The Codex probe verdicts (codexProbe.mjs), from hand-written transcripts, without the real CLI or any quota.
// Transcript convention: dir 'out' is probe -> codex, 'in' is codex -> probe; `t` is an optional ms clock.
import { expect, it } from 'vitest'

type Line = { dir: 'in' | 'out'; msg: any; t?: number }
type Transcript = { lines: Line[]; files: Record<string, boolean | string>; exit: number | null }
// @ts-expect-error plain .mjs without types
const probe = (await import('../../e2e/codexProbe.mjs')) as {
  judge(check: number, t: Transcript): 'pass' | 'fail' | 'inconclusive'
  main(
    args?: string[],
    run?: (o: { recordDir: string | null; only: number[] | null }) => Promise<{ outcome: string; version: string; reason: string | null }>
  ): Promise<number>
  parseOnly(v: string | null): number[] | null
  selectedChecks(only: number[] | null): number[]
  reverseDiff(diff: string, newText: string): string | null
  tomlInline(v: unknown): string
}

const out = (method: string, params: unknown, id = 1, t?: number): Line => ({ dir: 'out', msg: { id, method, params }, t })
const answer = (id: number, result: unknown, t?: number): Line => ({ dir: 'in', msg: { id, result }, t })
const note = (method: string, params: unknown, t?: number): Line => ({ dir: 'in', msg: { method, params }, t })
const reply = (id: number, result: unknown): Line => ({ dir: 'out', msg: { id, result } })
const usage = (last: number, total: number): Line =>
  note('thread/tokenUsage/updated', {
    threadId: 't1',
    turnId: 'u1',
    tokenUsage: { last: { totalTokens: last }, total: { totalTokens: total }, modelContextWindow: 258400 }
  })
const done = (status: string, t?: number): Line => note('turn/completed', { threadId: 't1', turn: { id: 'u1', status } }, t)
const init = (): Line[] => [out('initialize', { clientInfo: {} }, 1), answer(1, { userAgent: 'codex/0.164.0', codexHome: '/h' })]
const t = (lines: Line[], files: Record<string, boolean | string> = {}, exit: number | null = 0): Transcript => ({ lines, files, exit })

const basics = (): Line[] => [
  ...init(),
  out('thread/start', {}, 2),
  answer(2, { thread: { id: 't1' } }),
  out('turn/start', {}, 3),
  answer(3, { turn: { id: 'u1' } }),
  note('item/agentMessage/delta', { delta: 'hi' }),
  usage(100, 100),
  usage(150, 250),
  done('completed')
]

it('check 1 passes when the turn has a thread, deltas, completion and consistent usage', () => {
  expect(probe.judge(1, t(basics()))).toBe('pass')
})

it('check 1 is inconclusive with no initialize answer, fails on a missing piece or a usage mismatch', () => {
  expect(probe.judge(1, t([out('initialize', {}, 1)], {}, null))).toBe('inconclusive')
  expect(probe.judge(1, t(basics().filter((l) => l.msg.method !== 'item/agentMessage/delta')))).toBe('fail')
  expect(probe.judge(1, t(basics().filter((l) => l.msg.method !== 'thread/tokenUsage/updated')))).toBe('fail')
  expect(probe.judge(1, t(basics().map((l) => (l.msg.method === 'turn/completed' ? done('failed') : l))))).toBe('fail')
  const bad = basics()
  bad.splice(bad.length - 1, 0, usage(10, 999)) // sum of last = 260, total = 999
  expect(probe.judge(1, t(bad))).toBe('fail')
})

const msgItem = (text: string): Line => note('item/completed', { item: { type: 'agentMessage', id: 'm', text } })
it('check 2 passes only when the resumed thread follows the new instruction', () => {
  const run = (second: string) =>
    t([
      ...init(),
      out('thread/start', { developerInstructions: 'KIWI' }, 2),
      answer(2, { thread: { id: 't1' } }),
      msgItem('ok KIWI'),
      done('completed'),
      ...init(),
      out('thread/resume', { threadId: 't1', developerInstructions: 'MANGO' }, 2),
      msgItem(second),
      done('completed')
    ])
  expect(probe.judge(2, run('ok MANGO'))).toBe('pass')
  expect(probe.judge(2, run('ok KIWI'))).toBe('fail')
  expect(probe.judge(2, run('ok KIWI MANGO'))).toBe('fail')
})

const approval = (id: number, command: string): Line => ({
  dir: 'in',
  msg: { id, method: 'item/commandExecution/requestApproval', params: { command, itemId: 'i' } }
})
it('check 3 fails when the outside write ran before the decline answer', () => {
  const lines = [...init(), approval(7, 'touch ../outside-marker'), reply(7, { decision: 'decline' })]
  expect(
    probe.judge(3, t(lines, { 'outside-marker:before': true, 'outside-marker:declined': true, 'outside-marker:accepted': true }))
  ).toBe('fail')
})

it('check 3 passes on an approval, an absent file after decline and a present one after accept', () => {
  const lines = [
    ...init(),
    approval(7, 'touch ../outside-marker'),
    reply(7, { decision: 'decline' }),
    approval(8, 'touch ../outside-marker'),
    reply(8, { decision: 'accept' })
  ]
  expect(
    probe.judge(3, t(lines, { 'outside-marker:before': false, 'outside-marker:declined': false, 'outside-marker:accepted': true }))
  ).toBe('pass')
  // The accepted rerun asked and still wrote nothing: a real failure.
  expect(
    probe.judge(3, t(lines, { 'outside-marker:before': false, 'outside-marker:declined': false, 'outside-marker:accepted': false }))
  ).toBe('fail')
  expect(
    probe.judge(3, t(lines, { 'outside-marker:before': false, 'outside-marker:declined': true, 'outside-marker:accepted': true }))
  ).toBe('fail')
  // no approval and no file: the model never tried
  expect(
    probe.judge(3, t(init(), { 'outside-marker:before': false, 'outside-marker:declined': false, 'outside-marker:accepted': false }))
  ).toBe('inconclusive')
})

it('check 3 is inconclusive when the model never ran the write again after the decline', () => {
  const absent = { 'outside-marker:before': false, 'outside-marker:declined': false, 'outside-marker:accepted': false }
  const once = [...init(), approval(7, 'touch ../outside-marker'), reply(7, { decision: 'decline' })]
  expect(probe.judge(3, t(once, absent))).toBe('inconclusive')
  // A later approval for another command (the read phases) is no rerun of the write.
  expect(probe.judge(3, t([...once, approval(8, 'cat inside-read.txt'), reply(8, { decision: 'accept' })], absent))).toBe('inconclusive')
  // A shell-wrapped command still counts as the rerun.
  const wrapped = [...once, approval(8, "/bin/bash -lc 'touch ../outside-marker'"), reply(8, { decision: 'accept' })]
  expect(probe.judge(3, t(wrapped, absent))).toBe('fail')
})

const cmdDone = (command: string, exitCode: number): Line =>
  note('item/completed', { item: { type: 'commandExecution', id: 'c', command, exitCode, status: exitCode ? 'failed' : 'completed' } })
it('check 4 passes with no request for the inside write and a working curl', () => {
  const lines = [...init(), cmdDone('echo ok > inside.txt', 0), cmdDone('curl -sI https://example.com', 0)]
  expect(probe.judge(4, t(lines, { 'inside.txt': true }))).toBe('pass')
  expect(probe.judge(4, t([...lines, approval(9, 'echo ok > inside.txt')], { 'inside.txt': true }))).toBe('fail')
  expect(probe.judge(4, t([...init(), cmdDone('echo ok > inside.txt', 0)], { 'inside.txt': true }))).toBe('inconclusive')
})

it('check 4: a failed curl fails only when this machine itself reached the network', () => {
  const lines = [...init(), cmdDone('echo ok > inside.txt', 0), cmdDone('curl -sI https://example.com', 6)]
  expect(probe.judge(4, t(lines, { 'inside.txt': true, 'host-online': true }))).toBe('fail')
  // Offline, or not checked: the sandbox is not to blame.
  expect(probe.judge(4, t(lines, { 'inside.txt': true, 'host-online': false }))).toBe('inconclusive')
  expect(probe.judge(4, t(lines, { 'inside.txt': true }))).toBe('inconclusive')
})

const mcpDone = (tool = 'probe_echo'): Line =>
  note('item/completed', { item: { type: 'mcpToolCall', id: 'x', server: 'probe', tool, status: 'completed' } })
it('check 5 fails when the token was not forwarded or leaked to the session log', () => {
  const lines = [...init(), mcpDone()]
  expect(probe.judge(5, t(lines, { 'marker-mcp.txt': true, 'marker-mcp.token': true, 'session-leak': false }))).toBe('pass')
  expect(probe.judge(5, t(lines, { 'marker-mcp.txt': true, 'marker-mcp.token': false, 'session-leak': false }))).toBe('fail')
  expect(probe.judge(5, t(lines, { 'marker-mcp.txt': true, 'marker-mcp.token': true, 'session-leak': true }))).toBe('fail')
  expect(probe.judge(5, t(init(), { 'marker-mcp.txt': false, 'marker-mcp.token': false, 'session-leak': false }))).toBe('inconclusive')
})

it('check 6 passes when the turn ends interrupted within 10 s of the interrupt', () => {
  const lines = (status: string, at: number) => [
    ...init(),
    note('item/started', { item: { type: 'commandExecution', id: 'c' } }, 0),
    out('turn/interrupt', { threadId: 't1', turnId: 'u1' }, 9, 1000),
    done(status, at)
  ]
  expect(probe.judge(6, t(lines('interrupted', 3000)))).toBe('pass')
  expect(probe.judge(6, t(lines('interrupted', 12000)))).toBe('fail')
  expect(probe.judge(6, t(lines('completed', 3000)))).toBe('fail')
  expect(probe.judge(6, t([...init()]))).toBe('inconclusive')
})

// ---- Phase 2 checks 7-10, 14, 15 ----

const forkOut = (params: Record<string, unknown>, id = 5): Line[] => [out('thread/fork', params, id), answer(id, { thread: { id: 't2' } })]
const resumeOut = (id = 6): Line[] => [out('thread/resume', { threadId: 't1' }, id), answer(id, { thread: { id: 't1' } })]

it('check 7 passes when the fork knows only turn 1, has its own id and the source still knows GAMMA', () => {
  const lines = (forkReply: string, sourceReply: string) => [
    ...init(),
    ...forkOut({ threadId: 't1', lastTurnId: 'u1' }),
    msgItem(forkReply),
    done('completed'),
    ...init(),
    ...resumeOut(),
    msgItem(sourceReply),
    done('completed')
  ]
  expect(probe.judge(7, t(lines('ALPHA', 'ALPHA BETA GAMMA')))).toBe('pass')
  expect(probe.judge(7, t(lines('ALPHA BETA', 'ALPHA BETA GAMMA')))).toBe('fail')
  expect(probe.judge(7, t(lines('ALPHA', 'ALPHA BETA')))).toBe('fail') // the source lost GAMMA
  expect(probe.judge(7, t(lines('nothing', 'GAMMA')))).toBe('fail')
})

it('check 7 fails on a fork with the source id, is inconclusive with no fork or no reply, and judges the last fork', () => {
  const same = [
    ...init(),
    out('thread/fork', { threadId: 't1', lastTurnId: 'u1' }, 5),
    answer(5, { thread: { id: 't1' } }),
    msgItem('ALPHA'),
    ...resumeOut(),
    msgItem('GAMMA')
  ]
  expect(probe.judge(7, t(same))).toBe('fail')
  expect(probe.judge(7, t(init()))).toBe('inconclusive')
  expect(probe.judge(7, t([...init(), ...forkOut({ threadId: 't1', lastTurnId: 'u1' }), ...resumeOut(), msgItem('GAMMA')]))).toBe(
    'inconclusive'
  )
  // The first try (turn 1's id) answered nothing; the retry with turn 2's id is the one that counts.
  const retry = [
    ...init(),
    ...forkOut({ threadId: 't1', lastTurnId: 'u1' }, 5),
    msgItem('I have no words from you'),
    ...forkOut({ threadId: 't1', lastTurnId: 'u2' }, 7),
    msgItem('ALPHA'),
    ...resumeOut(),
    msgItem('GAMMA')
  ]
  expect(probe.judge(7, t(retry))).toBe('pass')
})

it('check 8 passes with no rollout file for the ephemeral fork and fails with one', () => {
  const lines = [
    ...init(),
    ...forkOut({ threadId: 't1', lastTurnId: 'u1', ephemeral: true }),
    note('turn/completed', { threadId: 't2', turn: { id: 'u9', status: 'completed' } })
  ]
  expect(probe.judge(8, t(lines, { 'source-rollout': true, 'fork-rollout': false }))).toBe('pass')
  expect(probe.judge(8, t(lines, { 'source-rollout': true, 'fork-rollout': true }))).toBe('fail')
  // A search that cannot see even the source's rollout proves nothing.
  expect(probe.judge(8, t(lines, { 'source-rollout': false, 'fork-rollout': false }))).toBe('inconclusive')
  // Not ephemeral, or no turn run in the fork: no verdict.
  expect(probe.judge(8, t([...init(), ...forkOut({ threadId: 't1' })], { 'source-rollout': true, 'fork-rollout': false }))).toBe(
    'inconclusive'
  )
  expect(
    probe.judge(8, t([...init(), ...forkOut({ threadId: 't1', ephemeral: true })], { 'source-rollout': true, 'fork-rollout': false }))
  ).toBe('inconclusive')
})

const compactOut = (at: number): Line[] => [out('thread/compact/start', { threadId: 't1' }, 7, at), answer(7, {}, at + 20)]
const compactedItem = (type: 'started' | 'completed', at: number): Line =>
  note(`item/${type}`, { threadId: 't1', turnId: 'u2', item: { type: 'contextCompaction', id: 'k' } }, at)
it('check 9 passes when a compaction notice arrives within 120 s and fails with none, late, or an error', () => {
  const base = [...init()]
  expect(probe.judge(9, t([...base, ...compactOut(1000), note('thread/compacted', { threadId: 't1', turnId: 'u2' }, 6000)]))).toBe('pass')
  expect(probe.judge(9, t([...base, ...compactOut(1000), compactedItem('started', 2000), compactedItem('completed', 9000)]))).toBe('pass')
  expect(probe.judge(9, t([...base, ...compactOut(1000), note('thread/compacted', { threadId: 't1' }, 200_000)]))).toBe('fail')
  expect(probe.judge(9, t([...base, ...compactOut(1000), done('completed', 5000)]))).toBe('fail')
  expect(
    probe.judge(
      9,
      t([
        ...base,
        out('thread/compact/start', { threadId: 't1' }, 7, 1000),
        { dir: 'in', msg: { id: 7, error: { code: -32600, message: 'nope' } }, t: 1100 }
      ])
    )
  ).toBe('fail')
  expect(probe.judge(9, t(base))).toBe('inconclusive')
})

// A real `fileChange` diff, as the probe sees it: hunks with `@@` lines.
const DIFF_A = '@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO changed\n line three\n'
const fileChange = (changes: unknown[], status = 'completed'): Line =>
  note('item/completed', { item: { type: 'fileChange', id: 'f', changes, status } })
it('reverseDiff turns the new file back into the old one, with or without file headers', () => {
  expect(probe.reverseDiff(DIFF_A, 'line one\nline TWO changed\nline three\n')).toBe('line one\nline two\nline three\n')
  expect(probe.reverseDiff('--- a/a.txt\n+++ b/a.txt\n' + DIFF_A, 'line one\nline TWO changed\nline three\n')).toBe(
    'line one\nline two\nline three\n'
  )
  // Two hunks, a pure insertion and a pure deletion.
  const two = '@@ -1,2 +1,3 @@\n a\n+ins\n b\n@@ -5,2 +6,1 @@\n-gone\n z\n'
  expect(probe.reverseDiff(two, 'a\nins\nb\nc\nd\nz\n')).toBe('a\nb\nc\nd\ngone\nz\n')
  // The new file does not hold what the diff says it should: no guess.
  expect(probe.reverseDiff(DIFF_A, 'something else\n')).toBeNull()
  expect(probe.reverseDiff('just text', 'x\n')).toBeNull()
})

it("check 10 passes when reversing a.txt's diff onto the file on disk gives the original", () => {
  const orig = 'line one\nline two\nline three\n',
    disk = 'line one\nline TWO changed\nline three\n'
  const lines = [
    ...init(),
    fileChange([
      { path: '/w/a.txt', kind: { type: 'update', move_path: null }, diff: DIFF_A },
      { path: '/w/b.txt', kind: { type: 'add' }, diff: 'new\n' }
    ])
  ]
  expect(probe.judge(10, t(lines, { 'a.txt:original': orig, 'a.txt:disk': disk }))).toBe('pass')
  // A diff that does not match the disk fails; an unchanged disk or no a.txt change is no verdict.
  const wrong = [
    ...init(),
    fileChange([{ path: '/w/a.txt', kind: { type: 'update', move_path: null }, diff: DIFF_A.replace('TWO changed', 'OTHER') }])
  ]
  expect(probe.judge(10, t(wrong, { 'a.txt:original': orig, 'a.txt:disk': disk }))).toBe('fail')
  expect(probe.judge(10, t(lines, { 'a.txt:original': orig, 'a.txt:disk': orig }))).toBe('inconclusive')
  expect(
    probe.judge(
      10,
      t([...init(), fileChange([{ path: '/w/b.txt', kind: { type: 'add' }, diff: 'new\n' }])], {
        'a.txt:original': orig,
        'a.txt:disk': disk
      })
    )
  ).toBe('inconclusive')
  expect(
    probe.judge(
      10,
      t([...init(), fileChange([{ path: '/w/a.txt', kind: { type: 'update', move_path: null }, diff: DIFF_A }], 'declined')], {
        'a.txt:original': orig,
        'a.txt:disk': disk
      })
    )
  ).toBe('inconclusive')
})

const sideStart = (type: string, extra: Record<string, unknown> = {}): Line =>
  note('item/started', { item: { type, id: `i-${type}`, ...extra } })
const askCmd = (id: number, command: string): Line => approval(id, `/bin/bash -lc '${command}'`)
const askMcp = (id: number): Line => ({
  dir: 'in',
  msg: {
    id,
    method: 'mcpServer/elicitation/request',
    params: { serverName: 'probe', message: 'Allow the probe MCP server to run tool "probe_echo"?' }
  }
})
const askPatch = (id: number): Line => ({
  dir: 'in',
  msg: { id, method: 'item/fileChange/requestApproval', params: { itemId: 'i-fileChange' } }
})
const noFiles = { 'side-marker': false, 'side-file.txt': false, 'marker-mcp.txt': false }
it('check 14 passes when every attempt asked and nothing ran', () => {
  const all = [...init(), askCmd(8, 'touch side-marker'), reply(8, { decision: 'decline' }), askMcp(9), askPatch(10)]
  expect(probe.judge(14, t(all, noFiles))).toBe('pass')
  // A command instead of a patch for side-file.txt counts the same.
  expect(probe.judge(14, t([...init(), askCmd(8, 'touch side-marker'), askMcp(9), askCmd(10, 'echo x > side-file.txt')], noFiles))).toBe(
    'pass'
  )
  // Two of three attempted and asked is enough.
  expect(probe.judge(14, t([...init(), askCmd(8, 'touch side-marker'), askMcp(9)], noFiles))).toBe('pass')
})

it('check 14 fails when any file exists or an attempt ran with no request, and is inconclusive when fewer than two were tried', () => {
  const all = [...init(), askCmd(8, 'touch side-marker'), askMcp(9), askPatch(10)]
  for (const f of Object.keys(noFiles)) expect(probe.judge(14, t(all, { ...noFiles, [f]: true }))).toBe('fail')
  // The command started but no request was sent for it.
  const silent = [...init(), sideStart('commandExecution', { command: "/bin/bash -lc 'touch side-marker'" }), askMcp(9)]
  expect(probe.judge(14, t(silent, noFiles))).toBe('fail')
  expect(probe.judge(14, t([...init(), askCmd(8, 'touch side-marker')], noFiles))).toBe('inconclusive')
  expect(probe.judge(14, t(init(), noFiles))).toBe('inconclusive')
})

const ask = (over: Record<string, unknown> = {}): Line => ({
  dir: 'in',
  msg: {
    id: 11,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 't1',
      turnId: 'u1',
      itemId: 'q',
      questions: [
        {
          id: 'color',
          header: 'Pick',
          question: 'red or blue?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'red', description: '' },
            { label: 'blue', description: '' }
          ]
        }
      ],
      isBlocking: true,
      autoResolutionMs: null,
      ...over
    }
  }
})
it('check 15 passes on a question request with id, question and options, and a reply that says blue', () => {
  const run = (reqLine: Line, text: string) => [
    ...init(),
    reqLine,
    reply(11, { answers: { color: { answers: ['blue'] } } }),
    msgItem(text),
    done('completed')
  ]
  expect(probe.judge(15, t(run(ask(), 'You picked blue.')))).toBe('pass')
  expect(probe.judge(15, t(run(ask(), 'You picked red.')))).toBe('fail')
  expect(probe.judge(15, t(run(ask({ questions: [{ header: 'x' }] }), 'blue')))).toBe('fail')
  expect(probe.judge(15, t(run(ask({ questions: [] }), 'blue')))).toBe('fail')
  expect(probe.judge(15, t([...init(), msgItem('I cannot ask'), done('completed')]))).toBe('inconclusive')
})

// ---- Phase 3 checks 11-13, 16-18 ----

// One hook stdin line as codex writes it (the pre-tool-use.command.input schema), JSONL in files['hook-log'].
const hookIn = (tool_name: string, tool_input: unknown) => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input,
  session_id: 't1',
  turn_id: 'u1',
  cwd: '/w',
  model: 'm',
  permission_mode: 'default',
  tool_use_id: 'c',
  transcript_path: null
})
const hookLog = (...inputs: unknown[]): string => inputs.map((i) => JSON.stringify(i)).join('\n') + '\n'
const fullLog = hookLog(
  hookIn('Bash', { command: 'echo ok' }),
  hookIn('Bash', { command: 'touch blocked-marker' }),
  hookIn('mcp__probe__probe_echo', { text: 'hi' }),
  hookIn('apply_patch', { command: '*** Begin Patch\n*** Add File: patch-marker.txt\n+x\n*** End Patch' })
)
const mcpStarted = (): Line => sideStart('mcpToolCall', { server: 'probe', tool: 'probe_echo' })
const patchStarted = (): Line => sideStart('fileChange', { changes: [{ path: '/w/patch-marker.txt', kind: { type: 'add' }, diff: 'x\n' }] })
const hookFiles = (over: Record<string, boolean | string> = {}) => ({
  'hook-source': 'cli+trust',
  'hook-log': fullLog,
  'blocked-marker': false,
  ...over
})

it('check 11 passes when a per-run hook blocked the marker command and ran for the shell, MCP and patch calls', () => {
  const lines = [...init(), mcpStarted(), patchStarted()]
  expect(probe.judge(11, t(lines, hookFiles()))).toBe('pass')
  // The thread config source counts the same.
  expect(probe.judge(11, t(lines, hookFiles({ 'hook-source': 'config' })))).toBe('pass')
})

it('check 11 fails when the blocked command ran or a call the model made went by without the hook', () => {
  const lines = [...init(), mcpStarted(), patchStarted()]
  expect(probe.judge(11, t(lines, hookFiles({ 'blocked-marker': true })))).toBe('fail')
  const noMcp = hookLog(
    hookIn('Bash', { command: 'touch blocked-marker' }),
    hookIn('apply_patch', { command: '*** Add File: patch-marker.txt' })
  )
  expect(probe.judge(11, t(lines, hookFiles({ 'hook-log': noMcp })))).toBe('fail')
  const noPatch = hookLog(hookIn('Bash', { command: 'touch blocked-marker' }), hookIn('mcp__probe__probe_echo', { text: 'hi' }))
  expect(probe.judge(11, t(lines, hookFiles({ 'hook-log': noPatch })))).toBe('fail')
})

it('check 11 is inconclusive when the hook never ran, needed the trust bypass, or a call was never tried', () => {
  const lines = [...init(), mcpStarted(), patchStarted()]
  expect(probe.judge(11, t(lines, hookFiles({ 'hook-source': '', 'hook-log': '' })))).toBe('inconclusive')
  expect(probe.judge(11, t(lines, hookFiles({ 'bypass-hook-trust': true })))).toBe('inconclusive')
  // The model never ran the marker command (no hook input names it, no file).
  const noTry = hookLog(
    hookIn('Bash', { command: 'echo ok' }),
    hookIn('mcp__probe__probe_echo', { text: 'hi' }),
    hookIn('apply_patch', { command: '*** Add File: patch-marker.txt' })
  )
  expect(probe.judge(11, t(lines, hookFiles({ 'hook-log': noTry })))).toBe('inconclusive')
  // No MCP or patch item: the model never made that call, so the hook's coverage of it is unknown.
  expect(probe.judge(11, t([...init(), patchStarted()], hookFiles()))).toBe('inconclusive')
  expect(probe.judge(11, t([...init(), mcpStarted()], hookFiles()))).toBe('inconclusive')
  // The marker file was never looked for (something threw first): no pass without that check.
  const { 'blocked-marker': _unchecked, ...noMarker } = hookFiles()
  expect(probe.judge(11, t(lines, noMarker))).toBe('inconclusive')
})

const elicit = (id: number): Line => ({
  dir: 'in',
  msg: {
    id,
    method: 'mcpServer/elicitation/request',
    params: { threadId: 't1', serverName: 'probe', mode: 'form', message: 'Allow the probe MCP server to run tool "probe_echo"?' }
  }
})
it('check 12 passes when a forced approval came before the tool ran and a decline kept it from running', () => {
  const lines = [
    ...init(),
    elicit(9),
    reply(9, { action: 'decline', content: null, _meta: null }),
    elicit(10),
    reply(10, { action: 'accept', content: null, _meta: null })
  ]
  const ok = { 'marker-mcp:at-request': false, 'marker-mcp:declined': false, 'marker-mcp:accepted': true }
  expect(probe.judge(12, t(lines, ok))).toBe('pass')
  expect(probe.judge(12, t(lines, { ...ok, 'marker-mcp:at-request': true }))).toBe('fail')
  expect(probe.judge(12, t(lines, { ...ok, 'marker-mcp:declined': true }))).toBe('fail')
  // No config made it ask (the tool simply ran): no verdict on forcing.
  expect(
    probe.judge(12, t([...init(), mcpDone()], { 'marker-mcp:at-request': false, 'marker-mcp:declined': true, 'marker-mcp:accepted': true }))
  ).toBe('inconclusive')
})

it('check 12 passes only on a request naming probe_echo, with the decline and accept markers both checked', () => {
  const lines = [
    ...init(),
    elicit(9),
    reply(9, { action: 'decline', content: null, _meta: null }),
    elicit(10),
    reply(10, { action: 'accept', content: null, _meta: null })
  ]
  const ok = { 'marker-mcp:at-request': false, 'marker-mcp:declined': false, 'marker-mcp:accepted': true }
  // A request about another tool (or a shell command) proves nothing about forcing probe_echo.
  const other: Line = {
    dir: 'in',
    msg: { id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 't1', command: "/bin/bash -lc 'ls'" } }
  }
  expect(probe.judge(12, t([...init(), other, reply(9, { decision: 'decline' })], ok))).toBe('inconclusive')
  // The accept never let the tool run (or was never tried): the decline alone proves nothing.
  expect(probe.judge(12, t(lines, { ...ok, 'marker-mcp:accepted': false }))).toBe('inconclusive')
  const { 'marker-mcp:accepted': _a, ...noAccept } = ok
  expect(probe.judge(12, t(lines, noAccept))).toBe('inconclusive')
  // The markers were never looked for.
  const { 'marker-mcp:declined': _d, ...noDecline } = ok
  expect(probe.judge(12, t(lines, noDecline))).toBe('inconclusive')
  const { 'marker-mcp:at-request': _r, ...noAtRequest } = ok
  expect(probe.judge(12, t(lines, noAtRequest))).toBe('inconclusive')
})

const collab = (status: string): Line =>
  note('item/completed', {
    threadId: 't1',
    turnId: 'u1',
    item: {
      type: 'collabAgentToolCall',
      id: 'k',
      tool: 'spawnAgent',
      status,
      senderThreadId: 't1',
      receiverThreadIds: ['c1'],
      prompt: 'run echo child',
      model: null,
      reasoningEffort: null,
      agentsStates: {}
    }
  })
it('check 13 passes when collab items arrive and no child outlives the closed process', () => {
  const lines = [...init(), collab('completed')]
  expect(probe.judge(13, t(lines, { 'sleep-started': true, 'sleep-after-interrupt': false, 'sleep-after-exit': false }))).toBe('pass')
  // A sleep still running after the interrupt but gone once the process closed is still a pass (the runner closes it).
  expect(probe.judge(13, t(lines, { 'sleep-started': true, 'sleep-after-interrupt': true, 'sleep-after-exit': false }))).toBe('pass')
  expect(probe.judge(13, t(lines, { 'sleep-started': true, 'sleep-after-exit': true }))).toBe('fail')
  expect(probe.judge(13, t(init(), { 'sleep-started': true, 'sleep-after-exit': false }))).toBe('inconclusive')
  expect(probe.judge(13, t(lines, { 'sleep-started': false, 'sleep-after-exit': false }))).toBe('inconclusive')
  // The leak check never ran (something threw before it): no pass.
  expect(probe.judge(13, t(lines, { 'sleep-started': true, 'sleep-after-interrupt': false }))).toBe('inconclusive')
})

const threadAnswer = (id: number, threadId: string, turns: unknown[] | undefined): Line =>
  answer(id, { thread: { id: threadId, ...(turns ? { turns } : {}) } })
const ex16 = (o: { resumeTurns?: unknown[]; forkTurns?: unknown[]; resumeReply?: string; forkReply?: string } = {}): Line[] => [
  ...init(),
  out('thread/resume', { threadId: 't1', excludeTurns: true }, 2),
  threadAnswer(2, 't1', o.resumeTurns ?? []),
  msgItem(o.resumeReply ?? 'ALPHA BETA'),
  done('completed'),
  ...init(),
  out('thread/fork', { threadId: 't1', lastTurnId: 'u1', excludeTurns: true }, 2),
  threadAnswer(2, 't2', o.forkTurns),
  msgItem(o.forkReply ?? 'ALPHA'),
  done('completed')
]
it('check 16 passes when excludeTurns leaves the answers without turns and the model still remembers', () => {
  expect(probe.judge(16, t(ex16()))).toBe('pass')
  expect(probe.judge(16, t(ex16({ resumeReply: 'NONE' })))).toBe('fail')
  expect(probe.judge(16, t(ex16({ forkReply: 'ALPHA BETA' })))).toBe('fail') // the fork kept a turn after lastTurnId
  expect(probe.judge(16, t(ex16({ resumeTurns: [{ id: 'u1' }, { id: 'u2' }] })))).toBe('fail')
  expect(probe.judge(16, t(ex16({ forkTurns: [{ id: 'u1' }] })))).toBe('fail')
  expect(probe.judge(16, t(init()))).toBe('inconclusive')
  // A refused excludeTurns is a failure of the parameter.
  const refused = [
    ...init(),
    out('thread/resume', { threadId: 't1', excludeTurns: true }, 2),
    { dir: 'in' as const, msg: { id: 2, error: { code: -32600, message: 'nope' } } }
  ]
  expect(probe.judge(16, t(refused))).toBe('fail')
})

it('check 17 passes when thread/start accepts a compact limit above the window', () => {
  const start = (r: Line): Line[] => [...init(), out('thread/start', { config: { model_auto_compact_token_limit: 358400 } }, 4), r]
  expect(probe.judge(17, t(start(answer(4, { thread: { id: 't9' } }))))).toBe('pass')
  expect(probe.judge(17, t(start({ dir: 'in', msg: { id: 4, error: { code: -32600, message: 'too big' } } })))).toBe('fail')
  expect(probe.judge(17, t(init()))).toBe('inconclusive')
  // A thread/start without the limit is not the one judged.
  expect(probe.judge(17, t([...init(), out('thread/start', { config: {} }, 4), answer(4, { thread: { id: 't9' } })]))).toBe('inconclusive')
})

it('check 18 passes when a fork at an interrupted turn answers (a thread or an error) and fails only when it hangs', () => {
  const before = [
    ...init(),
    out('turn/interrupt', { threadId: 't1', turnId: 'u2' }, 6),
    done('interrupted'),
    ...init(),
    out('thread/fork', { threadId: 't1', lastTurnId: 'u2' }, 2)
  ]
  expect(probe.judge(18, t([...before, answer(2, { thread: { id: 't2' } }), msgItem('ALPHA'), done('completed')]))).toBe('pass')
  expect(
    probe.judge(18, t([...before, { dir: 'in', msg: { id: 2, error: { code: -32600, message: 'cannot fork an interrupted turn' } } }]))
  ).toBe('pass')
  // No answer while the app-server lived past the deadline is a hang; no answer otherwise (it died, the request broke) is no verdict.
  expect(probe.judge(18, t(before, { 'fork-hang': true }))).toBe('fail')
  expect(probe.judge(18, t(before))).toBe('inconclusive')
  expect(probe.judge(18, t(before, { 'fork-hang': false }))).toBe('inconclusive')
  // No interrupted turn, or no fork: no verdict.
  expect(
    probe.judge(18, t([...init(), out('thread/fork', { threadId: 't1', lastTurnId: 'u2' }, 2), answer(2, { thread: { id: 't2' } })]))
  ).toBe('inconclusive')
  expect(probe.judge(18, t([...init(), done('interrupted')]))).toBe('inconclusive')
})

it('--only takes a number or a comma list; main passes it on as a list', async () => {
  expect(probe.parseOnly(null)).toBeNull()
  expect(probe.parseOnly('7')).toEqual([7])
  expect(probe.parseOnly('7,8, 14')).toEqual([7, 8, 14])
  expect(probe.parseOnly('7,x')).toBeNull()
  let got: unknown = 'unset'
  await withSkip(undefined, () =>
    probe.main(['--only', '9,10'], async (o) => {
      got = o.only
      return { outcome: 'pass', version: '9', reason: null }
    })
  )
  expect(got).toEqual([9, 10])
})

it('a default run selects only checks 1-6 (the quota-free-of-features set); 7+ run only through --only', () => {
  expect(probe.selectedChecks(null)).toEqual([1, 2, 3, 4, 5, 6])
  expect(probe.selectedChecks([7, 9])).toEqual([7, 9])
  expect(probe.selectedChecks([3])).toEqual([3])
  expect(probe.selectedChecks([9, 99])).toEqual([9])
  // Phase 3's checks exist and run only when named.
  expect(probe.selectedChecks([11, 12, 13, 16, 17, 18])).toEqual([11, 12, 13, 16, 17, 18])
})

it('tomlInline writes the -c values check 11 passes: strings escaped, null keys left out', () => {
  const { tomlInline } = probe
  expect(tomlInline([{ matcher: null, hooks: [{ type: 'command', command: 'sh "/a b/h.sh"', timeout: 5 }] }])).toBe(
    '[{hooks=[{type="command",command="sh \\"/a b/h.sh\\"",timeout=5}]}]'
  )
  expect(tomlInline({ '/<session-flags>/config.toml:pre_tool_use:0:0': { trusted_hash: 'sha256:ab' } })).toBe(
    '{"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:ab"}}'
  )
  expect(tomlInline(true)).toBe('true')
})

// Runs fn with ZUMIBOT_SKIP_CODEX_PROBE set to `value` (or unset), then puts back what the shell exported.
async function withSkip<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const had = Object.hasOwn(process.env, 'ZUMIBOT_SKIP_CODEX_PROBE'),
    old = process.env.ZUMIBOT_SKIP_CODEX_PROBE
  if (value === undefined) delete process.env.ZUMIBOT_SKIP_CODEX_PROBE
  else process.env.ZUMIBOT_SKIP_CODEX_PROBE = value
  try {
    return await fn()
  } finally {
    if (had) process.env.ZUMIBOT_SKIP_CODEX_PROBE = old
    else delete process.env.ZUMIBOT_SKIP_CODEX_PROBE
  }
}

it('exit codes: pass 0, fail 1, inconclusive 2 or 0 with --soft', async () => {
  const run = (outcome: string) => async () => ({ outcome, version: '9', reason: 'why' })
  await withSkip(undefined, async () => {
    expect(await probe.main([], run('pass'))).toBe(0)
    expect(await probe.main([], run('fail'))).toBe(1)
    expect(await probe.main([], run('inconclusive'))).toBe(2)
    expect(await probe.main(['--soft'], run('inconclusive'))).toBe(0)
    expect(await probe.main(['--soft'], run('fail'))).toBe(1)
  })
})

it('ZUMIBOT_SKIP_CODEX_PROBE=1 skips the probe with exit 0, whatever it would have found', async () => {
  let ran = false
  const failing = async () => {
    ran = true
    return { outcome: 'fail', version: '9', reason: 'why' }
  }
  expect(await withSkip('1', () => probe.main([], failing))).toBe(0)
  expect(ran).toBe(false)
  // Any other value runs it.
  expect(await withSkip('0', () => probe.main([], failing))).toBe(1)
  expect(ran).toBe(true)
})
