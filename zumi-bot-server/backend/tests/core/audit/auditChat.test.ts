import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuditRecord } from '@zumibot/shared/audit'
import { connectorPrefixes } from '@zumibot/shared/connectors'
import type { AgentRule } from '@zumibot/shared/types'
import { AttachmentStore } from '../../../src/core/attachments/attachmentStore'
import { AuditLog } from '../../../src/core/audit/auditLog'
import { AuditService } from '../../../src/core/audit/auditService'
import { ChatService } from '../../../src/core/chat/chatService'
import { runClaude } from '../../../src/core/chat/claudeRunner'
import { agentAllowKey, ruleOf } from '../../../src/core/chat/controlProtocol'
import { NO_RUN_CONFIG } from '../../../src/core/extensions/agentRunConfig'
import { ChatStore } from '../../../src/core/store/chatStore'
import { AUDIT_GUARD_TEXT, vaultGuardSettings } from '../../../src/core/vault/vaultGuard'

// The fake claude CLI makes six calls, each decided another way; the audit log must name each one's decision.
const fake = fileURLToPath(new URL('../../fixtures/fake-claude.mjs', import.meta.url))

let dir: string
let store: ChatStore
let log: AuditLog
let ruleKeys: Set<string>

const line = (o: object) => JSON.stringify(o)
const use = (id: string, name: string, input: object) =>
  line({ type: 'assistant', session_id: 's-audit', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: string, isError = false) =>
  line({
    type: 'user',
    session_id: 's-audit',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }
  })
const ask = (req: string, id: string, name: string, input: object) =>
  line({ type: 'control_request', request_id: req, request: { subtype: 'can_use_tool', tool_name: name, input, tool_use_id: id } })

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-audit-chat-'))
  store = new ChatStore(join(dir, 'data'))
  log = new AuditLog({ dir: join(dir, 'data', 'audit'), machine: 'test0001', now: () => Date.now() })
  await log.start()
  ruleKeys = new Set()
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('audit log of a chat turn (fake claude)', () => {
  it('records allowed, remembered, approved, denied, hook-denied and rule-denied calls with their decisions', async () => {
    const auditDir = join(dir, 'data', 'audit')
    const guard = vaultGuardSettings({
      keyFile: join(dir, 'cfg', 'zumibot-vault', 'vault.key'),
      vaultFile: join(dir, 'data', 'vault.json'),
      home: '/nohome',
      auditDir
    })
    const script = join(dir, 'script.jsonl')
    await fs.writeFile(
      script,
      [
        line({ type: 'system', subtype: 'init', session_id: 's-audit', claude_code_version: '2.1.322' }),
        // 1. no request reaches ZumiBot: the mode allowed it.
        use('t1', 'Bash', { command: 'ls' }),
        result('t1', 'a\nb'),
        // 2. a remembered agent rule answers it.
        use('t2', 'Write', { file_path: '/w/a.txt', content: 'hi' }),
        ask('r2', 't2', 'Write', { file_path: '/w/a.txt', content: 'hi' }),
        '#WAIT_RESPONSE r2',
        result('t2', 'written'),
        // 3. the user approves once.
        use('t3', 'Bash', { command: 'rm x' }),
        ask('r3', 't3', 'Bash', { command: 'rm x' }),
        '#WAIT_RESPONSE r3',
        result('t3', ''),
        // 4. the user denies.
        use('t4', 'Bash', { command: 'curl evil' }),
        ask('r4', 't4', 'Bash', { command: 'curl evil' }),
        '#WAIT_RESPONSE r4',
        result('t4', 'Denied by the user', true),
        // 5. the real guard hook from --settings blocks a read of the audit folder.
        use('t5', 'Bash', { command: `cat ${auditDir}/x.jsonl` }),
        `#PRE_TOOL ${line({ id: 't5', tool: 'Bash', agentId: null, input: { command: `cat ${auditDir}/x.jsonl` } })}`,
        // 6. a CLI deny rule: only the result's permission_denials says so.
        use('t6', 'Read', { file_path: '/etc/shadow' }),
        result('t6', 'Permission to use Read has been denied.', true),
        line({
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 1,
          session_id: 's-audit',
          permission_denials: [{ tool_use_id: 't6', tool_name: 'Read' }]
        })
      ].join('\n') + '\n'
    )

    const audit = new AuditService({
      machine: 'test0001',
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      write: (r) => {
        void log.append(r)
      }
    })
    const svc = new ChatService({
      store,
      files: new AttachmentStore(join(dir, 'attachments'), () => 'unused'),
      locate: async () => process.execPath,
      run: (o) =>
        runClaude({ ...o, bin: process.execPath, args: [fake, ...o.args], env: { ...process.env, ...o.env, FAKE_STDOUT_FILE: script } }),
      push: () => {},
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      permissionMode: 'auto',
      disallowedToolsFor: () => [],
      agentRules: {
        has: (_a: string, k: string) => ruleKeys.has(k),
        cli: () => [],
        addCli: async () => {},
        add: (_a: string, r: AgentRule) => {
          ruleKeys.add(r.key)
        }
      },
      vaultGuard: guard,
      audit
    })
    ruleKeys.add(agentAllowKey('Write', {}))
    const c = await store.create('helper', dir)
    const sending = svc.send(c.id, 'go')
    // Answer the two cards as they come.
    const card = (id: string) =>
      waitFor(async () => (await store.loadItems(c.id)).find((i) => i.type === 'approval' && i.id === id && i.status === 'pending'))
    await card('r3')
    svc.answer(c.id, 'r3', 'allow-once')
    await card('r4')
    svc.answer(c.id, 'r4', 'deny')
    await sending
    await log.flush()

    const page = await log.list({}, null, 50)
    const records = (await Promise.all(page.rows.map((r) => log.get(r.id, r.at)))) as AuditRecord[]
    const byTool = (cmdOrPath: string) => records.find((r) => JSON.stringify(r.input).includes(cmdOrPath))!
    expect(records).toHaveLength(6)
    expect(byTool('"ls"').decision).toEqual({ kind: 'allowedByMode' })
    expect(byTool('"ls"').outcome).toBe('ok')
    expect(byTool('/w/a.txt').decision).toEqual({ kind: 'allowedByAgentRule', rule: agentAllowKey('Write', {}) })
    expect(byTool('rm x').decision).toEqual({ kind: 'approvedByUser', scope: 'once' })
    expect(byTool('curl evil')).toMatchObject({ decision: { kind: 'deniedByUser' }, outcome: 'denied' })
    const hooked = byTool('x.jsonl')
    expect(hooked).toMatchObject({ decision: { kind: 'deniedByHook', hook: 'auditGuard' }, outcome: 'denied' })
    expect(hooked.error).toContain(AUDIT_GUARD_TEXT)
    expect(byTool('/etc/shadow')).toMatchObject({ decision: { kind: 'deniedByRule' }, outcome: 'denied' })
    for (const r of records)
      expect(r).toMatchObject({ chatId: c.id, agent: 'helper', engine: 'claude', runKind: 'chat', mode: 'auto', machine: 'test0001' })
    // Show in chat lands on the call's own tool row.
    expect(byTool('rm x').itemId).toBe('t3')
    expect(await log.verify()).toEqual({ ok: true, files: 1 })
    // A rule key reused from approvals: the same key the card's "Allow always" would have saved.
    expect(ruleOf('Write', {}).key).toBe(agentAllowKey('Write', {}))
  }, 20_000)

  it('records a connector read, an unattended connector write and a call to an off connector with their own decisions', async () => {
    const script = join(dir, 'script.jsonl')
    const search = { query: 'newer_than:1d' }
    const draft = { to: ['test@example.com'], subject: 'x', body: 'y' }
    const post = { channel: 'c', text: 'hi' }
    await fs.writeFile(
      script,
      [
        line({ type: 'system', subtype: 'init', session_id: 's-audit', claude_code_version: '2.1.322' }),
        use('t1', 'mcp__claude_ai_Gmail__search_threads', search),
        ask('r1', 't1', 'mcp__claude_ai_Gmail__search_threads', search),
        '#WAIT_RESPONSE r1',
        result('t1', '{"threads":[]}'),
        use('t2', 'mcp__claude_ai_Gmail__create_draft', draft),
        ask('r2', 't2', 'mcp__claude_ai_Gmail__create_draft', draft),
        '#WAIT_RESPONSE r2',
        result('t2', 'refused', true),
        use('t3', 'mcp__claude_ai_Slack__slack_send_message', post),
        ask('r3', 't3', 'mcp__claude_ai_Slack__slack_send_message', post),
        '#WAIT_RESPONSE r3',
        result('t3', 'refused', true),
        line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 's-audit' })
      ].join('\n') + '\n'
    )

    const audit = new AuditService({
      machine: 'test0001',
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      write: (r) => {
        void log.append(r)
      }
    })
    const svc = new ChatService({
      store,
      files: new AttachmentStore(join(dir, 'attachments'), () => 'unused'),
      locate: async () => process.execPath,
      run: (o) =>
        runClaude({ ...o, bin: process.execPath, args: [fake, ...o.args], env: { ...process.env, ...o.env, FAKE_STDOUT_FILE: script } }),
      push: () => {},
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      permissionMode: 'auto',
      disallowedToolsFor: () => [],
      agentRunConfig: async () => ({ ...NO_RUN_CONFIG, connectorPrefixes: connectorPrefixes([]), connectorsOff: ['slack'] }),
      audit
    })
    const c = await store.create('helper', dir)
    // A routine's turn: unattended, so a connector write is refused without a card.
    await svc.send(c.id, 'go', [], undefined, undefined, undefined, undefined, true)
    await log.flush()

    const page = await log.list({}, null, 50)
    const records = (await Promise.all(page.rows.map((r) => log.get(r.id, r.at)))) as AuditRecord[]
    const byTool = (name: string) => records.find((r) => r.tool === name)!
    expect(records).toHaveLength(3)
    expect(byTool('mcp__claude_ai_Gmail__search_threads').decision).toEqual({ kind: 'allowedByZumiBot', why: 'connectorRead' })
    expect(byTool('mcp__claude_ai_Gmail__create_draft')).toMatchObject({
      decision: { kind: 'deniedByZumiBot', why: 'connectorUnattended' },
      outcome: 'denied'
    })
    expect(byTool('mcp__claude_ai_Slack__slack_send_message')).toMatchObject({
      decision: { kind: 'deniedByZumiBot', why: 'connectorOff' },
      outcome: 'denied'
    })
    expect((await store.loadItems(c.id)).some((i) => i.type === 'approval')).toBe(false)
  }, 20_000)
})
