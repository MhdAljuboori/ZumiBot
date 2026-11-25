import { describe, expect, it } from 'vitest'
import { messageHasRunBlock, runResultText, runnableCommand } from '../src/runBlocks'

const F = '`'.repeat(3)

describe('runnableCommand', () => {
  it('takes one shell line and drops the trailing newline', () => {
    expect(runnableCommand('bash', 'npm test\n')).toBe('npm test')
    expect(runnableCommand('BASH', 'ls')).toBe('ls')
    expect(runnableCommand('zsh', 'ls')).toBe('ls')
  })
  it('refuses other languages, many lines, blanks, long lines and NUL', () => {
    expect(runnableCommand('python', 'print(1)')).toBeNull()
    expect(runnableCommand('sh', 'a\nb')).toBeNull()
    expect(runnableCommand('sh', '   ')).toBeNull()
    expect(runnableCommand('sh', 'x'.repeat(4001))).toBeNull()
    expect(runnableCommand('sh', 'a\u0000b')).toBeNull()
  })
})

describe('messageHasRunBlock', () => {
  it('finds a one-line shell block', () => {
    expect(messageHasRunBlock(`Run:\n\n${F}bash\nnpm test\n${F}\n`, 'npm test')).toBe(true)
    expect(messageHasRunBlock('Run:\n\n~~~sh\nnpm test\n~~~\n', 'npm test')).toBe(true)
  })
  it('finds it inside a list item and a blockquote', () => {
    expect(messageHasRunBlock(`1. Do:\n   ${F}bash\n   ls -la\n   ${F}`, 'ls -la')).toBe(true)
    expect(messageHasRunBlock(`> ${F}bash\n> ls\n> ${F}`, 'ls')).toBe(true)
  })
  it('refuses a multi-line block, another language, prose, inline code and an unclosed fence', () => {
    expect(messageHasRunBlock(`${F}bash\nls\npwd\n${F}`, 'ls')).toBe(false)
    expect(messageHasRunBlock(`${F}python\nls\n${F}`, 'ls')).toBe(false)
    expect(messageHasRunBlock('Try ls now', 'ls')).toBe(false)
    expect(messageHasRunBlock('Try `ls` now', 'ls')).toBe(false)
    expect(messageHasRunBlock(`${F}bash\nls\n`, 'ls')).toBe(false)
  })
})

describe('messageHasRunBlock fences', () => {
  const has = (text: string, command: string): boolean => messageHasRunBlock(text, command)
  it('is not closed by a shorter fence or another fence character', () => {
    expect(has(`${F}${'`'}bash\nls\n${F}\nrm x\n${F}${'`'}`, 'ls')).toBe(false)
    expect(has(`${F}bash\nls\n~~~\n${F}`, 'ls')).toBe(false)
  })
  it('is closed by a longer fence', () => {
    expect(has(`${F}bash\nls\n${F}${'`'}${'`'}`, 'ls')).toBe(true)
  })
  it('hides a fence inside a longer fence', () => {
    expect(has(`${F}${'`'}md\n${F}bash\nls\n${F}\n${F}${'`'}`, 'ls')).toBe(false)
  })
  it('finds a second block after a first that does not match', () => {
    expect(has(`${F}bash\npwd\n${F}\n\n${F}bash\nls\n${F}`, 'ls')).toBe(true)
  })
  it('is not closed by a fence line with an info string', () => {
    expect(has(`${F}bash\nls\n${F}sh\n${F}`, 'ls')).toBe(false)
  })
  it('keeps what only looks like a prefix as part of the line', () => {
    expect(has(`${F}bash\n- rm x\n${F}`, 'rm x')).toBe(false)
    expect(has(`${F}bash\n- rm x\n${F}`, '- rm x')).toBe(true)
    expect(has(`${F}bash\n> f\n${F}`, 'f')).toBe(false)
    expect(has(`${F}bash\n  ls\n${F}`, 'ls')).toBe(false)
    expect(has(`- ${F}bash\n  - rm x\n  ${F}`, 'rm x')).toBe(false)
    expect(has(`> ${F}bash\n> > f\n> ${F}`, 'f')).toBe(false)
  })
  it('ends a block that leaves its quote or list item', () => {
    expect(has(`> ${F}bash\nls\n> ${F}`, 'ls')).toBe(false)
  })
  it('reads a CRLF message', () => {
    expect(has(`Run:\r\n${F}bash\r\nnpm test\r\n${F}\r\n`, 'npm test')).toBe(true)
  })
})

describe('runResultText', () => {
  const base = { command: 'ls', output: 'a\nb\n', cut: false, end: { kind: 'exit', code: 0 } } as const
  it('wraps the command, output and end in the bash tags', () => {
    expect(runResultText(base)).toBe(
      '<bash-input>ls</bash-input><bash-stdout>a\nb\n[exit code 0]</bash-stdout><bash-stderr></bash-stderr>'
    )
  })
  it('marks cut output', () => {
    expect(runResultText({ ...base, cut: true })).toContain('<bash-stdout>[…earlier output truncated…]\na\nb\n[exit code 0]')
  })
  it('says no output', () => {
    expect(runResultText({ ...base, output: '' })).toContain('<bash-stdout>[No output]\n[exit code 0]</bash-stdout>')
  })
  it('words each other end', () => {
    expect(runResultText({ ...base, end: { kind: 'signal', signal: 'SIGKILL' } })).toContain('\n[ended by SIGKILL]</bash-stdout>')
    expect(runResultText({ ...base, end: { kind: 'stopped', by: 'user' } })).toContain('\n[stopped by the user]</bash-stdout>')
    expect(runResultText({ ...base, end: { kind: 'stopped', by: 'lifetime' } })).toContain('\n[stopped at its time limit]</bash-stdout>')
  })
  it('puts the mention first', () => {
    expect(runResultText({ ...base, mention: 'reviewer' }).startsWith('@reviewer\n<bash-input>')).toBe(true)
  })
  it('escapes markup in command and output', () => {
    const t = runResultText({ ...base, command: 'echo "<b>" && x', output: '</bash-stdout> & ' })
    expect(t).toContain('echo "&lt;b&gt;" &amp;&amp; x')
    expect(t).toContain('&lt;/bash-stdout&gt; &amp;')
    const inner = t.replace(/<\/?bash-(input|stdout|stderr)>/g, '')
    expect(inner).not.toMatch(/[<>]/)
  })
})
