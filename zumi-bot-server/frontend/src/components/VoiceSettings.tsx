import { useEffect, useState } from 'react'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary } from '@zumibot/shared/types'
import {
  TALK_PHRASES_MAX,
  TALK_PHRASE_MAX,
  VOICE_KEY_MAX,
  type VoiceCheck,
  type VoiceClean,
  type VoiceStatus,
  type VoiceTalk
} from '@zumibot/shared/voice'
import { api } from '../api'
import { errorMessage } from '../errors'
import { isNotConnected } from '../state/resync'
import { useConnected } from '../useConnected'
import {
  addPhrase,
  aliasAgents,
  cleanAliases,
  removePhrase,
  sameAliases,
  setPhrase,
  talkAgents,
  type AliasDraft
} from '../state/talkSettings'
import { SearchSelect } from './SearchSelect'

const CHECK_COPY: Record<Exclude<VoiceCheck, { ok: true }>['reason'], string> = {
  invalid: 'OpenRouter refused the key.',
  unreachable: "Couldn't reach OpenRouter.",
  nokey: 'No key saved.'
}

/** The voice switch, the OpenRouter key and the voice conversation settings. The key goes to the server once and is never shown again. */
export function VoiceSettings({ agents }: { agents: AgentSummary[] }) {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  // The alias phrases being typed, blank rows included; the server only ever gets the cleaned list.
  const [aliases, setAliases] = useState<AliasDraft | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  // Asked again on each reconnect, keeping alias phrases being typed; one cut off by a drop is not an error.
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    api.voice.status().then(
      (st) => {
        setStatus(st)
        setAliases((a) => a ?? st.talk.aliases)
      },
      (e) => {
        if (!isNotConnected(e)) setNote({ ok: false, text: errorMessage(e) })
      }
    )
  }, [connected])

  const test = async (): Promise<void> => {
    const r = await api.voice.check()
    setNote(r.ok ? { ok: true, text: 'OpenRouter accepted the key.' } : { ok: false, text: CHECK_COPY[r.reason] })
  }
  const run = (fn: () => Promise<void>) => async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await fn()
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }
  const saveKey = run(async () => {
    setStatus(await api.voice.set({ key }))
    setKey('')
    await test()
  })
  const removeKey = run(async () => {
    setStatus(await api.voice.set({ key: null }))
    setNote({ ok: true, text: 'Key removed. Voice input is not used until you add one.' })
  })
  const flip = (on: boolean): void => {
    if (!status) return
    setStatus({ ...status, enabled: on })
    api.voice.set({ enabled: on }).then(setStatus, (e) => {
      // Re-read rather than roll back, as Jev's settings do.
      api.voice.status().then(setStatus, () => {})
      setNote({ ok: false, text: errorMessage(e) })
    })
  }

  const saveTalk = (talk: Partial<VoiceTalk>): void => {
    api.voice.set({ talk }).then(setStatus, (e) => {
      api.voice.status().then(setStatus, () => {})
      setNote({ ok: false, text: errorMessage(e) })
    })
  }
  const saveClean = (clean: Partial<VoiceClean>): void => {
    if (!status) return
    setStatus({ ...status, clean: { ...status.clean, ...clean } })
    api.voice.set({ clean }).then(setStatus, (e) => {
      api.voice.status().then(setStatus, () => {})
      setNote({ ok: false, text: errorMessage(e) })
    })
  }
  // Called after a phrase is typed or removed: nothing is sent unless the cleaned list differs from what is saved.
  const commitAliases = (d: AliasDraft): void => {
    if (status && !sameAliases(cleanAliases(d), status.talk.aliases)) saveTalk({ aliases: cleanAliases(d) })
  }

  const enabled = status?.enabled === true
  const talk = status?.talk
  const usable = talkAgents(agents)
  return (
    <div data-testid="settings-voice">
      <p className="set-intro">
        Speech is sent to ElevenLabs Scribe v2 through OpenRouter, with zero data retention. Audio is never stored.
      </p>
      <div className="set-card">
        <label className="set-row">
          <span className="set-text">
            <span className="set-label">Use voice input</span>
            <span className="set-hint">
              {!enabled
                ? 'Off: the microphone buttons are hidden.'
                : status?.keySaved
                  ? 'On.'
                  : 'On, but nothing happens until you add a key.'}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            data-testid="voice-enabled"
            checked={enabled}
            disabled={status === null}
            onChange={(e) => flip(e.target.checked)}
          />
        </label>
      </div>

      {status?.on === true && (
        <>
          <h2 className="set-group">Clean up speech</h2>
          <div className="set-card" data-testid="voice-clean">
            <label className="set-row">
              <span className="set-text">
                <span className="set-label">Remove filler words</span>
                <span className="set-hint">Cuts uh, um, hmm and اممم from what you say.</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                data-testid="voice-clean-fillers"
                checked={status.clean.fillers}
                onChange={(e) => saveClean({ fillers: e.target.checked })}
              />
            </label>
            <label className="set-row">
              <span className="set-text">
                <span className="set-label">Fix mistakes with AI</span>
                <span className="set-hint">
                  Claude Haiku tidies each clip: drops fillers and false starts and keeps only your correction. About a second slower; sent
                  with zero data retention.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                data-testid="voice-clean-rewrite"
                checked={status.clean.rewrite}
                onChange={(e) => saveClean({ rewrite: e.target.checked })}
              />
            </label>
          </div>
        </>
      )}

      {status?.on === true && talk && aliases && (
        <>
          <h2 className="set-group">Voice requests</h2>
          <div className="set-card" data-testid="voice-talk">
            <label className="set-row">
              <span className="set-text">
                <span className="set-label">Talk to your agents</span>
                <span className="set-hint">
                  {talk.enabled
                    ? 'On: the mic in the top bar and the desk shortcut take a spoken request and open the chat.'
                    : 'Off: the talk button is hidden.'}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                data-testid="voice-talk-enabled"
                checked={talk.enabled}
                onChange={(e) => saveTalk({ enabled: e.target.checked })}
              />
            </label>
            <label className="set-row">
              <span className="set-text">
                <span className="set-label">Default agent</span>
                <span className="set-hint">Answers when you don't name one.</span>
              </span>
              <SearchSelect
                className="field"
                data-testid="voice-talk-agent"
                value={talk.defaultAgent ?? ''}
                onChange={(v) => saveTalk({ defaultAgent: v === '' ? null : v })}
              >
                <option value="">Ask me which</option>
                {talk.defaultAgent !== null && !usable.some((a) => a.name === talk.defaultAgent) && (
                  <option value={talk.defaultAgent}>{displayName(talk.defaultAgent)} (unavailable)</option>
                )}
                {usable.map((a) => (
                  <option key={a.name} value={a.name}>
                    {displayName(a.name)}
                  </option>
                ))}
              </SearchSelect>
            </label>
          </div>

          <h2 className="set-group">Spoken names</h2>
          <p className="set-hint set-intro">Other ways to say an agent's name, such as its name in Arabic letters.</p>
          <div className="set-card" data-testid="voice-aliases">
            {aliasAgents(agents, aliases).map((name) => {
              const list = aliases[name] ?? []
              return (
                <div key={name} className="set-block" data-testid={`voice-alias-${name}`}>
                  <span className="set-label">{displayName(name)}</span>
                  {list.map((phrase, i) => (
                    <div key={i} className="set-key">
                      <input
                        className="field"
                        aria-label={`Spoken name ${i + 1} for ${displayName(name)}`}
                        maxLength={TALK_PHRASE_MAX}
                        spellCheck={false}
                        value={phrase}
                        onChange={(e) => setAliases(setPhrase(aliases, name, i, e.target.value))}
                        onBlur={() => commitAliases(aliases)}
                      />
                      <button
                        type="button"
                        className="btn small"
                        aria-label={`Remove spoken name ${i + 1} for ${displayName(name)}`}
                        onClick={() => {
                          const next = removePhrase(aliases, name, i)
                          setAliases(next)
                          commitAliases(next)
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {list.length < TALK_PHRASES_MAX && (
                    <div className="set-actions">
                      <button type="button" className="btn small" onClick={() => setAliases(addPhrase(aliases, name))}>
                        Add a spoken name
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
            {usable.length === 0 && <p className="set-block set-hint">There are no agents voice can talk to yet.</p>}
          </div>
        </>
      )}

      <h2 className="set-group">OpenRouter API key</h2>
      <div className="set-card">
        <div className="set-block">
          <p className="set-hint" data-testid="voice-key-state">
            {status === null ? '…' : status.keySaved ? 'Key saved' : 'No key saved.'}
          </p>
          <form
            className="set-key"
            onSubmit={(e) => {
              e.preventDefault()
              if (key.trim()) void saveKey()
            }}
          >
            <input
              type="password"
              className="field"
              data-testid="voice-key"
              aria-label="OpenRouter API key"
              placeholder={status?.keySaved ? 'Paste a new key to replace it' : 'sk-or-…'}
              autoComplete="off"
              spellCheck={false}
              maxLength={VOICE_KEY_MAX}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button type="submit" className="btn primary" data-testid="voice-key-save" disabled={busy || !key.trim()}>
              Save
            </button>
          </form>
          {status?.keySaved && (
            <div className="set-actions">
              <button type="button" className="btn small" data-testid="voice-key-test" disabled={busy} onClick={run(test)}>
                Check key
              </button>
              <button type="button" className="btn small" data-testid="voice-key-remove" disabled={busy} onClick={removeKey}>
                Remove key
              </button>
            </div>
          )}
          {note && (
            <p className={note.ok ? 'set-note' : 'set-note bad'} role="status" data-testid="voice-note">
              {note.text}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
