export const RUN_WORKFLOW_NAME = 'run-workflow'
export const RUN_WORKFLOW_DESCRIPTION = 'Start a workflow; the text after its name is its input'
export const NO_WORKFLOW_NAMED = 'No workflow has that name'
export const sameNameText = (name: string): string => `Several workflows are named "${name}"`

// Same boundary rule as /btw: `/run-workflowx y` is another command's name.
const LEAD_RUN = new RegExp(`^/${RUN_WORKFLOW_NAME}(?=\\s|$)`)

/** What follows a leading `/run-workflow` (trimmed): the workflow's name, then its input. Null when the text is not that command. */
export function runWorkflowRest(text: string): string | null {
  const m = LEAD_RUN.exec(text)
  return m ? text.slice(m[0].length).trim() : null
}

/** The workflow whose name `rest` starts with: names compare case-insensitively, the longest wins, and the name ends at whitespace or the end. */
export function resolveRunWorkflow(rest: string, ws: { id: string; name: string }[]): { id: string; input: string } | { error: string } {
  let best: { id: string; name: string }[] = []
  let len = 0
  for (const w of ws) {
    const name = w.name.trim()
    if (!name) continue
    // Cut by the name's own length, not the lowered text's, which can differ for a few letters.
    if (rest.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue
    if (rest.length > name.length && !/\s/.test(rest[name.length]!)) continue
    if (name.length > len) {
      best = []
      len = name.length
    }
    if (name.length === len) best.push({ id: w.id, name })
  }
  const first = best[0]
  if (!first) return { error: NO_WORKFLOW_NAMED }
  if (best.length > 1) return { error: sameNameText(first.name) }
  return { id: first.id, input: rest.slice(len).trim() }
}

/** `rest` past a leading `name` (trimmed, compared case-insensitively, ending at whitespace or the end), trimmed; null when it does not start with it. */
export function afterWorkflowName(rest: string, name: string): string | null {
  const n = name.trim()
  if (!n || rest.slice(0, n.length).toLowerCase() !== n.toLowerCase()) return null
  if (rest.length > n.length && !/\s/.test(rest[n.length]!)) return null
  return rest.slice(n.length).trim()
}
