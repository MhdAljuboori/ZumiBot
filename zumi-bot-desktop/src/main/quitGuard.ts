export type CloseDecision = 'close' | 'ask-unsaved' | 'ask-running'

/** processCount: background processes the local server ends when it stops; they ask too, though they are not replies. */
export function decideClose(s: { editorDirty: boolean; runningCount: number; processCount?: number }): CloseDecision {
  if (s.editorDirty) return 'ask-unsaved'
  return s.runningCount > 0 || (s.processCount ?? 0) > 0 ? 'ask-running' : 'close'
}

const processes = (p: number): string => (p === 1 ? '1 background process' : `${p} background processes`)

/** The same words for leaving Local mode by Switch server, which stops the local server too. */
export function switchMessage(n: number, p = 0): string {
  return runningMessage(n, p)
    .replace(/quit\?$/, 'switch?')
    .replace(/Quit\?$/, 'Switch server?')
}

export function runningMessage(n: number, p = 0): string {
  if (n === 0) return `${processes(p)} will stop. Quit?`
  const replies = n === 1 ? '1 reply still running' : `${n} replies still running`
  if (p > 0) return `${replies}, and ${processes(p)} will stop. Stop them and quit?`
  return n === 1 ? '1 reply still running. Stop it and quit?' : `${n} replies still running. Stop them and quit?`
}
