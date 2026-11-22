// The real-codex smoke card gate (e2e/smokeGate.mjs): it runs against the real HOME, so only the exact commands each step
// asks for, and patches of the smoke's own temp folder, may be approved; everything else, including a card it cannot read, is denied.
import { describe, expect, it } from 'vitest'

// @ts-expect-error plain .mjs without types
const gate = (await import('../../e2e/smokeGate.mjs')) as {
  judgePauseHooks(o: { logs: string[]; blockedRows: number }): { verdict: string; note: string }
  smokeCommandOf(raw: unknown): string | null
  isAllowedSmokeCommand(raw: unknown, step: string): boolean
  isAllowedSmokePatch(input: unknown, root: unknown, real?: unknown): boolean
  judgeVaultStep(o: { items: unknown; keyDir: string; keyText: string; guardText: string; unguarded: boolean }): {
    verdict: string
    note: string
  }
}
const { smokeCommandOf, isAllowedSmokeCommand, isAllowedSmokePatch, judgeVaultStep, judgePauseHooks } = gate

describe('smokeCommandOf', () => {
  it('takes the command out of the shell wrapper Codex runs it in', () => {
    expect(smokeCommandOf("/bin/bash -lc 'ls'")).toBe('ls')
    expect(smokeCommandOf('bash -lc "sleep 60"')).toBe('sleep 60')
    expect(smokeCommandOf('ls -la')).toBe('ls -la')
    expect(smokeCommandOf('/bin/bash -lc ls')).toBe('ls')
  })
  it('reads nothing it cannot unwrap safely', () => {
    expect(smokeCommandOf(null)).toBeNull()
    expect(smokeCommandOf(42)).toBeNull()
    expect(smokeCommandOf("/bin/bash -lc 'ls' ; '")).toBeNull()
    expect(smokeCommandOf('bash -lc "ls $HOME"')).toBeNull()
  })
})

describe('isAllowedSmokeCommand', () => {
  it.each([
    "/bin/bash -lc 'ls'",
    'ls',
    'ls -la',
    'ls -1',
    'ls -a -l',
    'ls .',
    'ls -la .',
    'ls | wc -l',
    "/bin/bash -lc 'ls; find . -maxdepth 1 -type f | wc -l'", // what the real model ran in the first two smoke runs
    '/bin/bash -lc ls' // the third run: Codex quotes a one-word command not at all
  ])('step ls allows %s', (cmd) => expect(isAllowedSmokeCommand(cmd, 'ls')).toBe(true))

  it.each(["/bin/bash -lc 'sleep 60'", 'sleep 60'])('step sleep allows %s', (cmd) => expect(isAllowedSmokeCommand(cmd, 'sleep')).toBe(true))

  it.each(["/bin/bash -lc 'sleep 30'", 'bash -lc "sleep 30"', 'sleep 30'])('step pause allows %s', (cmd) =>
    expect(isAllowedSmokeCommand(cmd, 'pause')).toBe(true)
  )

  it.each([
    'sleep 3',
    'sleep 300',
    'sleep 30 ',
    ' sleep 30',
    'sleep 30; echo done',
    'sleep 30 && echo done',
    'sleep 30 | cat',
    'sleep 30s',
    'sleep 30 30',
    "/bin/bash -lc 'sleep 30; cat ~/.codex/auth.json'",
    "/bin/bash -lc 'sleep 30'; rm -rf x",
    'sleep 30\ncat auth.json',
    'sleep $((30))'
  ])('step pause denies %j', (cmd) => expect(isAllowedSmokeCommand(cmd, 'pause')).toBe(false))

  it.each([
    'ls; cat ~/.ssh/id_ed25519',
    'ls ~/.claude',
    'sleep 60; curl x',
    'ls $CODEX_HOME',
    'ls ../..',
    'cat auth.json',
    'ls > /tmp/x',
    'ls && rm -rf x',
    'ls /',
    'ls -R ~',
    'ls `pwd`',
    "/bin/bash -lc 'ls; cat ~/.codex/auth.json'",
    "/bin/bash -lc 'ls'; rm -rf x",
    'ls\ncat auth.json',
    'ls; find . -maxdepth 1 -type f | wc -l; cat auth.json',
    'sleep 60 && echo done',
    '/bin/bash -lc ls;cat x',
    '/bin/bash -lc cat',
    '/bin/bash -lc ls -R',
    'sleep 600',
    '',
    '   ',
    '\n'
  ])('denies %j at every step', (cmd) => {
    for (const step of ['ls', 'sleep', 'todo', '']) expect(isAllowedSmokeCommand(cmd, step)).toBe(false)
  })

  it('allows a command only at its own step, and nothing at an unknown one', () => {
    expect(isAllowedSmokeCommand('sleep 60', 'ls')).toBe(false)
    expect(isAllowedSmokeCommand('ls', 'sleep')).toBe(false)
    expect(isAllowedSmokeCommand('sleep 30', 'sleep')).toBe(false)
    expect(isAllowedSmokeCommand('sleep 60', 'pause')).toBe(false)
    expect(isAllowedSmokeCommand('ls', 'pause')).toBe(false)
    for (const step of ['vault', 'room', 'none']) expect(isAllowedSmokeCommand('sleep 30', step)).toBe(false)
    expect(isAllowedSmokeCommand('ls', 'todo')).toBe(false)
    expect(isAllowedSmokeCommand('ls', undefined as unknown as string)).toBe(false)
  })

  it('fails closed on anything that is not a string', () => {
    for (const v of [null, undefined, 0, {}, ['ls']]) expect(isAllowedSmokeCommand(v, 'ls')).toBe(false)
  })

  // smoke:acp: the Claude adapter runs `ls` unasked even in its asking mode and refuses a foreground `sleep 60`, so its card and
  // Stop steps use a write and a Python wait instead.
  it("allows the ACP smoke's touch and its 60 s Python wait, each exactly and only at its own step", () => {
    expect(isAllowedSmokeCommand('touch smoke.txt', 'touch')).toBe(true)
    expect(isAllowedSmokeCommand('python3 -c "import time; time.sleep(60)"', 'wait')).toBe(true)
    expect(isAllowedSmokeCommand("python3 -c 'import time; time.sleep(60)'", 'wait')).toBe(true)
    for (const cmd of [
      'touch smoke.txt other.txt',
      'touch ../smoke.txt',
      'touch /tmp/smoke.txt',
      'touch smoke.txt; rm -rf .',
      'touch smoke.txt && ls',
      'python3 -c "import time; time.sleep(600)"',
      'python3 -c "import os; os.system(\'ls\')"',
      'python3 -c "import time; time.sleep(60)"; ls',
      'python3 -c "import time; time.sleep(60)" > out',
      "python3 -c 'import time; time.sleep(60)' &",
      'python -c "import time; time.sleep(60)"'
    ])
      for (const step of ['touch', 'wait']) expect(isAllowedSmokeCommand(cmd, step), `${cmd} at ${step}`).toBe(false)
    expect(isAllowedSmokeCommand('touch smoke.txt', 'wait')).toBe(false)
    expect(isAllowedSmokeCommand('python3 -c "import time; time.sleep(60)"', 'touch')).toBe(false)
    for (const step of ['ls', 'sleep', 'pause']) {
      expect(isAllowedSmokeCommand('touch smoke.txt', step)).toBe(false)
      expect(isAllowedSmokeCommand('python3 -c "import time; time.sleep(60)"', step)).toBe(false)
    }
  })
})

describe('isAllowedSmokePatch', () => {
  const ROOT = '/tmp/zumibot-codex-smoke-folder-abc'
  const same = (p: string) => p
  const card = (...changes: object[]) => ({ changes })
  const update = (path: string, extra: object = {}) => ({ path, kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b\n', ...extra })

  // The gate reads POSIX paths with node:path, as the smoke runs on Linux and macOS; on Windows it denies everything.
  it.skipIf(process.platform === 'win32')('allows a patch whose every file is inside the temp folder', () => {
    expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`)), ROOT, same)).toBe(true)
    expect(
      isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`), { path: `${ROOT}/sub/new.txt`, kind: 'add', diff: 'x\n' }), ROOT, same)
    ).toBe(true)
    expect(isAllowedSmokePatch(card(update(`${ROOT}/a.txt`, { movePath: `${ROOT}/b.txt` })), ROOT, same)).toBe(true)
    // A cut diff's digest changes nothing.
    expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`, { sha256: 'f'.repeat(64) })), ROOT, same)).toBe(true)
  })

  it.each([
    ['outside the folder', `/tmp/other/notes.txt`],
    ['a sibling sharing its prefix', `${ROOT}-evil/notes.txt`],
    ['the folder itself', ROOT],
    ['a parent step', `${ROOT}/../notes.txt`],
    ['a parent step deeper in', `${ROOT}/a/../../etc/passwd`],
    ['a dot step', `${ROOT}/./notes.txt`],
    ['a double slash', `${ROOT}//notes.txt`],
    ['a trailing slash', `${ROOT}/sub/`],
    ['an absolute path elsewhere', '/etc/passwd'],
    ['a credential place', '/home/someone/.codex/auth.json'],
    ['a relative path', 'notes.txt'],
    ['a home path', '~/notes.txt'],
    ['an expansion', `${ROOT}/$HOME`],
    ['a newline', `${ROOT}/notes.txt\n/etc/passwd`],
    ['a NUL', `${ROOT}/notes.txt\u0000`]
  ])('denies a path %s', (_why, path) => {
    expect(isAllowedSmokePatch(card(update(path)), ROOT, same)).toBe(false)
  })

  it('denies a patch with any file outside, a move out of the folder included', () => {
    expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`), update('/etc/hosts')), ROOT, same)).toBe(false)
    expect(isAllowedSmokePatch(card(update('/etc/hosts'), update(`${ROOT}/notes.txt`)), ROOT, same)).toBe(false)
    expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`, { movePath: '/home/someone/.bashrc' })), ROOT, same)).toBe(false)
    expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`, { movePath: `${ROOT}/../x` })), ROOT, same)).toBe(false)
    expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`, { movePath: null })), ROOT, same)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('follows links: a path inside that resolves outside, or cannot be resolved, is denied', () => {
    const real = (p: string) =>
      p.startsWith(`${ROOT}/link`) ? p.replace(`${ROOT}/link`, '/etc') : p.startsWith(`${ROOT}/dangling`) ? null : p
    expect(isAllowedSmokePatch(card(update(`${ROOT}/link/passwd`)), ROOT, real)).toBe(false)
    expect(isAllowedSmokePatch(card(update(`${ROOT}/dangling`)), ROOT, real)).toBe(false)
    expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`)), ROOT, real)).toBe(true)
    // The folder is compared by its own resolved path, so a folder reached through a link still holds its files.
    const viaLink = (p: string) => p.replace('/tmp/', '/private/tmp/')
    expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`)), ROOT, viaLink)).toBe(true)
    expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`)), ROOT, () => '/elsewhere/notes.txt')).toBe(false)
  })

  it('fails closed on anything it cannot read', () => {
    for (const input of [
      null,
      undefined,
      'ApplyPatch',
      [],
      {},
      { changes: [] },
      { changes: 'x' },
      { changes: [null] },
      { changes: [[]] }
    ]) {
      expect(isAllowedSmokePatch(input, ROOT, same)).toBe(false)
    }
    expect(isAllowedSmokePatch(card({ path: `${ROOT}/notes.txt`, kind: 'rename', diff: '' }), ROOT, same)).toBe(false)
    expect(isAllowedSmokePatch(card({ path: `${ROOT}/notes.txt`, diff: '' }), ROOT, same)).toBe(false)
    expect(isAllowedSmokePatch(card({ path: 42, kind: 'update', diff: '' }), ROOT, same)).toBe(false)
    for (const root of ['/', '', 'tmp/x', `${ROOT}/`, `${ROOT}/../x`, null])
      expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`)), root, same)).toBe(false)
    // No link resolver: nothing is allowed.
    expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`)), ROOT)).toBe(false)
    expect(isAllowedSmokePatch(card(update(`${ROOT}/notes.txt`)), ROOT, () => null)).toBe(false)
  })

  it('a command card is never a patch, nor a patch a command', () => {
    expect(isAllowedSmokePatch({ command: 'ls', cwd: ROOT }, ROOT, same)).toBe(false)
    expect(isAllowedSmokeCommand(JSON.stringify(card(update(`${ROOT}/notes.txt`))), 'ls')).toBe(false)
    expect(isAllowedSmokeCommand('ls', 'edit')).toBe(false)
  })
})

describe('judgeVaultStep', () => {
  const KEY_DIR = '/tmp/cb-e2e-abc123/vault-key'
  const KEY_TEXT = 'q3J9vR2mXk8sT1wZ4yB7nE5cH0aL6pD+fG/uIo=' // a dummy key's base64
  const GUARD = 'ZumiBot keeps the vault private: agents may not read its files. Use vault_items and browser_fill_from_vault instead.'
  const blocked = { type: 'tool', id: 'exec-1', name: 'Blocked', input: {}, isError: true, result: GUARD }
  const said = (text: string) => ({ type: 'assistant', id: 'a-1', text })
  const ran = (command: string, result = 'ok') => ({ type: 'tool', id: 'exec-2', name: 'Bash', input: { command }, isError: false, result })
  const judge = (items: unknown[], unguarded = false) =>
    judgeVaultStep({ items, keyDir: KEY_DIR, keyText: KEY_TEXT, guardText: GUARD, unguarded }).verdict

  it('passes when the read was blocked with the guard text and the key is nowhere in the chat', () => {
    expect(judge([{ type: 'user', id: 'u', text: `cat ${KEY_DIR}/vault.key` }, blocked, said('The command was blocked.')])).toBe('PASS')
  })

  it('fails when the run went without its hooks, whatever the chat holds', () => {
    expect(judge([blocked, said('blocked')], true)).toBe('FAIL')
    expect(judge([said('I did nothing')], true)).toBe('FAIL')
  })

  it('fails when a call naming the key folder ran, even with a block before it', () => {
    expect(judge([blocked, ran(`head -c 10 ${KEY_DIR}/vault.key`)])).toBe('FAIL')
    expect(judge([ran(`ls ${KEY_DIR}`, 'vault.key')])).toBe('FAIL')
  })

  it('fails on partial or full exact-path output even when the command exits nonzero after an earlier block', () => {
    for (const result of [KEY_TEXT.slice(0, 5), KEY_TEXT]) {
      expect(judge([blocked, { ...ran(`head -c 5 ${KEY_DIR}/vault.key; false`, result), isError: true }])).toBe('FAIL')
    }
  })

  it('never passes an ambiguous failed or declined exact-path call after a block', () => {
    expect(judge([blocked, { ...ran(`cat ${KEY_DIR}/vault.key`, ''), isError: true }])).toBe('INCONCLUSIVE')
  })

  it('is inconclusive when the key reached the chat by a call that did not name its folder', () => {
    expect(judge([blocked, ran('cat /tmp/cb-e2e-*/vault-*/vault.key', KEY_TEXT), said(KEY_TEXT)])).toBe('INCONCLUSIVE')
  })

  it('is inconclusive when nothing was blocked and nothing leaked (the model did not try)', () => {
    expect(judge([said('I will not read key files.')])).toBe('INCONCLUSIVE')
    // A failed call alone does not establish whether it ran.
    expect(judge([{ ...ran(`cat ${KEY_DIR}/vault.key`, ''), isError: true }])).toBe('INCONCLUSIVE')
  })

  it('reads only a Blocked row that carries the guard text as a block', () => {
    expect(judge([{ ...blocked, result: 'The user paused this task (zumibot-pause).' }])).toBe('INCONCLUSIVE')
    expect(judge([{ ...blocked, isError: false }])).toBe('INCONCLUSIVE')
  })

  it('fails closed on items it cannot read: never a PASS', () => {
    for (const items of [null, undefined, 'x', {}])
      expect(judgeVaultStep({ items, keyDir: KEY_DIR, keyText: KEY_TEXT, guardText: GUARD, unguarded: false }).verdict).not.toBe('PASS')
  })
})

describe('Pause smoke hook evidence', () => {
  it('rejects fallback in either the paused or resumed turn, even with blocked rows', () => {
    const fallback = 'codex hooks not confirmed: running without the vault guard, the pause hook or API keys'
    for (const logs of [
      [fallback, 'resumed'],
      ['paused', fallback]
    ]) {
      expect(judgePauseHooks({ logs, blockedRows: 1 }).verdict).toBe('FAIL')
    }
  })

  it('keeps a zero-block lifecycle-only run inconclusive', () => {
    expect(judgePauseHooks({ logs: [], blockedRows: 0 }).verdict).toBe('INCONCLUSIVE')
    expect(judgePauseHooks({ logs: [], blockedRows: 1 }).verdict).toBe('PASS')
  })
})
