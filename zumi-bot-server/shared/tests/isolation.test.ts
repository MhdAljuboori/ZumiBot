import { describe, expect, it } from 'vitest'
import { hostAllowed, hostError, parseIsolation, pathError, sandboxBlockLine, sandboxBlocks, WEBFETCH_BLOCKED } from '../src/isolation'

describe('parseIsolation', () => {
  it('takes a full value, lower-cases hosts, trims trailing slashes and drops repeats', () => {
    expect(
      parseIsolation({
        level: 'sandbox',
        network: ['Registry.NPMjs.org', '*.github.com', 'registry.npmjs.org'],
        write: ['/srv/out/'],
        read: ['/opt/data'],
        webSearch: true,
        autoBash: false
      })
    ).toEqual({
      level: 'sandbox',
      network: ['registry.npmjs.org', '*.github.com'],
      write: ['/srv/out'],
      read: ['/opt/data'],
      webSearch: true,
      autoBash: false
    })
  })
  it('fills missing lists and switches as empty and off', () => {
    expect(parseIsolation({ level: 'off' })).toEqual({ level: 'off', network: [], write: [], read: [], webSearch: false, autoBash: false })
  })
  it.each([
    [null],
    ['sandbox'],
    [{ level: 'vm' }],
    [{ level: 'sandbox', network: 'a.com' }],
    [{ level: 'sandbox', network: ['https://a.com'] }],
    [{ level: 'sandbox', network: ['a.com:443'] }],
    [{ level: 'sandbox', network: ['10.0.0.1'] }],
    [{ level: 'sandbox', write: ['rel/path'] }],
    [{ level: 'sandbox', write: ['/a/../etc'] }],
    [{ level: 'sandbox', write: ['/'] }],
    [{ level: 'sandbox', autoBash: 'yes' }],
    [{ level: 'sandbox', network: Array.from({ length: 51 }, (_, i) => `h${i}.com`) }],
    [{ level: 'sandbox', network: ['*.com'] }]
  ])('refuses %j', (v) => {
    expect(() => parseIsolation(v)).toThrow(TypeError)
  })
})

describe('hosts and paths', () => {
  it('accepts names, wildcards, localhost and 127.0.0.1 only', () => {
    expect(hostError('api.github.com')).toBeNull()
    expect(hostError('*.npmjs.org')).toBeNull()
    expect(hostError('localhost')).toBeNull()
    expect(hostError('127.0.0.1')).toBeNull()
    expect(hostError('192.168.1.1')).toMatch(/IP address/)
    expect(hostError('a.com/x')).toMatch(/host name only/)
  })
  it('a wildcard covers sub-domains, not the bare domain or a look-alike', () => {
    expect(hostAllowed('registry.npmjs.org', ['*.npmjs.org'])).toBe(true)
    expect(hostAllowed('npmjs.org', ['*.npmjs.org'])).toBe(false)
    expect(hostAllowed('evilnpmjs.org', ['*.npmjs.org'])).toBe(false)
    expect(hostAllowed('Example.COM.', ['example.com'])).toBe(true)
    expect(hostAllowed('example.com.evil.net', ['example.com'])).toBe(false)
    expect(hostAllowed('example.com', [])).toBe(false)
  })
  it('paths must be absolute and plain', () => {
    expect(pathError('/home/u/proj')).toBeNull()
    expect(pathError('~/proj')).toMatch(/absolute/)
    expect(pathError('/a//b')).not.toBeNull()
  })
})

describe('sandboxBlocks', () => {
  it("reads the CLI's network violation block (as the real CLI printed it in the phase 2 probe)", () => {
    const text =
      'Exit code 56\ncurl: (56) CONNECT tunnel failed, response 403\n000\n<sandbox_violations>\ndeny network-outbound api.github.com:443 (host is not on the allow list)\n</sandbox_violations>'
    const blocks = sandboxBlocks(text)
    expect(blocks).toEqual([{ kind: 'network', target: 'api.github.com' }])
    expect(sandboxBlockLine(blocks)).toBe('Blocked by the sandbox: api.github.com')
  })
  it("reads ZumiBot's own WebFetch refusal and the CLI's outside-the-folders refusal", () => {
    expect(sandboxBlocks(WEBFETCH_BLOCKED('evil.example'))).toEqual([{ kind: 'network', target: 'evil.example' }])
    const outside =
      '/home/u/secret.txt is outside /home/u/work; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories.'
    expect(sandboxBlocks(outside)).toEqual([{ kind: 'file', target: '/home/u/secret.txt' }])
  })
  it('reads "Read-only file system" only when the caller knows the run was sandboxed', () => {
    const text = '/bin/bash: line 4: /home/u/.nvm/x.txt: Read-only file system'
    expect(sandboxBlocks(text)).toEqual([])
    expect(sandboxBlocks(text, { osErrors: true })).toEqual([{ kind: 'file', target: '/home/u/.nvm/x.txt' }])
  })
  it('finds nothing in an ordinary failure', () => {
    expect(sandboxBlocks('Exit code 1\nls: cannot access x: No such file or directory')).toEqual([])
    expect(sandboxBlockLine([])).toBeNull()
  })
})
