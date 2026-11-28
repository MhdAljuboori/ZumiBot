import type { RecallScope } from '@zumibot/shared/recall'

export interface RecallChoice {
  value: RecallScope | null
  label: string
  hint: string
  active: boolean
}

const CHOICES: readonly Omit<RecallChoice, 'active'>[] = [
  { value: null, label: 'Off', hint: 'No past chats' },
  { value: 'agent', label: 'Own chats', hint: 'Its chats and rooms' },
  { value: 'folder', label: 'This folder', hint: 'Any agent, same folder' }
]

/** Agent Studio's Recall card. Off removes the key: absent is off, so the file never says `recall: off`. */
export const recallChoices = (current: RecallScope | null): RecallChoice[] => CHOICES.map((c) => ({ ...c, active: c.value === current }))
