import type { CommandPick } from './commands'
import type { Step } from './workflows'

const pick = (c: CommandPick | undefined, from: string, to: string): CommandPick | undefined =>
  c && c.agent === from ? { ...c, agent: to } : c

/** The step with agent `from` named `to` instead (an agent or For each step's agent, a room's members, any command's agent); null when nothing names it, so a caller can tell whether to write. */
export function renameStepAgent(s: Step, from: string, to: string): Step | null {
  switch (s.kind) {
    case 'agent':
    case 'foreach': {
      if (s.agent !== from && s.command?.agent !== from) return null
      return {
        ...s,
        ...(s.agent === from ? { agent: to } : {}),
        ...(s.command?.agent === from ? { command: pick(s.command, from, to)! } : {})
      }
    }
    case 'room': {
      if (!s.members?.includes(from) && s.command?.agent !== from) return null
      return {
        ...s,
        ...(s.members?.includes(from) ? { members: s.members.map((m) => (m === from ? to : m)) } : {}),
        ...(s.command?.agent === from ? { command: pick(s.command, from, to)! } : {})
      }
    }
    case 'chat':
      return s.command?.agent === from ? { ...s, command: pick(s.command, from, to)! } : null
    default:
      return null
  }
}
