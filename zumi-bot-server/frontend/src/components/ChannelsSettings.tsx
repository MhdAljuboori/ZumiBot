import { useEffect, useState } from 'react'
import { displayName } from '@zumibot/shared/agentName'
import { CHANNEL_LABELS, COMMAND_PREFIX, type ChannelPlatform, type ChannelStatus } from '@zumibot/shared/channels'
import type { ChannelNotifyToggles } from '@zumibot/shared/notify'
import type { AgentSummary } from '@zumibot/shared/types'

const NOTIFY_ROWS: [keyof ChannelNotifyToggles, string, string][] = [
  ['waiting', 'Needs you', 'An approval, a question or a plan waits for you.'],
  ['replied', 'Replied', 'An agent finished a reply.'],
  ['error', 'Errors', "An agent's reply ended with an error."],
  ['routineFailed', 'Routine or workflow failed', 'A run failed on its own (not one you stopped).'],
  ['workflow', 'Workflow messages', "A workflow's Notify step: its title only; the message stays in the Inbox."]
]
import { api } from '../api'
import { errorMessage } from '../errors'
import { channelAgents, channelTid, pairLine, stateLine, toggleAgent } from '../state/channels'
import { isNotConnected } from '../state/resync'
import { useConnected } from '../useConnected'

/**
 * Telegram and Slack: each one's tokens (sent once, never shown again), where its bot runs, pairing, which agents may be
 * used from it, and (Slack) whether cards show in shared channels. Every agent starts off.
 */
export function ChannelsSettings({ agents }: { agents: AgentSummary[] }) {
  const [list, setList] = useState<ChannelStatus[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Asked again on each reconnect (a change broadcast while the socket was down is missed); one cut off by a drop is not an error.
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    let live = true
    const load = () =>
      api.channels.status().then(
        (l) => {
          if (!live) return
          setList(l)
          setError(null)
        },
        (e) => live && !isNotConnected(e) && setError(errorMessage(e))
      )
    load()
    const off = api.channels.onChanged(load)
    return () => {
      live = false
      off()
    }
  }, [connected])

  const of = (p: ChannelPlatform) => list?.find((s) => s.platform === p) ?? null
  return (
    <div data-testid="settings-channels">
      <p className="set-intro">
        Chat with your agents from Telegram or Slack. Replies, file names, and the approvals, questions and plans of turns you start there
        go to that platform for the agents you turn on, where you can answer them (Allow once or Deny only; nothing is remembered from a
        channel). Tool calls, thinking and vault values never go. The server only calls out: nothing new is opened to the internet.
      </p>
      {error && (
        <p className="set-note bad" role="status">
          {error}
        </p>
      )}
      <PlatformSettings
        platform="telegram"
        status={of('telegram')}
        agents={agents}
        onStatus={(s) => setList((l) => (l ? l.map((x) => (x.platform === s.platform ? s : x)) : l))}
      />
      <PlatformSettings
        platform="slack"
        status={of('slack')}
        agents={agents}
        onStatus={(s) => setList((l) => (l ? l.map((x) => (x.platform === s.platform ? s : x)) : l))}
      />
    </div>
  )
}

function PlatformSettings({
  platform: p,
  status,
  agents,
  onStatus
}: {
  platform: ChannelPlatform
  status: ChannelStatus | null
  agents: AgentSummary[]
  onStatus: (s: ChannelStatus) => void
}) {
  const label = CHANNEL_LABELS[p]
  const tid = (name: string) => channelTid(p, name)
  const [token, setToken] = useState('')
  const [appToken, setAppToken] = useState('')
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(tick)
  }, [])
  // A code is shown only while the server still holds it open: pairing, a cancel or its expiry clears it.
  useEffect(() => {
    if (code && (status?.pairing === null || status?.paired)) setCode(null)
  }, [status, code])

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
  const slack = p === 'slack'
  const canSave = token.trim() !== '' && (!slack || appToken.trim() !== '')
  const saveToken = run(async () => {
    await api.channels.setToken(p, token.trim(), slack ? appToken.trim() : undefined)
    setToken('')
    setAppToken('')
    setNote({ ok: true, text: slack ? 'Tokens saved.' : 'Token saved.' })
  })
  const removeToken = run(async () => {
    await api.channels.removeToken(p)
    setNote({ ok: true, text: `${slack ? 'Tokens' : 'Token'} removed. The bot stopped.` })
  })
  const setRun = (on: boolean): void => {
    if (status) onStatus({ ...status, run: on })
    void run(() => api.channels.setRun(p, on))()
  }
  const setShared = (on: boolean): void => {
    if (status) onStatus({ ...status, sharedCards: on })
    void run(() => api.channels.setSharedCards(p, on))()
  }
  const pair = run(async () => {
    const c = await api.channels.pairStart(p)
    // Held open here too: the status refetch the start broadcasts may still be in flight.
    if (status) onStatus({ ...status, pairing: { expiresAt: c.expiresAt } })
    setCode(c)
  })
  const cancelPair = run(async () => {
    await api.channels.pairCancel(p)
    setCode(null)
  })
  const unpair = run(() => api.channels.unpair(p))
  const flipAgent = (name: string, checked: boolean): void => {
    if (!status) return
    const next = toggleAgent(status.agents, name, checked)
    onStatus({ ...status, agents: next })
    api.channels.setAgents(p, next).catch((e) => setNote({ ok: false, text: errorMessage(e) }))
  }

  const setNotify = (key: keyof ChannelNotifyToggles, on: boolean): void => {
    if (!status) return
    const next = { ...status.notify, [key]: on }
    onStatus({ ...status, notify: next })
    api.channels.setNotify(p, next).catch((e) => setNote({ ok: false, text: errorMessage(e) }))
  }

  const listed = channelAgents(agents)
  const field = (value: string, set: (v: string) => void, name: string, aria: string, placeholder: string) => (
    <input
      type="password"
      className="field"
      data-testid={tid(name)}
      aria-label={aria}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      maxLength={300}
      value={value}
      onChange={(e) => set(e.target.value)}
    />
  )
  return (
    <section data-testid={tid('section')}>
      <h2 className="set-group">
        {label} {slack ? 'app' : 'bot'}
      </h2>
      <div className="set-card">
        <div className="set-block">
          <p className="set-hint" data-testid={tid('state')}>
            {status === null ? '…' : stateLine(status)}
          </p>
          {slack && (
            <p className="set-hint">
              Make a Slack app with Socket Mode on, bot scopes <code>chat:write</code>, <code>im:history</code>,{' '}
              <code>channels:history</code>, <code>groups:history</code>, <code>files:read</code>, <code>files:write</code>,{' '}
              <code>users:read</code>, the bot events <code>message.im</code>, <code>message.channels</code>, <code>message.groups</code>,
              and Interactivity on. Paste its bot token and an app-level token with <code>connections:write</code>.
            </p>
          )}
          <form
            className="set-key"
            onSubmit={(e) => {
              e.preventDefault()
              if (canSave) void saveToken()
            }}
          >
            {field(
              token,
              setToken,
              'token',
              `${label} bot token`,
              status?.configured ? 'Paste a new token to replace it' : slack ? 'Bot token (xoxb-…)' : 'Bot token from @BotFather'
            )}
            {slack && field(appToken, setAppToken, 'app-token', 'Slack app-level token', 'App-level token (xapp-…)')}
            <button type="submit" className="btn primary" data-testid={tid('token-save')} disabled={busy || !canSave}>
              Save
            </button>
          </form>
          {status?.configured && (
            <div className="set-actions">
              <button type="button" className="btn small" data-testid={tid('token-remove')} disabled={busy} onClick={removeToken}>
                Remove {slack ? 'tokens' : 'token'}
              </button>
            </div>
          )}
          <p className="set-hint">
            {slack ? 'The tokens are' : 'The token is'} sealed with your vault key on this machine and never shown again.
          </p>
        </div>
        <label className="set-row">
          <span className="set-text">
            <span className="set-label">Run the bot here</span>
            <span className="set-hint">
              One machine at a time. After a sync this PC's copy is off, as routines are; the VPS keeps running it.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            data-testid={tid('run')}
            checked={status?.run === true}
            disabled={status === null || busy}
            onChange={(e) => setRun(e.target.checked)}
          />
        </label>
      </div>

      <h3 className="set-group">Your {label} account</h3>
      <div className="set-card">
        <div className="set-block" data-testid={tid('pairing')}>
          {status?.paired ? (
            <>
              <p className="set-hint" data-testid={tid('paired')}>
                Paired with {status.paired.name}. Messages from anyone else are ignored.
              </p>
              <div className="set-actions">
                <button type="button" className="btn small" data-testid={tid('unpair')} disabled={busy} onClick={unpair}>
                  Unpair
                </button>
              </div>
            </>
          ) : code ? (
            <>
              <p className="set-label" data-testid={tid('code')}>
                {pairLine(code.code, code.expiresAt, now)}
              </p>
              <p className="set-hint">
                Send this code to {status?.bot ? `@${status.bot}` : 'your bot'} in a {slack ? 'direct message in Slack' : 'Telegram chat'}.
                It works once.
              </p>
              <div className="set-actions">
                <button type="button" className="btn small" data-testid={tid('pair-cancel')} disabled={busy} onClick={cancelPair}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="set-hint">Not paired. The bot answers nobody until you pair your {label} account.</p>
              <div className="set-actions">
                <button
                  type="button"
                  className="btn small"
                  data-testid={tid('pair')}
                  disabled={busy || !status?.configured || !status.run}
                  onClick={pair}
                >
                  Pair my account
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {slack && (
        <>
          <h3 className="set-group">Shared channels</h3>
          <p className="set-hint set-intro">
            In a channel, the bot answers only when you mention it, and each thread is one chat. Everyone in that channel sees the thread:
            your messages, the agent's replies and the file names. Messages from other people are never read or passed to the agent.
            Commands start with {COMMAND_PREFIX.slack} in Slack, since Slack keeps / for its own.
          </p>
          <div className="set-card">
            <label className="set-row">
              <span className="set-text">
                <span className="set-label">Show approval, question and plan cards in channels</span>
                <span className="set-hint">
                  Off: the thread gets a link to the card in ZumiBot instead. On: the card, with what the agent wants to run, is visible to
                  everyone there; only you can press its buttons. Direct messages always show cards.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                data-testid={tid('shared-cards')}
                checked={status?.sharedCards === true}
                disabled={status === null || busy}
                onChange={(e) => setShared(e.target.checked)}
              />
            </label>
          </div>
        </>
      )}

      <h3 className="set-group">Notifications in {label}</h3>
      <p className="set-hint set-intro">
        Also tell your paired {label} chat, the way a push does: the chat's title and what happened, never what was said. Not while you have
        the chat open in ZumiBot, and never about a reply that already went to {label}. All off until you turn one on.
      </p>
      <div className="set-card" data-testid={tid('notify')}>
        {NOTIFY_ROWS.map(([key, name, hint]) => (
          <label key={key} className="set-row">
            <span className="set-text">
              <span className="set-label">{name}</span>
              <span className="set-hint">{hint}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              data-testid={tid(`notify-${key}`)}
              checked={status?.notify[key] === true}
              disabled={status === null || !status.paired}
              onChange={(e) => setNotify(key, e.target.checked)}
            />
          </label>
        ))}
      </div>

      <h3 className="set-group">Agents you can use from {label}</h3>
      <p className="set-hint set-intro">
        All off until you turn one on. A room works when every member is on. Zumi Bot is never available from a channel.
      </p>
      <div className="set-card" data-testid={tid('agents')}>
        {listed.map((a) => (
          <label key={a.name} className="set-row">
            <span className="set-text">
              <span className="set-label">{displayName(a.name)}</span>
              {a.remoteHost && <span className="set-hint">Remote agent: its turns already run on {a.remoteHost}.</span>}
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              data-testid={tid(`agent-${a.name}`)}
              checked={status?.agents.includes(a.name) === true}
              disabled={status === null}
              onChange={(e) => flipAgent(a.name, e.target.checked)}
            />
          </label>
        ))}
        {listed.length === 0 && <p className="set-block set-hint">No agents yet.</p>}
      </div>
      {note && (
        <p className={note.ok ? 'set-note' : 'set-note bad'} role="status" data-testid={tid('note')}>
          {note.text}
        </p>
      )}
    </section>
  )
}
