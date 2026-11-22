import { describe, expect, it } from 'vitest'
import {
  ACP_ASK_MODE,
  ACP_STUDIO_TEXT,
  ACP_TEXT,
  ACP_YES_NO,
  acpLaunchError,
  launchRecord,
  parseAcpLaunch,
  refusedArg,
  refusedMode
} from '@zumibot/shared/acp'

describe('parseAcpLaunch', () => {
  it('reads a full launch', () => {
    expect(parseAcpLaunch({ command: 'gemini', args: ['--acp'], authEnv: ['GEMINI_API_KEY'] })).toEqual({
      command: 'gemini',
      args: ['--acp'],
      authEnv: ['GEMINI_API_KEY']
    })
  })
  it('defaults args and authEnv to empty lists', () => {
    expect(parseAcpLaunch({ command: '/usr/bin/x' })).toEqual({ command: '/usr/bin/x', args: [], authEnv: [] })
  })
  it.each([null, undefined, 'gemini', 3, [], [{ command: 'x' }], {}, { command: '' }, { command: 4 }, { command: ['x'] }])(
    'rejects %j',
    (v) => {
      expect(parseAcpLaunch(v)).toBeNull()
    }
  )
  it('rejects a NUL or a too long command', () => {
    expect(parseAcpLaunch({ command: 'a\0b' })).toBeNull()
    expect(parseAcpLaunch({ command: 'a'.repeat(4097) })).toBeNull()
    expect(parseAcpLaunch({ command: 'a'.repeat(4096) })).not.toBeNull()
  })
  it('rejects bad args', () => {
    expect(parseAcpLaunch({ command: 'x', args: 'a' })).toBeNull()
    expect(parseAcpLaunch({ command: 'x', args: [1] })).toBeNull()
    expect(parseAcpLaunch({ command: 'x', args: ['a\0'] })).toBeNull()
    expect(parseAcpLaunch({ command: 'x', args: ['a'.repeat(4097)] })).toBeNull()
    expect(parseAcpLaunch({ command: 'x', args: Array(65).fill('a') })).toBeNull()
    expect(parseAcpLaunch({ command: 'x', args: Array(64).fill('a') })).not.toBeNull()
  })
  it('rejects bad authEnv', () => {
    expect(parseAcpLaunch({ command: 'x', authEnv: 'A' })).toBeNull()
    expect(parseAcpLaunch({ command: 'x', authEnv: [1] })).toBeNull()
    expect(parseAcpLaunch({ command: 'x', authEnv: ['lower'] })).toBeNull()
    expect(parseAcpLaunch({ command: 'x', authEnv: ['PATH'] })).toBeNull()
    expect(parseAcpLaunch({ command: 'x', authEnv: Array.from({ length: 17 }, (_, i) => `KEY_${i}A`) })).toBeNull()
    expect(parseAcpLaunch({ command: 'x', authEnv: Array.from({ length: 16 }, (_, i) => `KEY_${i}A`) })).not.toBeNull()
  })
})

describe('acpLaunchError', () => {
  const shapes: unknown[] = [
    null,
    undefined,
    'gemini',
    3,
    [],
    {},
    { command: '' },
    { command: 4 },
    { command: 'a\0b' },
    { command: 'a'.repeat(4097) },
    { command: 'x', args: 'a' },
    { command: 'x', args: [1] },
    { command: 'x', args: ['a\0'] },
    { command: 'x', args: Array(65).fill('a') },
    { command: 'x', authEnv: 'A' },
    { command: 'x', authEnv: ['lower'] },
    { command: 'x', authEnv: Array.from({ length: 17 }, (_, i) => `KEY_${i}A`) },
    { command: 'gemini' },
    { command: 'gemini', args: ['--acp'], authEnv: ['GEMINI_API_KEY'] },
    { command: 'a'.repeat(4096), args: Array(64).fill('a') }
  ]
  it('is null exactly when parseAcpLaunch reads the value', () => {
    for (const v of shapes) expect([v, acpLaunchError(v) === null]).toEqual([v, parseAcpLaunch(v) !== null])
  })
  it('names what is wrong with a fixed sentence', () => {
    expect(acpLaunchError({ command: '' })).toBe(ACP_TEXT.commandRequired)
    expect(acpLaunchError({})).toBe(ACP_TEXT.commandRequired)
    expect(acpLaunchError({ command: 'a\0b' })).toBe(ACP_TEXT.commandInvalid)
    expect(acpLaunchError({ command: 'x', args: [8080] })).toBe(ACP_TEXT.argsInvalid)
    expect(acpLaunchError({ command: 'x', authEnv: ['lower'] })).toBe(ACP_TEXT.authEnvInvalid)
    // Never the value itself.
    expect(acpLaunchError({ command: 'x', args: ['--key=secret\0'] })).not.toContain('secret')
  })
})

describe('refusedArg', () => {
  it.each([
    [['--yolo'], '--yolo'],
    [['-y'], '-y'],
    [['--approval-mode', 'yolo'], '--approval-mode yolo'],
    [['--approval-mode=yolo'], '--approval-mode yolo'],
    [['--dangerously-skip-permissions'], '--dangerously-skip-permissions'],
    [['--dangerously-bypass-approvals-and-sandbox'], '--dangerously-bypass-approvals-and-sandbox'],
    [['--permission-mode', 'bypassPermissions'], '--permission-mode bypassPermissions'],
    [['--permission-mode=bypassPermissions'], '--permission-mode bypassPermissions'],
    [['--permission-mode', 'dontAsk'], '--permission-mode dontAsk'],
    [['--permission-mode=dontAsk'], '--permission-mode dontAsk'],
    [['--allow-all-tools'], '--allow-all-tools'],
    [['--trust-all-tools'], '--trust-all-tools'],
    [['--auto-approve'], '--auto-approve'],
    [['--force'], '--force'],
    [['-f'], '-f'],
    [['--acp', '--yolo'], '--yolo'],
    // A plain refused flag written with a value is the same flag.
    [['--yolo=true'], '--yolo'],
    [['--dangerously-skip-permissions=true'], '--dangerously-skip-permissions'],
    [['--force=1'], '--force'],
    [['-y='], '-y'],
    [['--acp', '--trust-all-tools=yes'], '--trust-all-tools']
  ])('refuses %j', (args, flag) => {
    expect(refusedArg(args)).toBe(flag)
  })
  it('does not refuse safe arguments', () => {
    expect(refusedArg([])).toBeNull()
    expect(refusedArg(['--acp'])).toBeNull()
    expect(refusedArg(['--approval-mode', 'default'])).toBeNull()
    expect(refusedArg(['--approval-mode=default'])).toBeNull()
    expect(refusedArg(['--permission-mode', 'plan'])).toBeNull()
    expect(refusedArg(['--approval-mode'])).toBeNull()
    for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])
      expect(refusedArg([name, 'x']), name).toBeNull()
    expect(refusedArg(['--approval-mode', 'toString'])).toBeNull()
    expect(refusedArg(['--permission-mode=constructor'])).toBeNull()
    // Only the part before the first `=` is the flag: a value naming a refused flag is no flag.
    expect(refusedArg(['--prompt=--yolo'])).toBeNull()
    expect(refusedArg(['--yolo-ish=1'])).toBeNull()
  })
})

describe('refusedMode', () => {
  it('refuses allow-everything ids', () => {
    for (const id of ['bypassPermissions', 'dontAsk', 'yolo', 'BYPASS_x', 'full-yolo', 'dangerous-mode', 'DangerousFull'])
      expect(refusedMode(id), id).toBe(true)
  })
  it('keeps ordinary ids', () => {
    for (const id of ['default', 'plan', 'auto', 'acceptEdits', 'ask']) expect(refusedMode(id), id).toBe(false)
    // The mode ZumiBot switches to is never one it refuses.
    expect(refusedMode(ACP_ASK_MODE)).toBe(false)
  })
})

describe('launchRecord', () => {
  it('is stable whatever the key order', () => {
    const a = launchRecord({ command: 'g', args: ['a'], authEnv: ['K_X'] })
    const b = launchRecord({ authEnv: ['K_X'], args: ['a'], command: 'g' })
    expect(a).toBe(b)
    expect(JSON.parse(a)).toEqual({ command: 'g', args: ['a'], authEnv: ['K_X'] })
    expect(launchRecord({ command: 'g', args: ['b'], authEnv: [] })).not.toBe(a)
  })
})

describe('ACP_TEXT', () => {
  it('has fixed sentences, naming only what it is given', () => {
    expect(ACP_TEXT.unreadable).toBe('The agent sent a reply ZumiBot could not read')
    expect(ACP_TEXT.notFound('gemini')).toContain('gemini')
    expect(ACP_TEXT.refusedArg('--yolo')).toContain('--yolo')
    expect(ACP_TEXT.refusedMode('yolo')).toContain('yolo')
    expect(ACP_TEXT.askModeFailed).toContain('"default" mode')
    expect(ACP_TEXT.authEnvMissing('GEMINI_API_KEY')).toContain('GEMINI_API_KEY')
    expect(ACP_TEXT.stopped(3)).toContain('3')
    expect(ACP_TEXT.stopReason('refusal')).toContain('refusal')
    expect(ACP_TEXT.notSignedIn(['Google login'])).toContain('Google login')
    expect(ACP_TEXT.notSignedIn([])).toBeTruthy()
    for (const s of [ACP_TEXT.protocol, ACP_TEXT.untrusted, ACP_TEXT.noImages]) expect(s.length).toBeGreaterThan(10)
    expect(ACP_TEXT.untrusted).toContain('Agent Studio')
    expect(ACP_TEXT.toolUnfinished).toBe('The tool call did not finish.')
  })
  it('refuses images only: any other attachment reaches the agent as a path note, as for Codex', () => {
    expect(ACP_TEXT.noImages).toMatch(/images/)
    expect(ACP_TEXT.noImages).not.toMatch(/attachment/)
  })
  it('a refused mode names the way forward, since the session keeps that mode on every later turn', () => {
    const s = ACP_TEXT.refusedMode('bypassPermissions')
    expect(s).toContain('"bypassPermissions"')
    expect(s).toContain('Start a new chat')
    expect(s).toContain("agent's own settings")
  })
  it('says -f and --force are refused because they let some agents run commands without asking', () => {
    for (const flag of ['-f', '--force']) {
      expect(ACP_TEXT.refusedArg(flag)).toContain(flag)
      expect(ACP_TEXT.refusedArg(flag)).toContain('run commands without asking')
      expect(ACP_TEXT.refusedArg(flag)).toContain('cursor-agent')
    }
    expect(ACP_TEXT.refusedArg('--yolo')).not.toContain('cursor-agent')
  })
  it('hints that a number in the launch must be quoted when acp: cannot be read', () => {
    expect(ACP_TEXT.launchUnreadable).toContain('"8080"')
    expect(ACP_TEXT.commandRequired).toContain('ACP agent')
  })
  it('has the test sentences, naming only the command', () => {
    expect(ACP_TEXT.notStarted('gemini')).toContain('gemini')
    for (const s of [ACP_TEXT.notAcp, ACP_TEXT.testTimeout, ACP_TEXT.testRefused, ACP_TEXT.testUnavailable])
      expect(s.length).toBeGreaterThan(10)
    expect(ACP_TEXT.testTimeout).toContain('20 seconds')
  })
})

describe('ACP_STUDIO_TEXT', () => {
  it("holds the design's notes for the ACP card", () => {
    expect(ACP_STUDIO_TEXT.asks).toContain('can only show a card for a call the agent asks about')
    expect(ACP_STUDIO_TEXT.asks).toContain('its "default" mode before every message')
    // The mode does not make every call ask: the agent's allow rules still apply in it.
    expect(ACP_STUDIO_TEXT.asks).toContain('still decide which of its calls ask first')
    expect(ACP_STUDIO_TEXT.args).toContain('process list')
    expect(ACP_STUDIO_TEXT.signIn).toContain('can read its own env')
  })
})

describe('ACP_YES_NO', () => {
  it('is the fixed Yes / No pair of a boolean question', () => {
    expect(ACP_YES_NO).toEqual({ yes: 'Yes', no: 'No' })
  })
})
