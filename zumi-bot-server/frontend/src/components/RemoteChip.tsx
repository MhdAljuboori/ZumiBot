import type { AgentSummary } from '@zumibot/shared/types'
import { remoteChip } from '../state/agentEngine'
import { EngineInfo } from './EngineInfo'

/** "Remote · host" beside a remote agent's name: where its messages go, with the notice one tap away. Nothing for any other agent. */
export function RemoteChip({ agent }: { agent: Pick<AgentSummary, 'provider' | 'remoteHost'> | undefined }) {
  const chip = remoteChip(agent)
  return chip === null ? null : <EngineInfo text={chip.title} label={chip.label} testId="remote-chip" />
}
