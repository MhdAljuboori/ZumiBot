// Helpers for "Allow a blocked call and continue": split a refused Bash command into its parts,
// suggest and validate `Bash(<prefix>:*)` rules, and word the continue message. The backend and the
// UI both call these, so they check a typed prefix the same way. These decide what an agent may run,
// so every check rejects when in doubt.

/** Shells, interpreters and wrappers that run any command. Auto mode ignores allow rules for the shells (verified for
 *  `sh`); for the wrappers it is unverified, and a rule on them would grant "run anything" anyway, so all are refused. */
export const INTERPRETERS: readonly string[] = [
  'sh', 'bash', 'zsh', 'dash', 'fish', 'python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php',
  'npx', 'env', 'sudo', 'eval', 'exec', 'xargs', 'ssh',
  'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'source', '.',
  'timeout', 'nohup', 'command', 'busybox', 'nice', 'time', 'stdbuf', 'setsid', 'doas', 'su', 'watch', 'nsenter',
  'chroot', 'unshare', 'flock', 'ionice', 'taskset'
]

/** Parts starting with these never need a rule of their own. */
export const SAFE_HEADS: readonly string[] = [
  'cd', 'echo', 'tail', 'head', 'grep', 'ls', 'cat', 'wc', 'sort', 'sleep', 'true', 'pwd', 'printf', 'awk',
  'sed', 'cut', 'tr'
]

const MAX_PREFIX = 300
// Keywords that only introduce the command that follows (or end a block).
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', '{', '}', '!', 'time'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/

// --- scanning --------------------------------------------------------------------------------

/** End index (past the closing quote) of a double-quoted string whose opening quote is before `i`. */
function skipDouble(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') i += 2
    else if (c === '"') return i + 1
    else if (c === '`' || (c === '$' && (s[i + 1] === '(' || s[i + 1] === '{'))) i = quoted(s, i)
    else i++
  }
  return s.length
}

/** End index of a group started before `i`, closed by `close` (')' or '}'), honouring quotes and nesting. */
function skipGroup(s: string, i: number, close: ')' | '}'): number {
  const open = close === ')' ? '(' : '{'
  let depth = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      i += 2
      continue
    }
    const q = quoted(s, i)
    if (q >= 0) {
      i = q
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      if (depth === 0) return i + 1
      depth--
    }
    i++
  }
  return s.length
}

/** If a quote or expansion starts at `i`, the index just past it; otherwise -1. Unterminated runs to the end. */
function quoted(s: string, i: number): number {
  const c = s[i]
  if (c === "'") {
    const j = s.indexOf("'", i + 1)
    return j < 0 ? s.length : j + 1
  }
  if (c === '"') return skipDouble(s, i + 1)
  if (c === '`') {
    let j = i + 1
    while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1
    return Math.min(j + 1, s.length)
  }
  if (c === '$') {
    const n = s[i + 1]
    if (n === '(') return skipGroup(s, i + 2, ')')
    if (n === '{') return skipGroup(s, i + 2, '}')
    if (n === "'") {
      let j = i + 2
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1
      return Math.min(j + 1, s.length)
    }
  }
  return -1
}

/** End index of the shell word starting at `i`. */
function wordEnd(s: string, i: number): number {
  while (i < s.length && !/\s/.test(s[i])) {
    if (s[i] === '\\') {
      i += 2
      continue
    }
    const q = quoted(s, i)
    i = q >= 0 ? q : i + 1
  }
  return Math.min(i, s.length)
}

interface Heredoc {
  word: string
}

/** The delimiter of a `<<` that starts before `i` (after the `<<`), or null when no word follows. */
function heredocWord(s: string, i: number): Heredoc | null {
  if (s[i] === '-') i++
  while (s[i] === ' ' || s[i] === '\t') i++
  let word = ''
  while (i < s.length && !/[\s;&|<>()]/.test(s[i])) {
    const c = s[i]
    if (c === "'" || c === '"') {
      const j = s.indexOf(c, i + 1)
      const end = j < 0 ? s.length : j
      word += s.slice(i + 1, end)
      i = end + 1
    } else if (c === '\\') {
      word += s[i + 1] ?? ''
      i += 2
    } else {
      word += c
      i++
    }
  }
  return word ? { word } : null
}

/** Index past a heredoc body that starts at `i`. The terminator is matched trimmed, so a shell that is
 *  stricter than us only makes the lines after it show up as parts, never hides a command. */
function skipHeredoc(s: string, i: number, h: Heredoc): number {
  while (i < s.length) {
    const nl = s.indexOf('\n', i)
    const end = nl < 0 ? s.length : nl
    const line = s.slice(i, end).trim()
    i = nl < 0 ? s.length : nl + 1
    if (line === h.word) return i
  }
  return s.length
}

// A redirection operator at the start of a word: `>f`, `2>&1`, `&>f`, `<f`, `>|f`.
const REDIRECT = /^(?:\d+|&)?(?:>>|>&|>\||>|<&|<)\s*/

/** Drop leading keywords, NAME=value words and redirections; '' when nothing runnable is left. A redirection alone
 *  (`done > out`, `fi 2>&1`) is not a command a rule could name. */
function normalise(raw: string): string {
  let s = raw.trim()
  while (s) {
    const end = wordEnd(s, 0)
    const word = s.slice(0, end)
    if (KEYWORDS.has(word) || ASSIGNMENT.test(word)) s = s.slice(end).trim()
    else {
      const m = REDIRECT.exec(s)
      if (!m) break
      s = s.slice(m[0].length)
      s = s.slice(wordEnd(s, 0)).trim() // its target
    }
  }
  if (!s || s.startsWith('((') || /^(for|case|select)\s/.test(s)) return ''
  return s
}

/** Splits a shell command into the commands it runs, one string each. Quotes, escapes, `$(…)`, `${…}`,
 *  backticks and heredoc bodies hide their contents, so `git commit -m "a; b"` stays one part. A pure
 *  assignment, a loop header and block keywords are dropped. */
export function commandParts(command: string): string[] {
  const s = typeof command === 'string' ? command : ''
  const out: string[] = []
  const pending: Heredoc[] = []
  let cur = ''
  let subshell = 0 // open `(` at the start of a command, so a stray `)` (a case pattern) can be told apart
  const flush = (): void => {
    const p = normalise(cur)
    if (p) out.push(p)
    cur = ''
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      // A backslash-newline joins lines; it is not a command separator.
      cur += s[i + 1] === '\n' ? ' ' : c + (s[i + 1] ?? '')
      i += 2
      continue
    }
    const q = quoted(s, i)
    if (q >= 0) {
      cur += s.slice(i, q)
      i = q
      continue
    }
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      const end = skipGroup(s, i + 2, ')')
      cur += s.slice(i, end)
      i = end
      continue
    }
    if (c === '<' && s[i + 1] === '<') {
      if (s[i + 2] === '<') {
        cur += '<<<' // here-string, no body
        i += 3
        continue
      }
      const h = heredocWord(s, i + 2)
      if (h) pending.push(h)
      cur += '<<'
      i += 2
      continue
    }
    if (c === '\n') {
      flush()
      i++
      for (const h of pending) i = skipHeredoc(s, i, h)
      pending.length = 0
      continue
    }
    if (c === ';') {
      flush()
      i++
      continue
    }
    if (c === '&') {
      const prev = cur[cur.length - 1]
      if (s[i + 1] === '&') {
        flush()
        i += 2
      } else if (s[i + 1] === '>' || prev === '>' || prev === '<') {
        cur += c // redirection: 2>&1, >&2, &>f, &>>f
        i++
      } else {
        flush()
        i++
      }
      continue
    }
    if (c === '|') {
      if (cur[cur.length - 1] === '>') {
        cur += c // `>|` clobber redirection
        i++
      } else {
        flush()
        i += s[i + 1] === '|' || s[i + 1] === '&' ? 2 : 1
      }
      continue
    }
    if (c === '(' && !normalise(cur)) {
      if (s[i + 1] === '(') {
        // Arithmetic `(( … ))`: kept whole, then dropped by normalise.
        const end = skipGroup(s, i + 1, ')')
        cur += s.slice(i, end)
        i = end
      } else {
        flush()
        subshell++
        i++
      }
      continue
    }
    if (c === ')') {
      if (subshell > 0) {
        flush()
        subshell--
      } else {
        cur = '' // a case pattern like `a)`
      }
      i++
      continue
    }
    if (c === '#' && (cur === '' || /\s$/.test(cur))) {
      const nl = s.indexOf('\n', i)
      i = nl < 0 ? s.length : nl
      continue
    }
    cur += c
    i++
  }
  flush()
  return [...new Set(out)]
}

// --- prefixes and rules ----------------------------------------------------------------------

const FLAG = /^-{1,2}[A-Za-z][A-Za-z0-9-]*$/
const SUBCOMMAND = /^[a-z]+(-[a-z]+)*$/
// git's global options that take the next word as their value (`-C <path>`, `-c <k=v>`, `--git-dir <path>`);
// `--opt=value` carries its own and other global options (`--no-pager`) take none.
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'])

/** Whether a first word runs git, whatever its path, case or `.exe`. */
function isGit(word: string): boolean {
  return (word.split('/').pop() ?? '').toLowerCase().replace(/\.exe$/, '') === 'git'
}

/** The index of the first word after git's global options and their values, counting git itself as word 0. */
function afterGitOptions(words: readonly string[]): number {
  let k = 1
  while (k < words.length && words[k].startsWith('-')) k += GIT_VALUE_FLAGS.has(words[k]) ? 2 : 1
  return k
}

/** The words of `s` with their start and end, quote-aware (`-C "my repo"` is one value). */
function wordsOf(s: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = []
  let i = 0
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++
      continue
    }
    const end = wordEnd(s, i)
    out.push({ text: s.slice(i, end), start: i, end })
    i = end
  }
  return out
}

/** A rule prefix for one part: the program, up to two subcommands, and flags, stopping at the first
 *  argument. Narrow on purpose: a prefix that is too short allows more than the user saw. git keeps all its
 *  global options (`-C <path>`, `--work-tree=<path>`, …) and goes on to the subcommand: without it the rule
 *  would allow every git command. */
export function suggestPrefix(part: string): string {
  const toks = wordsOf(part)
  if (!toks.length) return ''
  const start = toks[0].start
  let end = toks[0].end
  const git = isGit(toks[0].text)
  // A script path takes arguments, not subcommands.
  if (!git && !/^[A-Za-z][\w-]*$/.test(toks[0].text)) return part.slice(start, end)
  let k = 1
  if (git) {
    k = Math.min(afterGitOptions(toks.map((t) => t.text)), toks.length)
    end = toks[k - 1].end
  }
  let subs = 0
  let flagSeen = false
  for (; k < toks.length; k++) {
    const w = toks[k].text
    if (FLAG.test(w)) flagSeen = true
    else if (SUBCOMMAND.test(w) && (flagSeen ? FLAG.test(toks[k + 1]?.text ?? '') : subs < 2)) {
      if (!flagSeen) subs++
    } else break
    end = toks[k].end
  }
  return part.slice(start, end)
}

export function ruleOfPrefix(prefix: string): string {
  return `Bash(${prefix}:*)`
}

/** What is wrong with the shape of a prefix, or null. Parentheses and backslashes would let a prefix
 *  break out of `Bash(…)`, so they are refused. */
function shapeError(p: unknown): string | null {
  if (typeof p !== 'string' || p.trim() === '') return 'The prefix is empty.'
  if (p !== p.trim()) return 'Remove the spaces at the start or end of the prefix.'
  if (p.length > MAX_PREFIX) return `The prefix is longer than ${MAX_PREFIX} characters.`
  if (/[\x00-\x1f\x7f]/.test(p)) return 'The prefix cannot contain line breaks or control characters.'
  if (p.includes('*')) return 'The prefix cannot contain *.'
  if (/[()\\]/.test(p)) return 'The prefix cannot contain parentheses or backslashes.'
  return null
}

/** The prefix of exactly `Bash(<prefix>:*)`, or null for any other rule or a prefix of a bad shape. */
export function prefixOfRule(rule: string): string | null {
  if (typeof rule !== 'string') return null
  const m = /^Bash\(([^()]*):\*\)$/.exec(rule)
  return m && shapeError(m[1]) === null ? m[1] : null
}

/** Why no rule may start with a shell, interpreter or wrapper, without the advice to narrow it: where nothing can be allowed
 *  (the Allow card's blocker list), that advice has nothing to act on. */
export const PROGRAM_REASON =
  'Auto ignores rules that start with a shell, an interpreter, a wrapper or a word that expands at run time, or such a rule would run any command.'
export const PROGRAM_MESSAGE = `${PROGRAM_REASON} Allow a narrower command instead.`

/** Whether a first word names a program that can run any command, or hides which program runs. */
function isInterpreter(word: string): boolean {
  // An expansion or a quote at the start hides the program: `$SHELL -c`, `` `echo sh` ``, `"sh"`.
  if (/^['"]|[$`]/.test(word)) return true
  // Quotes inside, a path, the case, an extension and a version must not hide it: `ba'sh'`, `/bin/BASH`, `python3.11.exe`.
  const base = (word.replace(/['"\\]/g, '').split('/').pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
  return INTERPRETERS.includes(base) || INTERPRETERS.includes(base.replace(/[\d.]+$/, ''))
}

/** Why a part's first word can never become a rule, or null. The sheet shows it instead of an editable prefix. */
export function programError(part: string): string | null {
  return isInterpreter(part.trim().split(/\s+/)[0] ?? '') ? PROGRAM_MESSAGE : null
}

/** git with no subcommand after its global options would allow every git command, and `git -c` can set
 *  `core.sshCommand` or an alias, so such a rule runs any program. */
function gitWithoutSubcommand(prefix: string): boolean {
  const words = wordsOf(prefix).map((t) => t.text)
  return words.length > 0 && isGit(words[0]) && afterGitOptions(words) >= words.length
}

function covers(part: string, prefix: string): boolean {
  return part === prefix || part.startsWith(prefix + ' ')
}

/** An error message when `prefix` may not become a rule at all (its shape, a shell or wrapper, git with no subcommand), or
 *  null. Agent Studio's Add checks only this, since the user typed the prefix with no refused command to match. */
export function prefixRuleError(prefix: string): string | null {
  const bad = shapeError(prefix)
  if (bad) return bad
  const program = programError(prefix)
  if (program !== null) return program
  if (gitWithoutSubcommand(prefix)) {
    return 'Add the git subcommand (such as git push): without it the rule would allow every git command, and git -c can run any program.'
  }
  return null
}

/** An error message when `prefix` may not become a rule for `command`, or null when it may. */
export function checkPrefix(prefix: string, command: string): string | null {
  const bad = prefixRuleError(prefix)
  if (bad) return bad
  if (typeof command !== 'string') return 'The command is missing.'
  // A git part run after a `cd` may be granted in its `git -C <folder>` form: the same command, which the CLI lets rules pass.
  const forms = gitCForms(command).flatMap((f) => (f === null ? [] : [f.part]))
  if (![...commandParts(command), ...forms].some((part) => covers(part, prefix))) {
    return 'The prefix must be the start of one command in the refused command, ending at a space.'
  }
  return null
}

/** The first rule that allows `part`, or null. */
export function coveredBy(part: string, rules: readonly string[]): string | null {
  for (const rule of rules) {
    const p = prefixOfRule(rule)
    if (p !== null && covers(part, p)) return rule
  }
  return null
}

/** A part needing no rule: a read-only helper. Stricter than the head alone: a write redirect, a
 *  command substitution or an in-place/output flag make it a real action. */
export function isSafePart(part: string): boolean {
  const head = part.trim().split(/\s+/)[0] ?? ''
  if (!SAFE_HEADS.includes(head)) return false
  if (/\$\(|`|<\(|>\(/.test(part)) return false
  // Harmless redirects (2>&1, >&2, > /dev/null) are fine; any other `>` writes a file.
  if (part.replace(/\d*>&\d+|&?\d*>>?\s*\/dev\/null/g, '').includes('>')) return false
  if (head === 'sed' && /(^|\s)(-[A-Za-z]*i|--in-place)/.test(part)) return false
  if (head === 'sort' && /(^|\s)(-[A-Za-z]*o|--output)/.test(part)) return false
  if (head === 'awk' && /system|\|/.test(part)) return false
  return true
}

/** Whether a part runs git, whatever its path, case or `.exe`. */
export function isGitPart(part: string): boolean {
  return isGit(part.trim().split(/\s+/)[0] ?? '')
}

// --- git after a cd --------------------------------------------------------------------------
// The CLI asks about `cd <folder> && git …` whatever is allowed (the folder's hooks or config could run), and in Auto that ask
// goes to the classifier, so no rule lets such a command through: granting its git parts as written only made the same command
// fail again. `git -C <folder> …` does the same and passes on its own prefix rules (probe cases e1, e2, e3; CLI 2.1.329), so
// the card offers that form, and the agent is told to run git that way.

// A folder written into a git -C form as it is: quotes or spaces would make the rule differ from what the agent writes.
const PLAIN_FOLDER = /^\/[^\s'"$`\\]*$/

/** `git <rest>` as `git -C <folder> <rest>`, or null when git already has global options (where -C goes is then a guess). */
function gitCForm(part: string, folder: string): string | null {
  const toks = wordsOf(part)
  if (!toks.length || !isGit(toks[0].text) || afterGitOptions(toks.map((t) => t.text)) > 1) return null
  return `${part.slice(0, toks[0].end)} -C ${folder}${part.slice(toks[0].end)}`
}

/** One entry per part of `command` (as `commandParts` gives them): a git part run after a `cd` into an absolute folder, as
 *  `git -C <folder> …` with that folder; null for every other part. Any other `cd` ends the folder. The folder must have a
 *  rule's shape (2+ segments, no glob or rule syntax) and be plain to write (no spaces or quotes). */
export function gitCForms(command: string): ({ part: string; folder: string } | null)[] {
  let folder: string | null = null
  return commandParts(command).map((part) => {
    if (/^cd(\s|$)/.test(part)) {
      const t = cdTarget(part)
      folder = t !== null && PLAIN_FOLDER.test(t) && folderShapeError(t) === null ? t : null
      return null
    }
    const form = folder === null ? null : gitCForm(part, folder)
    return form === null || folder === null ? null : { part: form, folder }
  })
}

/** The folder of the first `git -C` form one of `prefixes` grants and no part as written does, or null: the agent must then
 *  be told to run git that way, or it sends the same `cd … && git …` again. */
export function gitCFolder(prefixes: readonly string[], command: string): string | null {
  const parts = commandParts(command)
  for (const f of gitCForms(command)) {
    if (f === null) continue
    if (prefixes.some((p) => covers(f.part, p) && !parts.some((part) => covers(part, p)))) return f.folder
  }
  return null
}

/** What the agent is told to do instead of git after `cd <folder>`. */
export const gitCAdvice = (folder: string): string =>
  `Run git there as \`git -C ${folder} …\`, not after \`cd ${folder}\`: Claude Code asks about git after a cd into another folder, whatever is allowed.`

/** The message the Allow card sends when the agent ran git after a cd although the git -C rules are held. */
export function gitCText(folder: string, member: string | null): string {
  return `${member ? `@${member} ` : ''}${gitCAdvice(folder)} Continue.`
}

// --- folders ---------------------------------------------------------------------------------
// The CLI checks a `cd` into a folder outside the run's working folders before any Bash rule (Bash(cd:*) does not help), so a
// command such as `cd /other/repo && gh pr merge 1` is refused although every part's rule is held. A `Read(//<folder>/**)` allow
// rule lets that cd through (verified with CLI 2.1.329; `cd <folder> && git …` is still asked, by a check no rule passes).

// Glob and rule syntax a folder must not carry: it would widen `Read(//…/**)` or break out of it.
const FOLDER_BAD = /[\x00-\x1f\x7f*?[\]{}!()\\]/

/** `/a/./b/../c/` as `/a/c`; `..` above the root stays at the root. */
function normaliseFolder(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

/** The absolute folder a `cd <path>` part goes to, normalised, or null when it cannot be read for sure: a relative path, `~`,
 *  an expansion, an option, more than one argument, or quotes other than one pair around the whole path. */
export function cdTarget(part: string): string | null {
  const words = wordsOf(part.trim()).map((w) => w.text)
  if (words.length !== 2 || words[0] !== 'cd') return null
  let path = words[1]
  if (/^'[^']*'$/.test(path) || /^"[^"$`\\]*"$/.test(path)) path = path.slice(1, -1)
  else if (/['"$`\\]/.test(path)) return null
  return path.startsWith('/') ? normaliseFolder(path) : null
}

export function ruleOfFolder(folder: string): string {
  return `Read(/${folder}/**)`
}

/** What is wrong with the shape of a folder, or null. It must be absolute and already normalised, so the rule names exactly it. */
function folderShapeError(f: unknown): string | null {
  if (typeof f !== 'string' || f === '') return 'The folder is empty.'
  if (!f.startsWith('/')) return 'The folder must be an absolute path.'
  if (normaliseFolder(f) !== f) return 'The folder must be written plainly, without . or .. or a slash at the end.'
  if (f.length > MAX_PREFIX) return `The folder is longer than ${MAX_PREFIX} characters.`
  if (FOLDER_BAD.test(f)) return 'The folder cannot contain line breaks, *, ?, !, brackets, braces, parentheses or backslashes.'
  // `/` or `/etc` would let the agent read the whole disk or a whole system tree.
  if (f.split('/').length < 3) return 'Allow a narrower folder: this one holds too much.'
  return null
}

/** The folder of exactly `Read(//<folder>/**)`, or null for any other rule or a folder of a bad shape. */
export function folderOfRule(rule: string): string | null {
  if (typeof rule !== 'string') return null
  const m = /^Read\(\/(\/[^()]*)\/\*\*\)$/.exec(rule)
  return m && folderShapeError(m[1]) === null ? m[1] : null
}

/** A rule the Allow card can make: `Bash(<prefix>:*)` or `Read(//<folder>/**)`. */
export function isAllowRule(rule: string): boolean {
  return prefixOfRule(rule) !== null || folderOfRule(rule) !== null
}

/** Whether `path` is `folder` or inside it. */
const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(folder + '/')

/** The first rule whose folder holds `folder`, or null. */
export function folderCoveredBy(folder: string, rules: readonly string[]): string | null {
  for (const rule of rules) {
    const f = folderOfRule(rule)
    if (f !== null && inside(folder, f)) return rule
  }
  return null
}

/** The home folder as a folder rule names it, or null when it cannot be read (a UNC path). A Windows drive path takes the
 *  form Git Bash's `cd` and the CLI's rule matching both use: `C:\Users\me` is `/c/Users/me`. */
export function homeAsFolder(home: string): string | null {
  if (home.startsWith('/')) return normaliseFolder(home)
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(home)
  return m ? normaliseFolder(`/${m[1].toLowerCase()}/${(m[2] ?? '').replace(/\\/g, '/')}`) : null
}

/** An error message when `folder` may not become a rule at all, or null. `home`, when known, may not be the folder or inside
 *  it: such a rule would let the agent read ~/.ssh and every other secret there. Agent Studio's Add checks only this. */
export function folderRuleError(folder: string, home?: string): string | null {
  const bad = folderShapeError(folder)
  if (bad) return bad
  const h = home ? homeAsFolder(home) : null
  // Windows paths ignore case, so /c/users/ME still holds C:\Users\me.
  const fold = (s: string) => (home && !home.startsWith('/') ? s.toLowerCase() : s)
  if (h !== null && inside(fold(h), fold(folder))) {
    return 'The folder is your home folder or holds it: allow a folder inside it instead.'
  }
  return null
}

/** An error message when `folder` may not become a rule for `command`, or null when it may. */
export function checkFolder(folder: string, command: string, home?: string): string | null {
  const bad = folderRuleError(folder, home)
  if (bad) return bad
  if (typeof command !== 'string') return 'The command is missing.'
  if (!commandParts(command).some((part) => cdTarget(part) === folder)) return 'The folder must be one the refused command changes into.'
  return null
}

/** The message sent after the rules are granted. In a room it starts with `@member` so that member answers. */
export function continueText(
  rules: readonly string[],
  scope: 'chat' | 'agent',
  agent: string,
  member: string | null,
  gitFolder: string | null = null
): string {
  const items = rules.map((r) => '`' + r + '`')
  const list = items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items.join('')
  const how = gitFolder === null ? '' : ` ${gitCAdvice(gitFolder)}`
  return `${member ? `@${member} ` : ''}I allowed ${list} for ${scope === 'chat' ? 'this chat' : agent}.${how} Continue.`
}
