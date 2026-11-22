// Fake claude CLI with a memory, for the Edit/Resend/Fork e2e (versions.e2e.mjs). It imitates what the real CLI 2.1.299
// showed in the spec's rewind spike: a session is a list of entries kept under $HOME/.fake-sessions/<id>.json;
// --resume-session-at <uuid> keeps the entries up to and including that uuid; --fork-session writes the continued
// conversation under a NEW id and leaves the original file as it was. FAKE_MEMORY_IGNORE_FORK=1 makes it ignore
// --fork-session, as a CLI update that dropped the flag would.
// Replies: "Remember the word X" is remembered; "List every word" answers `Words: A, B` from every user entry the
// session holds; anything else answers `OK`. A moderator call (--json-schema) answers `{}`.
// Side-question checks: Work N steps persists progressive Step calls/results; <btw> asks against the cut context.
// --no-session-persistence suppresses session writes, and --settings PreToolUse denial prevents the tool marker.
// FAKE_MEMORY_LOG optionally audits prompts/args/cut entries; FAKE_STEP_MS controls work and partial-answer timing.
// Context: each entry the session holds counts 2000 tokens of a FAKE_MEMORY_WINDOW (default 20000) window, reported on
// the reply like the real CLI. "/compact <note>" swaps the entries for one summary entry that keeps every remembered word
// and the note, and streams what the real CLI did for it (a compacting status, compact_boundary, no reply).
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
// Both spellings the CLI takes: `--name value` from the CLI runner, `--name=value` from the Agent SDK adapter.
const flag = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`))
  if (eq !== undefined) return eq.slice(name.length + 1)
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] ?? null) : null
}
const has = (name) => argv.some((a) => a === name || a.startsWith(`${name}=`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

// The prompt is the first stdin line that is a user message ({type:'user', message:{content: string | blocks}}). Not simply
// the first line: the Agent SDK adapter writes its own control_request lines on the same channel, ahead of the prompt, as the
// real CLI reads them. Taking the first line made every such run answer as if it had been sent no prompt at all.
function firstLine() {
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => {
      buf += c
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m
        try { m = JSON.parse(line) } catch { m = null }
        if (m?.type === 'user') { resolve(line); return }
      }
    })
  })
}

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n'))

// What the message asks for: a seed's <new_message>, or a room prompt's last user message, else the whole text.
// Earlier "list every word" lines in a seed or a room thread must not turn a later message into a list request.
function asked(text) {
  const seeded = /<new_message>\n?([\s\S]*?)\n?<\/new_message>/.exec(text)
  if (seeded) return seeded[1]
  const users = [...text.matchAll(/<message from="user">([\s\S]*?)<\/message>/g)]
  return users.length > 0 ? users[users.length - 1][1] : text
}

async function main() {
  const dir = join(process.env.HOME ?? homedir(), '.fake-sessions')
  mkdirSync(dir, { recursive: true })
  const file = (id) => join(dir, `${id}.json`)

  const resume = flag('--resume')
  const cut = flag('--resume-session-at')
  const persistent = !argv.includes('--no-session-persistence')
  const save = () => {
    if (!persistent) return
    const tmp = `${file(id)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(entries))
    renameSync(tmp, file(id))
  }
  const fork = has('--fork-session') && process.env.FAKE_MEMORY_IGNORE_FORK !== '1'

  let entries = []
  if (resume) {
    try {
      entries = JSON.parse(readFileSync(file(resume), 'utf8'))
    } catch {
      fail(`No conversation found with session ID: ${resume}`)
    }
    if (cut) {
      const at = entries.findIndex((e) => e.uuid === cut)
      if (at < 0) fail(`No message found with message.uuid of: ${cut}`)
      entries = entries.slice(0, at + 1)
    }
  }
  // A forked run continues under its own id; the resumed file is not touched.
  const id = resume && !fork ? resume : randomUUID()

  const line = JSON.parse(await firstLine())
  const prompt = textOf(line.message?.content)
  if (process.env.FAKE_MEMORY_LOG) appendFileSync(process.env.FAKE_MEMORY_LOG, JSON.stringify({ pid: process.pid, id, argv, prompt, entries }) + '\n')
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  const remembered = () => entries
    .filter((e) => e.role === 'user')
    .flatMap((e) => [...e.text.matchAll(/remember the word (\w+)/gi)].map((m) => m[1]))
  const TOKENS = 2000
  const window = Number(process.env.FAKE_MEMORY_WINDOW ?? 20000)
  const modelUsage = { fake: { contextWindow: window } }

  const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(prompt.trim())
  if (compact) {
    const pre = entries.length * TOKENS
    const keep = remembered().map((w) => `Remember the word ${w}.`).join(' ')
    entries = [{ uuid: randomUUID(), role: 'user', text: `Summary: ${keep}${compact[1] ? ` Focus: ${compact[1]}` : ''}` }]
    out({ type: 'system', subtype: 'status', status: 'compacting', session_id: id, uuid: randomUUID() })
    // Long enough for the app to show "Compacting…".
    await sleep(1200)
    out({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: id, uuid: randomUUID() })
    out({ type: 'system', subtype: 'init', session_id: id, cwd: process.cwd(), model: 'fake', permissionMode: 'default', claude_code_version: 'fake' })
    await sleep(150)
    out({ type: 'system', subtype: 'compact_boundary', session_id: id, uuid: entries[0].uuid, compact_metadata: { trigger: 'manual', pre_tokens: pre, post_tokens: 500 } })
    save()
    out({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', session_id: id, permission_denials: [], modelUsage, uuid: randomUUID() })
    process.exit(0)
  }
  const side = /<btw>([\s\S]*?)<\/btw>/.exec(prompt)
  const stepMs = Number(process.env.FAKE_STEP_MS ?? 400)
  const init = () => out({ type: 'system', subtype: 'init', session_id: id, cwd: process.cwd(), model: 'fake', permissionMode: 'default', claude_code_version: 'fake' })
  const emitEntry = (role, content) => {
    const uuid = randomUUID()
    entries.push({ uuid, role, text: textOf(content), content })
    save() // A streamed clean point must already be readable by a fork.
    out({ type: role, uuid, session_id: id, parent_tool_use_id: null,
      message: { id: `msg_${uuid}`, role, model: 'fake', content } })
  }
  const result = (reply) => out({ type: 'result', subtype: 'success', is_error: false, result: reply,
    session_id: id, total_cost_usd: 0, num_turns: 1, modelUsage, uuid: randomUUID() })
  if (side) {
    const question = side[1].trim()
    const steps = entries.filter(e => e.role === 'user' && e.content?.some(b => b.type === 'tool_result' && b.content?.startsWith('Step '))).length
    const reply = /how many steps done/i.test(question) ? `Steps done: ${steps}` : `Side: ${question}`
    init()
    await sleep(150)
    if (question === 'use a tool') {
      const settings = JSON.parse(flag('--settings') ?? '{}')
      const hooks = settings.hooks?.PreToolUse ?? []
      // As in the CLI, a matcher is '*' (or none) for every tool, else a regex on the tool name: a user's side question in a
      // chat with the ask bridge gets SIDE_GUARD_ASKING, whose lookahead blocks Bash too.
      const matches = (m) => {
        if (m === undefined || m === '' || m === '*') return true
        try { return new RegExp(m).test('Bash') } catch { return false }
      }
      const deny = hooks.flatMap(h => matches(h.matcher) ? h.hooks ?? [] : []).find(h => h.type === 'command' && /exit 2/.test(h.command))
      const reason = deny ? /echo ['"]([^'"]+)['"]/.exec(deny.command)?.[1] ?? 'Denied by hook' : null
      emitEntry('assistant', [{ type: 'tool_use', id: 'side-tool', name: 'Bash', input: { command: 'touch "$HOME/tool-ran.txt"' } }])
      if (!deny) writeFileSync(join(process.env.HOME ?? homedir(), 'tool-ran.txt'), 'ran')
      emitEntry('user', [{ type: 'tool_result', tool_use_id: 'side-tool', is_error: Boolean(deny), content: reason ?? 'ran' }])
    }
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.slice(0, 6) } } })
    // Long enough to stop/restart or fill the three available side slots.
    await sleep(stepMs * 4)
    emitEntry('assistant', [{ type: 'text', text: reply }])
    result(reply)
    process.exit(0)
  }
  const work = /\bWork (\d+) steps\b/i.exec(asked(prompt).trim())
  if (work) {
    entries.push({ uuid: randomUUID(), role: 'user', text: prompt })
    save()
    init()
    for (let n = 1; n <= Number(work[1]); n++) {
      const toolId = randomUUID()
      emitEntry('assistant', [{ type: 'tool_use', id: toolId, name: 'Step', input: { step: n } }])
      await sleep(stepMs)
      emitEntry('user', [{ type: 'tool_result', tool_use_id: toolId, content: `Step ${n} complete` }])
    }
    const reply = `Done ${work[1]} steps`
    emitEntry('assistant', [{ type: 'text', text: reply }])
    result(reply)
    process.exit(0)
  }
  entries.push({ uuid: randomUUID(), role: 'user', text: prompt })

  const words = remembered()
  const reply = /list every word/i.test(asked(prompt)) ? `Words: ${words.length > 0 ? words.join(', ') : 'none'}` : 'OK'
  const assistantUuid = randomUUID()
  entries.push({ uuid: assistantUuid, role: 'assistant', text: reply })
  const usage = { input_tokens: entries.length * TOKENS - 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }

  out({ type: 'system', subtype: 'init', session_id: id, cwd: process.cwd(), model: 'fake', permissionMode: 'default', claude_code_version: 'fake' })
  // A stop in the window below is a SIGINT from the CLI runner, which kills this process, or an interrupt control_request
  // from the Agent SDK adapter, which the real CLI honours by abandoning its turn. Nothing may be written after either.
  process.stdin.on('data', (c) => {
    for (const line of String(c).split('\n')) {
      let m
      try { m = JSON.parse(line) } catch { m = null }
      if (m?.type === 'control_request' && m.request?.subtype === 'interrupt') process.exit(0)
    }
  })
  // Gives the app time to stop a run it distrusts (--fork-session ignored) before anything is written.
  await sleep(150)
  out({
    type: 'assistant',
    message: { id: `msg_${assistantUuid}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage },
    parent_tool_use_id: null,
    session_id: id,
    uuid: assistantUuid
  })
  save()
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1,
    num_turns: 1,
    result: reply,
    stop_reason: 'end_turn',
    session_id: id,
    total_cost_usd: 0,
    permission_denials: [],
    modelUsage,
    uuid: randomUUID()
  })
  process.exit(0)
}

if (argv.includes('--json-schema')) {
  let prompt = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', c => { prompt += c })
  process.stdin.on('end', () => {
    if (process.env.FAKE_MEMORY_LOG) appendFileSync(process.env.FAKE_MEMORY_LOG, JSON.stringify({ argv, prompt }) + '\n')
    const picking = prompt.includes('<pick>') || prompt.includes('Working now:')
    const member = /Working now:\s*@([\w-]+)/.exec(prompt)?.[1] ?? /- @([\w-]+)/.exec(prompt)?.[1]
    process.stdout.write(JSON.stringify(picking && member ? { member } : {}))
    process.exit(0)
  })
} else {
  await main()
}
