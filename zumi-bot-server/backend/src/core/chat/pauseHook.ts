import { readFileSync } from 'node:fs'
import { PAUSE_BLOCK_TEXT } from '@zumibot/shared/pause'
import { CAP_BLOCK_TEXT, CAP_FLAG } from '@zumibot/shared/spendCaps'
import { runPauseHook } from './pauseSettings'

// Child entry of the CLI's PreToolUse hook, started only while a chat is paused. Exit 2 blocks the call and the CLI shows stderr to the agent.
delete process.env.ELECTRON_RUN_AS_NODE
// The flag's content only words the block: CAP_FLAG when a spend cap asked the pause. An unreadable flag still blocks.
const flag = (): string => {
  try {
    return readFileSync(process.env.ZUMIBOT_PAUSE_FILE ?? '', 'utf8').trim()
  } catch {
    return ''
  }
}
runPauseHook({
  stdin: process.stdin,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
  blockText: flag() === CAP_FLAG ? CAP_BLOCK_TEXT : PAUSE_BLOCK_TEXT
})
