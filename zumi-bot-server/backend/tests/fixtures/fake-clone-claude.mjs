// Fake claude for the room clone e2e. Tells the calls apart by argv:
//  - the handoff summary (a --system-prompt starting "You write a handoff note"): drains stdin and prints one JSON result
//    with FAKE_SUMMARY_TEXT (or a fixed note); while the file FAKE_SUMMARY_HANG_FILE exists it hangs instead, so one
//    server run can check both a finished and a cancelled summary;
//  - the room moderator (--json-schema): drains stdin and prints {}, so routing falls back to the @mentions;
//  - anything else is a member turn: exactly fake-claude.mjs.
// Summary and moderator calls are logged to FAKE_INVOCATIONS_OUT here (with the pid, so a test can see a killed call
// is gone); member turns are logged by fake-claude.mjs itself.
import { appendFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const valueOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const log = (entry) => {
  if (process.env.FAKE_INVOCATIONS_OUT) appendFileSync(process.env.FAKE_INVOCATIONS_OUT, JSON.stringify({ args, pid: process.pid, ...entry }) + '\n')
}
const drained = () =>
  new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.on('end', resolve)
  })

const DEFAULT_SUMMARY = [
  '## Goal', 'Finish the widget.', '',
  '## Decisions', 'None', '',
  '## Current state', 'None', '',
  '## Who does what', 'None', '',
  '## Your preferences', 'None', '',
  '## Open items', 'None'
].join('\n')

if (valueOf('--system-prompt')?.startsWith('You write a handoff note')) {
  const hang = Boolean(process.env.FAKE_SUMMARY_HANG_FILE) && existsSync(process.env.FAKE_SUMMARY_HANG_FILE)
  log({ kind: 'summary', hang })
  if (hang) {
    // stdin stays open: only a kill ends this call
    process.stdin.resume()
    setInterval(() => {}, 1000)
  } else {
    await drained()
    const result = process.env.FAKE_SUMMARY_TEXT ?? DEFAULT_SUMMARY
    // modelUsage too: without a token breakdown the server records no cost for a run.
    const modelUsage = { 'claude-sonnet-4-5': { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } }
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.01, modelUsage, uuid: randomUUID() }))
    process.exit(0)
  }
} else if (args.includes('--json-schema')) {
  log({ kind: 'moderator' })
  await drained()
  process.stdout.write('{}')
  process.exit(0)
} else {
  await import('./fake-claude.mjs')
}
