import type { WorkflowLink } from '@zumibot/shared/types'
import { chatBarText } from '../state/workflowRun'

interface Props {
  link: WorkflowLink
  /** The step's name in the workflow now; undefined once the step or the workflow is gone. */
  stepName: string | undefined
  onOpen: () => void
}

/** One line over the chat of a workflow's Agent step: which step it is, with a link to the run. */
export function WorkflowChatBar({ link, stepName, onOpen }: Props) {
  const { lead, href } = chatBarText(link, stepName)
  return (
    <div className="wf-chat-bar" data-testid="wf-chat-bar" role="status">
      {/* A real link, so it opens in a new tab on a middle click; a plain click goes through the unsaved-changes guard. */}
      <a
        href={href}
        className="wf-chat-bar-link"
        data-testid="wf-chat-bar-link"
        data-tip="Open the run"
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          e.preventDefault()
          onOpen()
        }}
      >
        {lead}
      </a>
    </div>
  )
}
