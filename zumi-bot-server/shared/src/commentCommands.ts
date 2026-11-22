import { fillPrompt, type AgentCommand } from './commands'
import { maskCode, splitMentions } from './mentions'

// `/name` anywhere in a comment: at the start or after whitespace, then whitespace or the end, so "/etc/hosts" or a
// link's path is never one.
const COMMAND_TOKEN = /(?<!\S)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

export interface CommandToken {
  name: string
  start: number
  end: number
}

/** Every `/name` written in the text, in order, code aside. */
export function commandTokens(text: string): CommandToken[] {
  return Array.from(maskCode(text).matchAll(COMMAND_TOKEN), (m) => ({ name: m[1]!, start: m.index, end: m.index + m[0].length }))
}

/** A command a comment's mention runs: its name and prompt filled with the comment's own words. */
export interface CommentCommand {
  name: string
  prompt: string
}

/**
 * The commands of one mentioned agent a comment names, each once, in the order written. Its `$ARGUMENTS` is the
 * comment with every handle and every named command taken out, so "@a /card fix login" fills /card with "fix login".
 */
export function commentCommands(text: string, owned: readonly AgentCommand[], members: readonly string[]): CommentCommand[] {
  const tokens = commandTokens(text)
  const picked: AgentCommand[] = []
  for (const t of tokens) {
    const cmd = owned.find((c) => c.name === t.name)
    if (cmd && !picked.includes(cmd)) picked.push(cmd)
  }
  if (picked.length === 0) return []
  // Only tokens some agent owns are cut; any other "/word" is the user's text.
  const names = new Set(owned.map((c) => c.name))
  let rest = ''
  let pos = 0
  for (const t of tokens) {
    if (!names.has(t.name)) continue
    rest += text.slice(pos, t.start)
    pos = t.end
  }
  rest += text.slice(pos)
  const args = splitMentions(rest, members, true)
    .map((s) => (s.kind === 'text' ? s.text : ''))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim()
  return picked.map((c) => ({ name: c.name, prompt: fillPrompt(c.prompt, args) }))
}
