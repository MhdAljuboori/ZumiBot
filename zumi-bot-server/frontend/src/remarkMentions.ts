import type { Nodes, Parent, Root, Text } from 'mdast'
import { commandTokens } from '@zumibot/shared/commentCommands'
import { splitMentions } from '@zumibot/shared/mentions'
import { codeHandle } from './state/agentNames'

/** A member's @handle in agent text; becomes a `<mention name>` element that MessageList renders as a chip. */
export interface MentionNode extends Parent {
  type: 'mention'
  name: string
  children: Text[]
  data: { hName: 'mention'; hProperties: { name: string } }
}

/** A `/name` a comment runs; becomes a `<command name agent>` element rendered as a command chip. */
export interface CommandNode extends Parent {
  type: 'command'
  children: Text[]
  data: { hName: 'command'; hProperties: { name: string; agent: string } }
}

declare module 'mdast' {
  interface PhrasingContentMap {
    mention: MentionNode
    command: CommandNode
  }
  interface RootContentMap {
    mention: MentionNode
    command: CommandNode
  }
}

const mentionNode = (name: string, raw: string): MentionNode => ({
  type: 'mention',
  name,
  children: [{ type: 'text', value: raw }],
  data: { hName: 'mention', hProperties: { name } }
})

function walk(node: Parent, members: readonly string[], agents: readonly { name: string }[]): void {
  let changed = false
  const out: Nodes[] = []
  for (const child of node.children as Nodes[]) {
    // Code spans and blocks are literal nodes (a value, no children), so their text is never split; a code span that
    // spells an agent's handle exactly (`ui-ux-specialist`) names that agent, so it reads as its chip.
    if (child.type === 'inlineCode') {
      const name = codeHandle(child.value, agents)
      if (name !== null) {
        changed = true
        out.push(mentionNode(name, child.value))
        continue
      }
    } else if (child.type === 'text') {
      const segs = splitMentions(child.value, members)
      if (segs.some((s) => s.kind === 'mention')) {
        changed = true
        for (const s of segs) out.push(s.kind === 'text' ? { type: 'text', value: s.text } : mentionNode(s.name, s.raw))
        continue
      }
    } else if ('children' in child) {
      walk(child, members, agents)
    }
    out.push(child)
  }
  if (changed) node.children = out as Parent['children']
}

/**
 * Remark plugin: member @handles in text become `mention` nodes, and so does a code span that is exactly one of `agents`'
 * handles; anything else inside code stays as written.
 */
export function remarkMentions(members: readonly string[], agents: readonly { name: string }[] = []) {
  return () =>
    (tree: Root): void => {
      if (members.length > 0 || agents.length > 0) walk(tree, members, agents)
    }
}

/**
 * Remark plugin for a comment: each `/name` in `commands` (name to the agent whose color it takes, '' for none) becomes a
 * `command` node. Code is a literal node, so a `/name` inside it stays as written.
 */
export function remarkCommands(commands: ReadonlyMap<string, string>) {
  const split = (node: Parent): void => {
    const out: Nodes[] = []
    let changed = false
    for (const child of node.children as Nodes[]) {
      if (child.type === 'text') {
        const hits = commandTokens(child.value).filter((t) => commands.has(t.name))
        if (hits.length > 0) {
          changed = true
          let pos = 0
          for (const t of hits) {
            if (t.start > pos) out.push({ type: 'text', value: child.value.slice(pos, t.start) })
            out.push({
              type: 'command',
              children: [{ type: 'text', value: `/${t.name}` }],
              data: { hName: 'command', hProperties: { name: t.name, agent: commands.get(t.name)! } }
            })
            pos = t.end
          }
          if (pos < child.value.length) out.push({ type: 'text', value: child.value.slice(pos) })
          continue
        }
      } else if ('children' in child && child.type !== 'mention') {
        split(child)
      }
      out.push(child)
    }
    if (changed) node.children = out as Parent['children']
  }
  return () =>
    (tree: Root): void => {
      if (commands.size > 0) split(tree)
    }
}
