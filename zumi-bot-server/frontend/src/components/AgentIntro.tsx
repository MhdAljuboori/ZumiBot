import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary } from '@zumibot/shared/types'
import { useBrowser } from '../useAgentBrowser'
import { BotIcon } from './BotIcon'

/** What an empty chat shows in place of messages: the agent's icon, name and description, centered in the pane. */
export function AgentIntro({ agent }: { agent: AgentSummary }) {
  const browser = useBrowser()
  const ok = agent.error === null
  return (
    <div className="chat-intro" data-testid="chat-intro">
      <BotIcon icon={agent.icon} color={ok ? agent.color : null} builtIn={agent.builtIn} working={false} size={96} />
      <h2 className="chat-intro-name">{displayName(agent.name)}</h2>
      {ok && agent.description !== '' && <p className="chat-intro-desc">{agent.description}</p>}
      {ok && browser && (
        <button type="button" className="btn" onClick={() => browser.open({ agent: agent.name })}>
          Open Browser
        </button>
      )}
    </div>
  )
}
