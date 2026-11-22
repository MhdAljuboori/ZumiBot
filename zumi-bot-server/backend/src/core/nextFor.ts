import type { RoutineTrigger } from '@zumibot/shared/routines'
import type { WorkflowTrigger } from '@zumibot/shared/workflows'
import { nextRun } from '@zumibot/shared/schedule'

/** When a routine or workflow due by schedule fires next; null for anything else, or while it is off. */
export function nextFor(trigger: RoutineTrigger | WorkflowTrigger, enabled: boolean, timeZone: string, now: number): number | null {
  return enabled && trigger.kind === 'schedule' ? nextRun(trigger.schedule, timeZone, now) : null
}
