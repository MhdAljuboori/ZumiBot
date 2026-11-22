import {
  CHAT_MODES,
  DEFAULT_EFFORT,
  EFFORTS,
  engineChatEffort,
  engineChatMode,
  modeFits,
  type ChatMode,
  type Effort
} from '@zumibot/shared/chatRun'
import type { Engine } from '@zumibot/shared/engine'

export interface Choice {
  value: string | null
  label: string
}

/** A picker under the composer: the button's text and tooltip, the checked option (null = the default, where it is an option) and the menu. */
export interface ChoiceView {
  label: string
  title: string
  current: string | null
  options: Choice[]
}

const NEXT = ' Applies from the next message.'

const MODE_LABEL: Record<'auto' | ChatMode, string> = {
  auto: 'Auto',
  manual: 'Ask permissions',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode'
}
const MODE_HINT: Record<Engine, Partial<Record<'auto' | ChatMode, string>>> = {
  claude: {
    auto: 'Auto: Claude Code decides which steps need your approval.',
    manual: 'Ask permissions: the agent asks before every edit and command.',
    acceptEdits: 'Accept edits: file edits run without asking; commands still ask.',
    plan: 'Plan mode: the agent reads and plans, and changes nothing until you approve its plan. Approving the plan switches the chat back to Auto.'
  },
  codex: {
    auto: 'Auto: Codex runs what its reviewer finds safe and asks about the rest.',
    manual: 'Ask permissions: Codex asks before anything it does not know to be safe.'
  },
  acp: {
    manual:
      'Ask permissions: the agent is put in its own ask-first mode (default) when it has one, and every call it asks about gets a card. Its own settings decide which calls ask.'
  },
  'ag-ui': {
    manual: 'Ask permissions: the remote server decides what runs. A card shows only for an interrupt the server describes.'
  }
}

// Whether the picker offers Auto (the server's mode). ZumiBot has no classifier for an ACP agent and puts it in its own
// asking mode where it has one, so its turns all run as Ask permissions, and that is the one choice shown. A remote agent's
// server decides what runs; ZumiBot only shows the interrupts it describes, so Auto would promise a choice it can't make.
const AUTO_OFFERED: Record<Engine, boolean> = { claude: true, codex: true, acp: false, 'ag-ui': false }

/**
 * The permission mode picker of a single chat or the new-chat screen. A mode the engine can't run reads as Auto, as the server
 * runs it; on an engine without Auto it reads as Ask permissions, its only choice.
 */
export function modePicker(engine: Engine, chat: { permissionMode?: ChatMode }): ChoiceView {
  const auto = AUTO_OFFERED[engine]
  const current = engineChatMode(engine, chat) ?? (auto ? null : 'manual')
  const key = current ?? 'auto'
  const fitting = CHAT_MODES.filter((m) => modeFits(engine, m)).map((m) => ({ value: m, label: MODE_LABEL[m] }))
  const options = auto ? [{ value: null, label: MODE_LABEL.auto }, ...fitting] : fitting
  return {
    label: MODE_LABEL[key],
    // A single choice has nothing to apply.
    title: (MODE_HINT[engine][key] ?? '') + (options.length > 1 ? NEXT : ''),
    current,
    options
  }
}

const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

/** The effort picker of a single Claude chat or the new-chat screen; null for Codex, which has none (chatRun.ts). */
export function effortPicker(engine: Engine, chat: { effort?: Effort }): ChoiceView | null {
  if (engine !== 'claude') return null
  const current = engineChatEffort(engine, chat) ?? DEFAULT_EFFORT
  return {
    label: `${EFFORT_LABEL[current]} effort`,
    title: `How much the agent thinks before it answers: more is slower and costs more. ${EFFORT_LABEL[DEFAULT_EFFORT]} by default.` + NEXT,
    current,
    options: EFFORTS.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))
  }
}

// The phone's chip has room for a word per setting; its menu names each in full under its own heading.
const MODE_SHORT: Record<string, string> = { manual: 'Ask', plan: 'Plan' }

/**
 * The phone's one chip for the model, mode and effort pickers, so the row under the composer stays on one line: the
 * model (an agent's default by the model's own name), the mode in a word, and the effort's level once it is not the default.
 */
export function runSummary(model: { label: string } | null, mode: ChoiceView | null, effort: ChoiceView | null): string {
  const level =
    effort?.current != null && effort.current !== DEFAULT_EFFORT ? effort.options.find((o) => o.value === effort.current)?.label : undefined
  const parts = [model?.label.replace(/^Default \((.+)\)$/, '$1'), mode && (MODE_SHORT[mode.current ?? ''] ?? mode.label), level]
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ')
}
