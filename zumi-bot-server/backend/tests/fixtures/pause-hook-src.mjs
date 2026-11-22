// The pause hook (src/core/chat/pauseHook.ts) for tests that run without a build: the same run and block text, taken from
// the sources (Node strips their types), so the probe's whole run can be checked against the fake claude.
import { PAUSE_BLOCK_TEXT } from '../../../shared/src/pause.ts'
import { runPauseHook } from '../../src/core/chat/pauseSettings.ts'

runPauseHook({ stdin: process.stdin, stderr: process.stderr, exit: (code) => process.exit(code), blockText: PAUSE_BLOCK_TEXT })
