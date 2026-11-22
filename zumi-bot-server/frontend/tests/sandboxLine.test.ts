import { describe, expect, it } from 'vitest'
import { sandboxFileBlocked, WEBFETCH_BLOCKED } from '@zumibot/shared/isolation'
import { sandboxRowLine, sandboxRunLine } from '../src/state/sandboxLine'

const net = '<sandbox_violations>\ndeny network-outbound api.github.com:443 (host is not on the allow list)\n</sandbox_violations>'

describe('sandbox lines in the chat', () => {
  it('a failed row the sandbox refused gets its line; an ordinary failure or a success none', () => {
    expect(sandboxRowLine({ type: 'tool', isError: true, result: `Exit code 56\n${net}` })).toBe('Blocked by the sandbox: api.github.com')
    // The CLI prefixes a hook's text; the file guard's line is still found.
    expect(
      sandboxRowLine({ type: 'tool', isError: true, result: `PreToolUse:Read hook error: [cmd]: ${sandboxFileBlocked('/home/u/x.txt')}` })
    ).toBe('Blocked by the sandbox: /home/u/x.txt')
    expect(sandboxRowLine({ type: 'tool', isError: true, result: 'No such file or directory' })).toBeNull()
    expect(sandboxRowLine({ type: 'tool', isError: false, result: net })).toBeNull()
  })
  it('a folded run names every refused target once', () => {
    const tools = [
      { type: 'thinking' },
      { type: 'tool', isError: true, result: net },
      { type: 'tool', isError: true, result: WEBFETCH_BLOCKED('api.github.com') },
      { type: 'tool', isError: true, result: sandboxFileBlocked('/etc/shadow') },
      { type: 'tool', isError: false, result: 'ok' }
    ]
    expect(sandboxRunLine(tools)).toBe('Blocked by the sandbox: api.github.com, /etc/shadow')
    expect(sandboxRunLine([{ type: 'tool', isError: false, result: 'ok' }])).toBeNull()
  })
})
