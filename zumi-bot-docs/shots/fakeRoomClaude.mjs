#!/usr/bin/env node
// Fake claude for the room shots. Like the backend's fake-clone-claude (the handoff summary and every member turn are
// answered there), except that the room moderator (--json-schema) answers for real: it reads the prompt the server sent and,
// when the user just spoke, picks the members named in FAKE_ROOM_PICKS ([{ agent, after }]); after a member's reply it picks
// nobody, or the picked members would answer again and again. An unset FAKE_ROOM_PICKS picks nobody.
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

if (!process.argv.includes('--json-schema')) {
  await import(fileURLToPath(new URL('../../zumi-bot-server/backend/tests/fixtures/fake-clone-claude.mjs', import.meta.url)))
} else {
  let prompt = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => (prompt += d))
  await new Promise((resolve) => process.stdin.on('end', resolve))
  const picks = JSON.parse(process.env.FAKE_ROOM_PICKS ?? '[]')
  const next = prompt.includes('Just spoke: the user') ? picks.map((p) => ({ agent: p.agent, after: p.after ?? [] })) : []
  // modelUsage too: without a token breakdown the server records no cost for the call.
  const modelUsage = { 'claude-haiku-5-5': { inputTokens: 900, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0004 } }
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      structured_output: { next, drop: [], skip: [], askUser: false },
      total_cost_usd: 0.0004,
      modelUsage,
      uuid: randomUUID()
    })
  )
  process.exit(0)
}
