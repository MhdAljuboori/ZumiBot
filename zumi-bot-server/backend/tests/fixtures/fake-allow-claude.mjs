#!/usr/bin/env node
// A deterministic Claude stand-in for "Allow a refused call and continue" (allowBlocked.e2e.mjs). A run with no --resume is the
// first turn: a Bash call the auto-mode classifier refuses (permission_denied, the error tool_result and the result's
// permission_denials, as the real CLI orders them). A first message that says "merge" refuses `cd $FAKE_OUTSIDE && gh pr merge
// 1 --merge` instead, a cd into a folder outside the chat's; one that says "heredoc" refuses a `python3` heredoc followed by
// `gh pr merge`, a part no rule can allow; one that says "remote branch" refuses `cd $FAKE_OUTSIDE && git push origin --delete
// old`, git after a cd into another folder. A resumed run appends its argv to FAKE_ARGV_FILE, one JSON line each, and replies
// "ok". No model, quota or personal HOME is used.
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
// Agent Studio's loadout card asks for the plugin list; its stdin is closed, so answer before waiting for a user line.
if (argv[0] === 'plugin' && argv[1] === 'list') {
  process.stdout.write('[]\n')
  process.exit(0)
}
// The app's --thinking-display check: given no prompt, claude stops with this error.
if (argv.join(' ') === '-p --thinking-display summarized') {
  process.stderr.write('Error: Input must be provided either through stdin or as a prompt argument when using --print\n')
  process.exit(1)
}

const COMMAND = 'cd /tmp && git branch -D old-branch'
const HEREDOC = "python3 - <<'EOF' > /tmp/body.json\nprint('{}')\nEOF\ngh pr merge 1 --merge"
const TOOL_ID = 'toolu_allow_e2e'
const emit = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const session = randomUUID()
const resumed = argv.includes('--resume')

let buffered = ''
let started = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  if (started || !buffered.includes('\n')) return
  started = true
  run()
})
process.stdin.on('end', () => process.exit(0))
setTimeout(() => process.exit(13), 15_000).unref()

function run() {
  const merge = process.env.FAKE_OUTSIDE && buffered.includes('merge')
  const heredoc = buffered.includes('heredoc')
  const gitAfterCd = process.env.FAKE_OUTSIDE && buffered.includes('remote branch')
  const command = merge
    ? `cd ${process.env.FAKE_OUTSIDE} && gh pr merge 1 --merge`
    : gitAfterCd
      ? `cd ${process.env.FAKE_OUTSIDE} && git push origin --delete old`
      : heredoc
        ? HEREDOC
        : COMMAND
  emit({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), model: 'claude-haiku-5-5', permissionMode: 'auto' })
  if (resumed) {
    if (process.env.FAKE_ARGV_FILE) appendFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv) + '\n')
    emit({ type: 'assistant', message: { id: 'msg_ok', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, session_id: session })
    emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: session, result: 'ok', total_cost_usd: 0, permission_denials: [] })
    return
  }
  const input = { command, description: merge ? 'Merge the pull request' : 'Delete the old branch' }
  emit({
    type: 'assistant',
    message: { id: 'msg_tool', role: 'assistant', content: [{ type: 'tool_use', id: TOOL_ID, name: 'Bash', input }] },
    session_id: session
  })
  const message =
    "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Destructive or Unwanted Actions]. If you have other tasks that don't depend on this action, continue working on those."
  emit({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: TOOL_ID,
    decision_reason_type: 'classifier',
    decision_reason: '[Destructive or Unwanted Actions]',
    message,
    uuid: randomUUID(),
    session_id: session
  })
  emit({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: message, is_error: true, tool_use_id: TOOL_ID }] },
    parent_tool_use_id: null,
    session_id: session
  })
  const text = 'The branch delete was refused. Allow it, then ask me to continue.'
  emit({ type: 'assistant', message: { id: 'msg_text', role: 'assistant', content: [{ type: 'text', text }] }, session_id: session })
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    session_id: session,
    result: text,
    total_cost_usd: 0,
    permission_denials: [{ tool_name: 'Bash', tool_use_id: TOOL_ID, tool_input: input }]
  })
}
