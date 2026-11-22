/**
 * The repo's home page: the one GitHub address a page may name. Not followed by a path or `.git`, so a link to a file, a release or a raw
 * script under it is still a leak (pages stay the instructions; they never send readers into the source).
 */
const REPO_HOME = /https:\/\/github\.com\/MhdAljuboori\/ZumiBot\/?(?![\w/-]|\.\w)/gi

/** Strings that must never reach the public site: the owner's servers stay unnamed, and pages never point into the source. */
export const FORBIDDEN: RegExp[] = [
  /github\.com\/MhdAljuboori/i,
  /raw\.githubusercontent\.com/i,
  /mhdaljuboori\.me/i,
  /zumi-bot-server\//i,
  /docs\/architecture/i,
  // The owner's name, bare: a handle or a path that names the account.
  /MhdAljuboori/i,
  // A plan's task number, such as "(Task 12)": a note to the writers, never for readers.
  /\bTask \d+\b/,
  // A source path such as `src/state/itemSync.ts` or `src/ui/Rail.tsx`.
  /\bsrc\/[\w./-]+\.tsx?\b/
]

/** Every forbidden match found in `text`, after the repo's home page is set aside. */
export function findLeaks(text: string): string[] {
  const rest = text.replace(REPO_HOME, ' ')
  return FORBIDDEN.flatMap((re) => {
    const found = rest.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))
    return found ? [...found] : []
  })
}

const SHELL = new Set(['bash', 'sh', 'shell'])
const CURLY = /[‘’“”]/

/**
 * Problems in fenced blocks tagged bash, sh or shell: a line that starts with `$ `, after any indent (readers copy the whole block, so a
 * prompt breaks it) and curly quotes (a pasted command with them fails).
 */
export function codeBlockProblems(markdown: string): string[] {
  const problems: string[] = []
  let fence: string | null = null
  let shell = false
  for (const line of markdown.split(/\r?\n/)) {
    const found = /^\s*(`{3,}|~{3,})\s*([\w-]*)(.*)$/.exec(line)
    // A backtick fence's info string holds no backtick: "```bash echo hi```" is inline code, not a fence.
    const open = found && !(found[1][0] === '`' && found[3].includes('`')) ? found : null
    if (fence === null) {
      if (open) {
        fence = open[1]
        shell = SHELL.has(open[2].toLowerCase())
      }
      continue
    }
    if (open && open[1][0] === fence[0] && open[1].length >= fence.length && open[2] === '') {
      fence = null
      shell = false
      continue
    }
    if (!shell) continue
    // Indented too: a fence inside a list item keeps its list indent.
    if (line.trimStart().startsWith('$ ')) problems.push(`prompt: ${line.trim()}`)
    if (CURLY.test(line)) problems.push(`curly quote: ${line.trim()}`)
  }
  return problems
}
