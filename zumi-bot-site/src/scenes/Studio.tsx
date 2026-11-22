import { useState } from 'react'
import type { BotShape } from '@zumibot/shared/frontmatter'
import { Bot, SHAPES } from '../Bot.tsx'
import { Glyph } from '../Glyph.tsx'
import { AGENT_COLORS, shapeLabel, type AgentColor } from '../showcase.ts'

const CONTEXT = [
  { size: 'Default', note: 'Near full', on: true },
  { size: '200K', note: 'Cheapest' },
  { size: '300K', note: 'Lean' },
  { size: '400K', note: 'Balanced' },
  { size: '600K', note: 'Longest' }
]

const SERVERS = [
  { name: 'plugin:playwright', state: 'Connected', tools: '25 tools', on: true },
  { name: 'github', state: 'Connected', tools: '41 tools', on: true },
  { name: 'notion', state: 'Needs sign-in', tools: 'No tools', on: false }
]

const CONNECTORS = ['Gmail', 'Google Calendar', 'Google Drive', 'Notion', 'GitHub', 'Slack', 'Linear']

/** The app's Icon & color card, working: pick a shape and a color, and preview it working. */
function IconCard() {
  const [shape, setShape] = useState<BotShape>('robot')
  const [color, setColor] = useState<AgentColor>('purple')
  const [working, setWorking] = useState(true)
  return (
    <div className="card">
      <div className="cardhead">
        <span className="tile">
          <Glyph name="palette" />
        </span>
        <h3>Icon &amp; color</h3>
      </div>
      <div className="avatar">
        <div className="avatar-tile">
          <Bot shape={shape} color={color} size={64} working={working} tilt="b" />
        </div>
        <div className="avatar-text">
          <p className="strong">
            {shapeLabel(shape)} ({shapeLabel(color)})
          </p>
          <p className="muted small">How this agent looks in the sidebar and chats.</p>
          <button type="button" className="btn tall" aria-pressed={working} onClick={() => setWorking((w) => !w)}>
            {working ? 'Working · click to idle' : 'Idle · click to work'}
          </button>
        </div>
      </div>
      <div className="lbl-row">
        <p className="lbl" id="shape-lbl">
          Shape
        </p>
        <span className="muted small">{shapeLabel(shape)}</span>
      </div>
      <div className="shapes" role="group" aria-labelledby="shape-lbl">
        {SHAPES.map((s) => (
          <button
            key={s}
            type="button"
            className="shape"
            aria-label={shapeLabel(s)}
            title={shapeLabel(s)}
            aria-pressed={s === shape}
            onClick={() => setShape(s)}
          >
            <Bot shape={s} color={color} size={24} />
          </button>
        ))}
      </div>
      <div className="lbl-row">
        <p className="lbl" id="color-lbl">
          Color
        </p>
        <span className="muted small">{shapeLabel(color)}</span>
      </div>
      <div className="swatches" role="group" aria-labelledby="color-lbl">
        {AGENT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`swatch c-${c}`}
            aria-label={shapeLabel(c)}
            title={shapeLabel(c)}
            aria-pressed={c === color}
            onClick={() => setColor(c)}
          >
            <span />
          </button>
        ))}
      </div>
    </div>
  )
}

export function StudioScene({ cls }: { cls: string }) {
  return (
    <section id="studio" data-scene="studio" className={`scene ${cls}`}>
      <div className="wrap stack-md">
        <div className="split end">
          <div className="txt wide">
            <p className="lbl">03 · Agent Studio</p>
            <h2 className="h2">Every agent gets a face, a brain and a loadout.</h2>
          </div>
          <div className="txt">
            <p className="lede">
              Pick the shape, the color, the engine and how much context it keeps. Then write its instructions and choose what it loads:
              servers, plugins, skills, hooks and connectors. Try the shape and color here.
            </p>
          </div>
        </div>
        <div className="cols">
          <div className="col studio-left">
            <IconCard />
            <div className="card">
              <div className="cardhead">
                <span className="tile">
                  <Glyph name="engine" />
                </span>
                <h3>Model engine</h3>
              </div>
              <div className="field between">
                Claude
                <Glyph name="chevron" size={12} weight={2} />
              </div>
              <div className="row wrap-row small">
                <span className="chip sel">Claude</span>
                <span className="chip">Codex</span>
                <span className="chip">ACP agent</span>
                <span className="chip">Remote agent (AG-UI)</span>
              </div>
              <div className="ctx">
                {CONTEXT.map((c) => (
                  <span key={c.size} className={c.on ? 'on' : undefined}>
                    {c.on ? <b>{c.size}</b> : c.size}
                    <br />
                    <span className="note">{c.note}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="col studio-right">
            <div className="win">
              <div className="winbar">
                <div className="lights">
                  <span />
                  <span />
                  <span />
                </div>
                <span className="mono">wordsmith.md</span>
                <span className="push">Markdown</span>
              </div>
              <div className="editor mono">
                <span className="muted gutter">
                  1<br />2<br />3<br />4<br />5<br />6<br />7<br />8<br />9
                </span>
                <span className="src">
                  <span className="k"># Wordsmith</span>
                  {'\n\nYou write and fix UI text for Tidepool.\nEnglish is the source; French and Spanish follow it.\n\n'}
                  <span className="k">## Rules</span>
                  {'\n- Same key in all three files, same place.\n- Keep placeholders like '}
                  <span className="s">{'{count}'}</span>
                  {' untouched.\n- Ask before renaming a key that is still used.'}
                </span>
              </div>
            </div>
            <div className="card">
              <div className="row wrap-row baseline">
                <h3>What this agent loads</h3>
                <span className="muted mono small">~/code/tidepool</span>
              </div>
              <p className="small">
                <b>12 servers · 5 connected · 96 tools · 14 skills on</b> <span className="muted">(~2,300 tokens)</span>
              </p>
              <div className="servers">
                {SERVERS.map((s) => (
                  <div key={s.name} className={s.on ? 'server' : 'server warn'}>
                    <span className="dot" />
                    <b className="mono">{s.name}</b>
                    <span className="state">{s.state}</span>
                    <span className="muted">{s.tools}</span>
                    <span className={s.on ? 'toggle' : 'toggle off'} />
                  </div>
                ))}
              </div>
              <p className="lbl">Connectors · one click</p>
              <div className="row wrap-row">
                {CONNECTORS.map((c) => (
                  <span key={c} className={c === 'GitHub' ? 'chip sel' : 'chip'}>
                    {c}
                  </span>
                ))}
              </div>
              <p className="muted small">
                Agents keep their own memory, ask other agents mid-turn, list dispatched subagents live, and keep dev servers and watchers
                running after a turn ends.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
