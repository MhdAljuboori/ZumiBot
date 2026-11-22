import type { VersionInfo } from '@zumibot/shared/types'
import { canStep, versionLabel } from '../state/messageEdit'

interface Props {
  versions: VersionInfo
  /** Why no switch can go now (a reply is running, a switch is on its way, sending can't happen), else null. */
  blocked: string | null
  onStep: (index: number) => void
}

/** `‹ n / m ›` under a user message that has more than one version. */
export function VersionSwitcher({ versions, blocked, onStep }: Props) {
  const step = (dir: -1 | 1) => {
    const label = dir < 0 ? 'Previous version' : 'Next version'
    const end = !canStep(versions, dir)
    return (
      <button
        type="button"
        className="version-arrow"
        data-testid={dir < 0 ? 'version-prev' : 'version-next'}
        aria-label={label}
        // The reason only on an arrow that would lead somewhere: at the last version "›" is off for that alone.
        data-tip={blocked !== null && !end ? blocked : label}
        disabled={blocked !== null || end}
        onClick={() => onStep(versions.index + dir)}
      >
        {dir < 0 ? '‹' : '›'}
      </button>
    )
  }
  return (
    <div
      className="versions"
      data-testid="version-switcher"
      role="group"
      aria-label="Message versions"
      // Also on the group: some browsers send no pointer events to a disabled button.
      {...(blocked === null ? {} : { 'data-tip': blocked, 'data-blocked': '' })}
    >
      {step(-1)}
      <span className="version-label" aria-live="polite">
        {versionLabel(versions)}
      </span>
      {step(1)}
    </div>
  )
}
