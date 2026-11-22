import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hooksTrusted, trustTable } from '../../src/core/codex/codexHookTrust'
import type { CodexHook } from '../../src/core/codex/codexParams'

// The trust boundary: which `hooks/list` entries count as ZumiBot's own hooks, and when they count as trusted.

const FIX = join(__dirname, '..', 'fixtures', 'codex')
// The first hooks/list answer a recording holds.
const recordedListing = (name: string) =>
  readFileSync(join(FIX, name), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((l) => l.dir === 'in' && l.msg?.result?.data)!.msg.result

const PROBE_CMD = "sh '/tmp/codex-probe-4EIde6/probe-hook.sh'"
const PROBE_KEY = '/<session-flags>/config.toml:pre_tool_use:0:0'
const PROBE_HASH = 'sha256:f88b6772ec95305c4323a9df1cb437aeb46da5e48dc75eedcc498c3481beb24a'
const hook = (command = PROBE_CMD, matcher: string | null = null): CodexHook => ({ event: 'preToolUse', matcher, command, timeoutSec: 5 })

// One hooks/list entry in check 11's shape.
const entry = (over: Record<string, unknown> = {}) => ({
  key: PROBE_KEY,
  eventName: 'preToolUse',
  handlerType: 'command',
  command: PROBE_CMD,
  async: false,
  matcher: null,
  timeoutSec: 5,
  statusMessage: null,
  additionalContextLimit: null,
  sourcePath: '/<session-flags>/config.toml',
  source: 'sessionFlags',
  pluginId: null,
  displayOrder: 0,
  enabled: true,
  isManaged: false,
  currentHash: PROBE_HASH,
  trustStatus: 'trusted',
  ...over
})
const listing = (...hooks: unknown[]) => ({ data: [{ cwd: '/w', hooks, warnings: [], errors: [] }] })

describe('trustTable and hooksTrusted on the recorded check 11 answers', () => {
  it('the trusted run (codex-check11.jsonl): the hash is read and the hook is trusted', () => {
    const listed = recordedListing('codex-check11.jsonl')
    expect(trustTable(listed, [hook()])).toEqual(new Map([[PROBE_KEY, PROBE_HASH]]))
    expect(hooksTrusted(listed, [hook()])).toBe(true)
  })

  it('the -c hook nobody trusted (codex-check11-cli.jsonl): the hash is still read, which is how the pre-flight learns it, but it is not trusted', () => {
    const listed = recordedListing('codex-check11-cli.jsonl')
    expect(trustTable(listed, [hook()])).toEqual(new Map([[PROBE_KEY, PROBE_HASH]]))
    expect(hooksTrusted(listed, [hook()])).toBe(false)
  })

  it('another command than the recorded one finds nothing in either', () => {
    for (const f of ['codex-check11.jsonl', 'codex-check11-cli.jsonl']) {
      expect(trustTable(recordedListing(f), [hook('exit 2')])).toBeNull()
      expect(hooksTrusted(recordedListing(f), [hook('exit 2')])).toBe(false)
    }
  })
})

describe("trustTable and hooksTrusted read only ZumiBot's own session-flag hooks", () => {
  it('a user or project hook with the same command is never used, even trusted', () => {
    for (const source of ['user', 'project']) {
      const other = entry({
        source,
        key: `/home/u/.codex/config.toml:pre_tool_use:0:0`,
        sourcePath: '/home/u/.codex/config.toml',
        currentHash: 'sha256:other'
      })
      expect(trustTable(listing(other), [hook()])).toBeNull()
      expect(hooksTrusted(listing(other), [hook()])).toBe(false)
      // Beside our own untrusted entry it neither stands in for it nor joins the table.
      const ours = entry({ trustStatus: 'untrusted' })
      expect(hooksTrusted(listing(other, ours), [hook()])).toBe(false)
      expect(trustTable(listing(other, ours), [hook()])).toEqual(new Map([[PROBE_KEY, PROBE_HASH]]))
      expect(hooksTrusted(listing(other, entry()), [hook()])).toBe(true)
    }
  })

  it('an entry of another event is not ours', () => {
    expect(trustTable(listing(entry({ eventName: 'postToolUse' })), [hook()])).toBeNull()
    expect(hooksTrusted(listing(entry({ eventName: 'postToolUse' })), [hook()])).toBe(false)
  })

  it('a disabled entry fails, trusted or not', () => {
    expect(hooksTrusted(listing(entry({ enabled: false })), [hook()])).toBe(false)
  })

  it('anything but trusted fails closed', () => {
    for (const trustStatus of ['untrusted', 'modified', '', null, undefined])
      expect(hooksTrusted(listing(entry({ trustStatus })), [hook()])).toBe(false)
  })

  it('one command used by two hooks needs two entries, each used once, and both must be trusted', () => {
    const two = [hook(PROBE_CMD, 'Bash'), hook(PROBE_CMD, 'apply_patch')]
    const second = entry({
      key: '/<session-flags>/config.toml:pre_tool_use:1:0',
      matcher: 'apply_patch',
      currentHash: 'sha256:second',
      displayOrder: 1
    })
    expect(trustTable(listing(entry()), two)).toBeNull()
    expect(hooksTrusted(listing(entry()), two)).toBe(false)
    expect(trustTable(listing(entry(), second), two)).toEqual(
      new Map([
        [PROBE_KEY, PROBE_HASH],
        ['/<session-flags>/config.toml:pre_tool_use:1:0', 'sha256:second']
      ])
    )
    expect(hooksTrusted(listing(entry(), second), two)).toBe(true)
    expect(hooksTrusted(listing(entry(), { ...second, trustStatus: 'untrusted' }), two)).toBe(false)
  })

  it('an entry without a key or hash gives no table', () => {
    expect(trustTable(listing(entry({ key: '' })), [hook()])).toBeNull()
    expect(trustTable(listing(entry({ currentHash: null })), [hook()])).toBeNull()
  })

  it('an answer of the wrong shape is no table and no trust', () => {
    for (const bad of [
      null,
      undefined,
      'x',
      {},
      { data: 'x' },
      { data: [] },
      { data: [null] },
      { data: [{ hooks: 'x' }] },
      listing(null, 5, 'x')
    ]) {
      expect(trustTable(bad, [hook()])).toBeNull()
      expect(hooksTrusted(bad, [hook()])).toBe(false)
    }
  })

  it('no hooks is no table and no trust', () => {
    expect(trustTable(listing(entry()), [])).toBeNull()
    expect(hooksTrusted(listing(entry()), [])).toBe(false)
  })
})
