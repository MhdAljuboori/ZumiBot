#!/usr/bin/env node
// Fake claude for the workflows' bare calls and Agent steps. Tells them apart by argv:
//  - --agent: an Agent step is a normal chat turn, so it is exactly fake-claude.mjs (same args, stdio and env);
//  - --json-schema: a Condition call. Prints a structured answer: yes when stdin holds YES, no when it holds NO,
//    else FAKE_CONDITION_ANSWER;
//  - any other call reads stdin first: #LIMIT prints a rejected usage-limit result (reset 2 s from now), #CONTEXT an
//    error result that is no usage limit ("Context limit reached"), #HANG never exits, else the result is "LLM:" plus
//    the first 200 characters of stdin.
//    With FAKE_AGENT_HOLD_FILE or FAKE_AGENT_FAIL_FILE set, the turn first reads its stdin's first line (the user message):
//    while the hold file exists, a line holding #HOLD waits (polled every 100 ms); while the fail file exists, a line
//    holding #FAIL prints an error result and exits 1; then fake-claude.mjs runs as a child with the same argv and env,
//    fed that line and the rest of stdin. A For each item's text carries the marker, so one item can be held or failed.
// Every bare call appends its argv to FAKE_WORKFLOW_ARGS_OUT when set (one JSON array per line).
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)

if (args.includes('--agent')) {
  if (process.env.FAKE_AGENT_HOLD_FILE || process.env.FAKE_AGENT_FAIL_FILE) {
    let buf = Buffer.alloc(0)
    let ended = false
    const cut = await new Promise((resolve) => {
      const onData = (c) => {
        buf = Buffer.concat([buf, c])
        const i = buf.indexOf(10)
        if (i >= 0) { process.stdin.pause(); process.stdin.off('data', onData); resolve(i) }
      }
      process.stdin.on('data', onData)
      process.stdin.on('end', () => { ended = true; resolve(buf.length) })
    })
    const line = buf.subarray(0, cut).toString('utf8')
    const hold = process.env.FAKE_AGENT_HOLD_FILE
    const fail = process.env.FAKE_AGENT_FAIL_FILE
    while (hold && line.includes('#HOLD') && existsSync(hold)) await new Promise((r) => setTimeout(r, 100))
    if (fail && line.includes('#FAIL') && existsSync(fail)) {
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Fake agent failure', total_cost_usd: 0, modelUsage: {} }) + '\n')
      process.exit(1)
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fake-claude.mjs', import.meta.url)), ...args], { stdio: ['pipe', 'inherit', 'inherit'], env: process.env })
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); setTimeout(() => process.exit(1), 200) })
    child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)))
    child.stdin.on('error', () => {})
    child.stdin.write(buf)
    if (ended) child.stdin.end()
    else { process.stdin.pipe(child.stdin); process.stdin.resume() }
  } else await import('./fake-claude.mjs')
} else {
  if (process.env.FAKE_WORKFLOW_ARGS_OUT) appendFileSync(process.env.FAKE_WORKFLOW_ARGS_OUT, JSON.stringify(args) + '\n')
  let stdin = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) stdin += chunk
  const print = (o) => process.stdout.write(JSON.stringify(o))
  if (stdin.includes('#HANG')) {
    // stdin is closed, so only a kill ends this call
    setInterval(() => {}, 1000)
  } else if (stdin.includes('#LIMIT')) {
    print({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
      result: "You've hit your limit", rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 2 },
      total_cost_usd: 0, modelUsage: {}
    })
    process.exit(1)
  } else if (stdin.includes('#CONTEXT')) {
    print({ type: 'result', subtype: 'success', is_error: true, result: 'Context limit reached', total_cost_usd: 0, modelUsage: {} })
    process.exit(1)
  } else if (args.includes('--json-schema')) {
    const answer = stdin.includes('YES') ? 'yes' : stdin.includes('NO') ? 'no' : process.env.FAKE_CONDITION_ANSWER
    print({ type: 'result', is_error: false, result: '', structured_output: { answer, reason: 'fake' }, total_cost_usd: 0, modelUsage: {} })
    process.exit(0)
  } else {
    // modelUsage too: without a token breakdown no cost is recorded for a run.
    const modelUsage = { 'claude-sonnet-4-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } }
    print({ type: 'result', subtype: 'success', is_error: false, result: 'LLM:' + stdin.slice(0, 200), total_cost_usd: 0.01, modelUsage, uuid: 'fake-uuid' })
    process.exit(0)
  }
}
