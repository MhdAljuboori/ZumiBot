import { useEffect, useRef } from 'react'
import { displayName } from '@zumibot/shared/agentName'
import type { AgentSummary } from '@zumibot/shared/types'
import type { VoiceTalk } from '@zumibot/shared/voice'
import { pathFor } from '../state/route'
import { ISLAND_NOTICE_MS, shouldStopTalk, talkEndAction, talkStatus } from '../state/talkOps'
import type { TalkPhase } from '../state/voiceTalk'
import { WAVE_DOTS, waveDots } from '../state/voiceWave'
import { BotIcon } from './BotIcon'
import { useVoiceTalk } from '../useVoiceTalk'

interface Props {
  agents: AgentSummary[]
  /** The saved talk settings; null while the server has not said (the page loads before its status does). */
  talk: VoiceTalk | null
  /** Voice conversations can run here: talk is on and this browser records. */
  available: boolean
  /** Start at once if the page has had a tap or click; the home-screen shortcut lands without one and asks for a tap. */
  autoStart?: boolean
  /** The island popup: a smaller layout, no page title. */
  compact?: boolean
  /** The host starts it with no tap on this page (the island: a global shortcut, not a click, asked for it), so `autoStart` needs none. */
  noTap?: boolean
  /** The desk island's page: its window reads as hidden while in use, so hiding does not end the talk. */
  island?: boolean
  /**
   * The talk is over and the host may drop the view: at once after a plain no-speech, else after ISLAND_NOTICE_MS so its
   * notice can be read (an unknown agent, a failed send). Not called when a chat was opened (onOpenChat is) or on Stop,
   * which goes to idle.
   */
  onEnded?(): void
  /** The request is in its chat: show the chat. The talk has ended; leaving the page is what unmounts this. */
  onOpenChat(chatId: string, agent: string | null): void
  onClose?(): void
}

const EMPTY_TALK: VoiceTalk = { enabled: true, defaultAgent: null, aliases: {} }

/** The dotted line under the avatar. It redraws every animation frame from the mic level without re-rendering React. */
function VoiceWave({ phase, level }: { phase: TalkPhase; level: () => number }) {
  const dots = useRef<(HTMLSpanElement | null)[]>([])
  const live = useRef(phase)
  live.current = phase
  useEffect(() => {
    // Reduced motion: the dots stay put; the status line still says what is going on.
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    let frame = 0
    let smooth = 0
    const draw = (): void => {
      // Fast attack, slow release: speech looks lively but the line doesn't flicker between syllables.
      const l = level()
      smooth = l > smooth ? l : smooth * 0.85 + l * 0.15
      const ys = still ? waveDots('idle', 0, 0) : waveDots(live.current, smooth, performance.now())
      ys.forEach((y, i) => {
        const d = dots.current[i]
        if (d) d.style.transform = `translateY(${(y * 14).toFixed(1)}px) scale(${(1 + Math.abs(y) * 0.6).toFixed(2)})`
      })
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [level])
  return (
    <div className="voice-wave" aria-hidden="true">
      {Array.from({ length: WAVE_DOTS }, (_, i) => (
        <span key={i} ref={(el) => void (dots.current[i] = el)} />
      ))}
    </div>
  )
}

/** A page has had a tap or click, so it may start the mic and play sound. The shortcut's `?start=1` can land without one. */
const hasActivation = (): boolean => navigator.userActivation?.hasBeenActive === true

/** The voice request screen: what it is doing, a big Stop, and a way to the chat if one was made. Full screen on a phone; compact in the island. */
export function VoiceTalkView({
  agents,
  talk,
  available,
  autoStart = false,
  compact = false,
  noTap = false,
  island = false,
  onEnded,
  onOpenChat,
  onClose
}: Props) {
  const t = useVoiceTalk({ agents, talk: talk ?? EMPTY_TALK, island, onOpen: onOpenChat })
  const { phase, chatId } = t.state
  const { start, stop } = t
  const active = phase !== 'idle' && phase !== 'ended'

  // Once, and only when a tap has already happened: a start without one could not open the mic or play a sound.
  const tried = useRef(false)
  useEffect(() => {
    if (tried.current || !autoStart || !available || talk === null) return
    tried.current = true
    if (noTap || hasActivation()) start()
  }, [autoStart, noTap, available, talk, start])
  // A remount (StrictMode's, in development) is a new page: it may start again.
  useEffect(
    () => () => {
      tried.current = false
    },
    []
  )

  const ended = useRef(onEnded)
  ended.current = onEnded
  const endNotice = t.state.notice
  useEffect(() => {
    if (phase !== 'ended') return
    // A notice stays up for a while; a new talk, Stop or the host closing the view clears the timer.
    if (talkEndAction(endNotice) === 'close') return void ended.current?.()
    const timer = setTimeout(() => ended.current?.(), ISLAND_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [phase, endNotice])

  // Not only at the first render: talk can be switched off in another tab, or the mic refused, while it runs.
  const mustStop = shouldStopTalk(phase, available, talk !== null)
  useEffect(() => {
    if (mustStop) stop()
  }, [mustStop, stop])

  // The face of whoever is listening: the agent the talk went to, else the one it would go to.
  const faceName = t.state.agent ?? talk?.defaultAgent ?? null
  const face = agents.find((a) => a.name === faceName) ?? null
  const hearing = phase === 'listening'
  const busy = phase === 'transcribing' || phase === 'sending'
  // The avatar is the main control: it starts a talk.
  const avatarAction = !active && available ? t.start : null
  const avatarId = !active ? 'voice-start' : 'voice-avatar'
  const avatarLabel = !active ? 'Start talking' : `${face ? displayName(face.name) : 'The agent'} is ${hearing ? 'listening' : 'busy'}`
  // What the user is told: the machine's notice (why it went nowhere, what it asks for), then the hook's own (the mic, the server's error text).
  const note = [t.state.notice, t.notice].filter(Boolean).join(' ') || null

  return (
    <section className={`voice-talk${compact ? ' compact' : ''}`} data-testid="voice-talk" data-phase={phase}>
      {!compact && onClose && (
        <button type="button" className="voice-talk-back" data-testid="voice-back" aria-label="Back" onClick={onClose}>
          ‹
        </button>
      )}

      {talk === null && !active ? (
        <p className="voice-talk-note" data-testid="voice-loading">
          Loading…
        </p>
      ) : !available && !active ? (
        <p className="voice-talk-note" role="status" data-testid="voice-unavailable">
          Voice requests are off, or this browser cannot record. Turn them on in Settings › Voice.
        </p>
      ) : (
        <>
          <button
            type="button"
            className={`voice-face${hearing ? ' hearing' : ''}`}
            data-testid={avatarId}
            aria-label={avatarLabel}
            disabled={avatarAction === null}
            onClick={avatarAction ?? undefined}
          >
            <BotIcon
              icon={face?.icon ?? null}
              color={face && face.error === null ? face.color : null}
              builtIn={face?.builtIn}
              working={busy}
              size={compact ? 92 : 132}
            />
            {hearing && <span className="voice-face-dot" />}
          </button>

          <VoiceWave phase={phase} level={t.level} />

          <p className="voice-talk-status" role="status" aria-live="polite" data-testid="voice-status" data-phase={phase}>
            {talkStatus(phase)}
          </p>

          {(note || !available) && (
            <p
              className={`voice-talk-note${t.notice || phase === 'ended' || !available ? ' error' : ''}`}
              role="alert"
              data-testid="voice-notice"
            >
              {note ?? 'Voice requests were switched off.'}
            </p>
          )}

          <div className="voice-talk-controls">
            {active && (
              <button type="button" className="voice-talk-stop" data-testid="voice-stop" aria-label="Stop" onClick={t.stop}>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            )}
            {chatId !== null && (
              <a
                className="voice-talk-open"
                data-testid="voice-open-chat"
                href={pathFor(chatId)}
                onClick={(e) => {
                  e.preventDefault()
                  onOpenChat(chatId, t.state.agent)
                }}
              >
                Open chat
              </a>
            )}
          </div>
        </>
      )}
    </section>
  )
}
