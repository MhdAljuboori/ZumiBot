import { describe, expect, it } from 'vitest'
import {
  threadParams,
  codexInput,
  codexCompactLimit,
  CODEX_COMPACT_FLOOR,
  hookConfig,
  type CodexHook,
  type CodexThreadInput
} from '../../src/core/codex/codexParams'
import { codexAnswer } from '../../src/core/codex/codexAnswers'
import { allowResponse, denyResponse, errorResponse } from '../../src/core/chat/controlProtocol'
import type { McpServerSpec } from '../../src/core/ipc/mcpSpec'

const ask: McpServerSpec = {
  name: 'zumibot_agents',
  command: '/usr/bin/node',
  args: ['/x/askBridge.mjs'],
  passEnv: ['ZUMIBOT_ASKS_CAPABILITY', 'ZUMIBOT_ASKS_IPC'],
  fixedEnv: { ELECTRON_RUN_AS_NODE: '1' },
  alwaysLoad: true,
  timeoutMs: 86_400_000
}
const base = (over: Partial<CodexThreadInput> = {}): CodexThreadInput => ({
  cwd: '/w',
  baseInstructions: 'be brief',
  permissionMode: 'manual',
  mcpServers: [],
  ...over
})

describe('codexCompactLimit', () => {
  it('with the window known, sends the limit only below it', () => {
    expect(codexCompactLimit(200_000, 258_400)).toBe(200_000)
    expect(codexCompactLimit(258_399, 258_400)).toBe(258_399)
    // At or past the window codex would never compact before it fills: none, so it compacts by itself near its end.
    expect(codexCompactLimit(258_400, 258_400)).toBeNull()
    expect(codexCompactLimit(400_000, 258_400)).toBeNull()
    expect(codexCompactLimit(600_000, 1_000_000)).toBe(600_000)
  })

  it('with the window not known yet, sends only a limit below the floor', () => {
    expect(CODEX_COMPACT_FLOOR).toBe(200_000)
    expect(codexCompactLimit(150_000, null)).toBe(150_000)
    expect(codexCompactLimit(199_999, null)).toBe(199_999)
    expect(codexCompactLimit(200_000, null)).toBeNull()
    expect(codexCompactLimit(400_000, null)).toBeNull()
  })

  it('no limit of the agent sends none', () => {
    expect(codexCompactLimit(null, 258_400)).toBeNull()
    expect(codexCompactLimit(null, null)).toBeNull()
  })
})

describe('threadParams', () => {
  it('manual mode asks the user for everything untrusted', () => {
    const p = threadParams(base())
    expect(p).toMatchObject({
      cwd: '/w',
      baseInstructions: 'be brief',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write'
    })
    expect(p.config).toEqual({
      'sandbox_workspace_write.network_access': true,
      'features.multi_agent': false,
      model_reasoning_summary: 'auto'
    })
  })

  it('auto mode lets the reviewer decide', () => {
    const p = threadParams(base({ permissionMode: 'auto' }))
    expect(p).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' })
  })

  it('never emits a bypass value, in either mode', () => {
    for (const permissionMode of ['manual', 'auto'] as const) {
      for (const sandbox of [undefined, 'read-only', 'workspace-write'] as const) {
        const json = JSON.stringify(threadParams(base({ permissionMode, sandbox, mcpServers: [ask] })))
        for (const bad of ['danger-full-access', '"never"', 'bypass']) expect(json).not.toContain(bad)
      }
    }
  })

  it('sandbox defaults to workspace-write, and a side run may ask for read-only', () => {
    expect(threadParams(base()).sandbox).toBe('workspace-write')
    expect(threadParams(base({ sandbox: 'workspace-write' })).sandbox).toBe('workspace-write')
    const ro = threadParams(base({ sandbox: 'read-only' }))
    expect(ro).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' })
    expect(ro.config).toEqual(threadParams(base()).config)
  })

  it('sends the auto-compact token limit as a config key only when given, on top of the other keys', () => {
    expect((threadParams(base()).config as any).model_auto_compact_token_limit).toBeUndefined()
    expect('model_auto_compact_token_limit' in (threadParams(base()).config as object)).toBe(false)
    const p = threadParams(base({ autoCompactTokenLimit: 400_000, mcpServers: [ask] }))
    expect((p.config as any).model_auto_compact_token_limit).toBe(400_000)
    expect((p.config as any)['features.multi_agent']).toBe(false)
  })

  it('leaves model out unless given', () => {
    expect('model' in threadParams(base())).toBe(false)
    expect(threadParams(base({ model: 'gpt-5' })).model).toBe('gpt-5')
  })

  it('turns an MCP spec into a dotted-key server entry', () => {
    const p = threadParams(base({ mcpServers: [ask] }))
    expect((p.config as any)['mcp_servers.zumibot_agents']).toEqual({
      command: '/usr/bin/node',
      args: ['/x/askBridge.mjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      env_vars: ['ZUMIBOT_ASKS_CAPABILITY', 'ZUMIBOT_ASKS_IPC'],
      tool_timeout_sec: 86400
    })
  })

  it('omits tool_timeout_sec without a timeout and rounds up', () => {
    const none = threadParams(base({ mcpServers: [{ ...ask, timeoutMs: undefined }] }))
    expect('tool_timeout_sec' in (none.config as any)['mcp_servers.zumibot_agents']).toBe(false)
    const odd = threadParams(base({ mcpServers: [{ ...ask, timeoutMs: 1500 }] }))
    expect((odd.config as any)['mcp_servers.zumibot_agents'].tool_timeout_sec).toBe(2)
  })

  // Check 11: a thread's `config` hooks are ignored, so hooks go on the app-server's argv only.
  it('never puts hooks in the request: the same bytes with or without them', () => {
    const hook: CodexHook = { event: 'preToolUse', matcher: null, command: 'exit 2', timeoutSec: 30 }
    expect(JSON.stringify(threadParams(base({ hooks: [hook], mcpServers: [ask] })))).toBe(
      JSON.stringify(threadParams(base({ mcpServers: [ask] })))
    )
  })

  it('pins the request bytes of a run without subagents', () => {
    expect(JSON.stringify(threadParams(base()))).toBe(
      '{"cwd":"/w","baseInstructions":"be brief","approvalPolicy":"untrusted","approvalsReviewer":"user","sandbox":"workspace-write","config":{"sandbox_workspace_write.network_access":true,"features.multi_agent":false,"model_reasoning_summary":"auto"}}'
    )
    expect(JSON.stringify(threadParams(base(), { subagents: false }))).toBe(JSON.stringify(threadParams(base())))
  })

  // Check 13 ran subagents with `--enable multi_agent` and no `features.multi_agent` key in the thread config.
  it('subagents drop the thread-level multi_agent switch and nothing else', () => {
    const on = threadParams(base({ autoCompactTokenLimit: 400_000, mcpServers: [ask] }), { subagents: true })
    const off = threadParams(base({ autoCompactTokenLimit: 400_000, mcpServers: [ask] }))
    expect('features.multi_agent' in (on.config as object)).toBe(false)
    const { 'features.multi_agent': _dropped, ...rest } = off.config as Record<string, unknown>
    expect(on).toEqual({ ...off, config: rest })
  })
})

describe('hookConfig', () => {
  const hook = (o: Partial<CodexHook> = {}): CodexHook => ({
    event: 'preToolUse',
    matcher: null,
    command: "sh '/tmp/codex-probe-4EIde6/probe-hook.sh'",
    timeoutSec: 5,
    ...o
  })
  const KEY = '/<session-flags>/config.toml:pre_tool_use:0:0'

  it('no hooks: no arguments at all', () => {
    expect(hookConfig([])).toEqual([])
    expect(hookConfig([], new Map([[KEY, 'sha256:x']]))).toEqual([])
  })

  it("one hook gives exactly check 11's -c shape: an inline array of groups, matcher left out, timeout in seconds", () => {
    expect(hookConfig([hook()])).toEqual([
      '-c',
      `hooks.PreToolUse=[{hooks=[{type="command",command="sh '/tmp/codex-probe-4EIde6/probe-hook.sh'",timeout=5}]}]`
    ])
  })

  it('a known trust table adds the inline hooks.state table that check 11 trusted it with (the dotted form is ignored by codex)', () => {
    const hash = 'sha256:f88b6772ec95305c4323a9df1cb437aeb46da5e48dc75eedcc498c3481beb24a'
    expect(hookConfig([hook()], new Map([[KEY, hash]]))).toEqual([
      '-c',
      `hooks.PreToolUse=[{hooks=[{type="command",command="sh '/tmp/codex-probe-4EIde6/probe-hook.sh'",timeout=5}]}]`,
      '-c',
      `hooks.state={"${KEY}"={trusted_hash="${hash}"}}`
    ])
    // An empty or missing table trusts nothing, so no state argument.
    expect(hookConfig([hook()], new Map())).toEqual(hookConfig([hook()]))
    expect(hookConfig([hook()], null)).toEqual(hookConfig([hook()]))
  })

  it('one group per hook, in order; a matcher leads its group', () => {
    const args = hookConfig([hook({ command: 'a', matcher: 'Bash', timeoutSec: 30 }), hook({ command: 'b', timeoutSec: 30 })])
    expect(args).toEqual([
      '-c',
      'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="a",timeout=30}]},{hooks=[{type="command",command="b",timeout=30}]}]'
    ])
  })

  it('commands are TOML basic strings: quotes, backslashes and line breaks escaped', () => {
    const [, value] = hookConfig([hook({ command: 'printf "%s\\n" x\n[ -e "$F" ] || exit 0' })])
    expect(value).toBe(
      'hooks.PreToolUse=[{hooks=[{type="command",command="printf \\"%s\\\\n\\" x\\n[ -e \\"$F\\" ] || exit 0",timeout=5}]}]'
    )
  })

  it('tab and line feed are carried by their TOML escapes; a surrogate pair is plain text', () => {
    expect(hookConfig([hook({ command: 'a\tb\nc' })])[1]).toContain('command="a\\tb\\nc"')
    expect(hookConfig([hook({ command: 'echo 😀' })])[1]).toContain('command="echo 😀"')
  })

  // TOML forbids control characters in a string and has no escape for a lone surrogate; JSON.stringify would let U+007F
  // through raw and write a surrogate as an escape TOML rejects. Such a hook set gives no hooks at all, so runCodex fails closed.
  it.each([
    ['U+007F', 'echo \u007f'],
    ['U+0000', 'echo \u0000'],
    ['U+0001', 'echo \u0001'],
    ['U+001F', 'echo \u001f'],
    ['a carriage return', 'echo a\rb'],
    ['a lone high surrogate', 'echo \ud800'],
    ['a lone low surrogate', 'echo \udc00x'],
    ['a reversed pair', 'echo \udc00\ud800']
  ])('a command holding %s gives no hooks', (_n, command) => {
    expect(hookConfig([hook({ command })])).toEqual([])
    // The whole set goes, never part of it.
    expect(hookConfig([hook(), hook({ command })])).toEqual([])
  })

  it('a matcher TOML cannot hold gives no hooks', () => {
    expect(hookConfig([hook({ matcher: 'Bash\u007f' })])).toEqual([])
  })

  it.each([2.5, 0, -1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2])('a timeout of %s seconds gives no hooks', (timeoutSec) => {
    expect(hookConfig([hook({ timeoutSec })])).toEqual([])
    expect(hookConfig([hook(), hook({ timeoutSec })])).toEqual([])
  })

  it('a trust entry TOML cannot hold gives no hooks either', () => {
    expect(hookConfig([hook()], new Map([[KEY, 'sha256:\u0000']]))).toEqual([])
    expect(hookConfig([hook()], new Map([['\ud800', 'sha256:x']]))).toEqual([])
  })
})

describe('codexInput', () => {
  it('maps text and base64 images', () => {
    expect(
      codexInput([
        { type: 'text', text: 'a' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QQ==' } }
      ])
    ).toEqual([
      { type: 'text', text: 'a', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,QQ==' }
    ])
  })

  it('appends a skill item per ref after the content', () => {
    expect(codexInput('$pdf a', [{ name: 'pdf', path: '/s/pdf/SKILL.md' }])).toEqual([
      { type: 'text', text: '$pdf a', text_elements: [] },
      { type: 'skill', name: 'pdf', path: '/s/pdf/SKILL.md' }
    ])
  })

  it('maps a plain string to one text input', () => {
    expect(codexInput('hi')).toEqual([{ type: 'text', text: 'hi', text_elements: [] }])
  })
})

describe('codexAnswer', () => {
  const allow = allowResponse('7', {})
  const deny = denyResponse('7', 'no')

  it('command and fileChange accept or decline', () => {
    expect(codexAnswer('command', allow, {})).toEqual({ result: { decision: 'accept' } })
    expect(codexAnswer('fileChange', deny, {})).toEqual({ result: { decision: 'decline' } })
  })

  it('permissions grant what was asked, for the turn, or nothing', () => {
    const request = { permissions: { network: { enabled: true } } }
    expect(codexAnswer('permissions', allow, request)).toEqual({ result: { permissions: request.permissions, scope: 'turn' } })
    expect(codexAnswer('permissions', deny, request)).toEqual({ result: { permissions: {}, scope: 'turn' } })
  })

  it('elicitation accepts or declines with no content', () => {
    expect(codexAnswer('elicitation', allow, {})).toEqual({ result: { action: 'accept', content: null, _meta: null } })
    expect(codexAnswer('elicitation', deny, {})).toEqual({ result: { action: 'decline', content: null, _meta: null } })
  })

  describe('userInput', () => {
    const request = {
      questions: [
        { id: 'color', question: 'Which?' },
        { id: 'size', question: 'How big?' }
      ]
    }
    const input = {
      questions: [
        { question: 'Which?', header: 'Color', multiSelect: false, codexId: 'color', options: [{ label: 'Blue', description: null }] },
        { question: 'How big?', header: 'Size', kind: 'text', multiSelect: false, codexId: 'size', options: [] }
      ]
    }

    it('an allow maps the card answers, keyed by question text, onto the codex ids', () => {
      const answers = { 'Which?': 'Blue', 'How big?': 'Large' }
      expect(codexAnswer('userInput', allowResponse('7', { ...input, answers }), request)).toEqual({
        result: { answers: { color: { answers: ['Blue'] }, size: { answers: ['Large'] } } }
      })
    })

    it('a list answer stays a list; blank and unknown answers are left out', () => {
      const answers = { 'Which?': ['Blue', 'Other text', ' '], 'How big?': '' }
      expect(codexAnswer('userInput', allowResponse('7', { ...input, answers }), request)).toEqual({
        result: { answers: { color: { answers: ['Blue', 'Other text'] } } }
      })
    })

    it('an id the request never asked is not answered', () => {
      const forged = { questions: [{ question: 'Q', codexId: 'evil' }, input.questions[0]], answers: { Q: 'x', 'Which?': 'Blue' } }
      expect(codexAnswer('userInput', allowResponse('7', forged), request)).toEqual({
        result: { answers: { color: { answers: ['Blue'] } } }
      })
    })

    it('Skip (deny) answers with no answers', () => {
      expect(codexAnswer('userInput', deny, request)).toEqual({ result: { answers: {} } })
    })

    it('an allow with no answers is an empty answer, never a crash', () => {
      expect(codexAnswer('userInput', allow, request)).toEqual({ result: { answers: {} } })
      expect(codexAnswer('userInput', allowResponse('7', { ...input, answers: 5 }), request)).toEqual({ result: { answers: {} } })
    })

    it('an error response stays an error, and so does an unrecognised one', () => {
      expect(codexAnswer('userInput', errorResponse('7', 'boom'), request)).toEqual({ error: { code: -32603, message: 'boom' } })
      expect(codexAnswer('userInput', { type: 'x' }, request)).toEqual({ error: { code: -32603, message: 'Unrecognised answer' } })
    })
  })

  it('an error response becomes an internal error', () => {
    for (const k of ['command', 'fileChange', 'permissions', 'elicitation'] as const) {
      expect(codexAnswer(k, errorResponse('7', 'boom'), {})).toEqual({ error: { code: -32603, message: 'boom' } })
    }
  })

  it('an unrecognised control response is refused, never allowed', () => {
    expect(codexAnswer('command', { type: 'x' }, {})).toEqual({ error: { code: -32603, message: 'Unrecognised answer' } })
  })
})
