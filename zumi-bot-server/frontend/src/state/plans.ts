import { parsePlan, planHeading } from '@zumibot/shared/plans'
import type { ApprovalItem, ApprovalReply } from './approvals'

/** The card's in-progress "Keep planning" note. Closed (`open: false`) until the user asks to type one. */
export interface PlanDraft {
  open: boolean
  feedback: string
}

export const EMPTY_PLAN_DRAFT: PlanDraft = { open: false, feedback: '' }

export const openFeedback = (d: PlanDraft): PlanDraft => ({ ...d, open: true })
export const typeFeedback = (d: PlanDraft, feedback: string): PlanDraft => ({ ...d, feedback })
// Cancel drops the text: a note typed and abandoned must not reappear on the next open.
export const cancelFeedback = (_d: PlanDraft): PlanDraft => EMPTY_PLAN_DRAFT

export function planView(item: ApprovalItem): { heading: string; plan: string | null; planFilePath: string | null } {
  return { heading: planHeading(item.agent ?? null), ...parsePlan(item.input) }
}

/** The status line of a card nobody can answer (a pending one is read-only too: its chat stopped). */
export function planLine(item: ApprovalItem): string {
  switch (item.status) {
    case 'approved':
      return 'Approved'
    case 'sent-back':
      return 'Sent back'
    // Saved before plan cards: the server denied every plan on the spot.
    case 'denied':
      return 'Not approved'
    default:
      return 'Not answered'
  }
}

export function planReply(approve: boolean, d: PlanDraft): ApprovalReply {
  const feedback = d.feedback.trim()
  return { plan: approve || feedback === '' ? { approve } : { approve, feedback } }
}
