import { useState } from 'react'
import type { AcpLaunch } from '@zumibot/shared/acp'
import type { CodexInfo } from '@zumibot/shared/engine'
import { COLOR_OPTIONS, ICON_OPTIONS, MODEL_OPTIONS, validateFields, type AgentFields } from '@zumibot/shared/frontmatter'
import { isCustomIcon, shapeOf, shapeSelected } from '../state/bot'
import {
  CODEX_UNUSED_NOTE,
  codexModelChoices,
  codexVaultNote,
  dailyCapAfterEngineSwitch,
  dailyCapBlocked,
  engineChoices,
  engineOfFields,
  modelAfterEngineSwitch,
  usesCodex
} from '../state/agentEngine'
import { confirmedAcp, studioCards, type ProtocolLaunch } from '../state/acpCard'
import { confirmedAgui } from '../state/aguiCard'
import { AcpCard, type SavedAcp } from './AcpCard'
import { AguiCard, type SavedAgui } from './AguiCard'
import { compactChoices } from '../state/contextMeter'
import { BotIcon } from './BotIcon'
import { CommandsCard } from './CommandsCard'
import { EditorIcon, type EditorIconName } from './EditorIcon'
import { PromptCard } from './PromptCard'
import { CapBlocked, SpendCapInput } from './SpendCapInput'
import { ToolsPicker } from './ToolsPicker'
import { pickedTools, visibleTools } from '../state/toolsPicker'
import { SearchSelect } from './SearchSelect'
import { recallChoices } from '../state/recallCard'

interface Props {
  fields: AgentFields
  body: string
  onFields: (patch: Partial<AgentFields>) => void
  onBody: (body: string) => void
  /** What the Codex CLI offers on this machine; decides whether the Codex engine can be picked. */
  codexInfo: CodexInfo
  /** False when the file's `acp:` did not parse (`ParsedAgent.acpEditable`). */
  acpEditable: boolean
  /** The saved file's name and launch, for the ACP card's Test and Vault grants; null for a new agent. */
  savedAcp: SavedAcp | null
  /** False when the file's `agui:` did not parse (`ParsedAgent.aguiEditable`). */
  aguiEditable: boolean
  /** The saved file's name and endpoint, for the remote card's Test and Vault grants; null for a new agent. */
  savedAgui: SavedAgui | null
  /** The launch (ACP's or a remote agent's, by the form's engine) confirmed on this machine; undefined while unknown. */
  confirmedLaunch: ProtocolLaunch | null | undefined
  /** The remote card's problem with the draft it holds, for the editor's error list (`saveErrors`). */
  onAguiDraftError?: (error: string | null) => void
}

const label = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const MODEL_HINTS: Record<(typeof MODEL_OPTIONS)[number], string> = {
  inherit: 'Default',
  opus: 'Complex',
  sonnet: 'Recommended',
  haiku: 'Fast'
}

function CardHead({ id, icon, title, meta }: { id: string; icon: EditorIconName; title: string; meta?: string }) {
  return (
    <header className="card-head">
      <EditorIcon name={icon} />
      <h3 className="card-title" id={id}>
        {title}
      </h3>
      {meta && <span className="card-meta">{meta}</span>}
    </header>
  )
}

export function AgentForm({
  fields,
  body,
  onFields,
  onBody,
  codexInfo,
  acpEditable,
  savedAcp,
  aguiEditable,
  savedAgui,
  confirmedLaunch,
  onAguiDraftError
}: Props) {
  // Validation messages stay hidden until the user has edited that field, so a legacy file opens without red text.
  const [touched, setTouched] = useState({ name: false, description: false })
  // An empty name cannot be written to the frontmatter, so it lives here until the user types something.
  const [emptyName, setEmptyName] = useState(false)
  const [picking, setPicking] = useState(false)
  // Preview only; never written to the file.
  const [previewWorking, setPreviewWorking] = useState(false)

  const errors = validateFields(emptyName ? { ...fields, name: '' } : fields, acpEditable, aguiEditable)
  const nameError = touched.name ? errors.find((e) => e.startsWith('Name')) : undefined
  const descriptionError = touched.description ? errors.find((e) => e.startsWith('Description')) : undefined

  const inheritModel = fields.model === null || fields.model === 'inherit'
  const customModel = !inheritModel && !(MODEL_OPTIONS as readonly string[]).includes(fields.model ?? '')
  const specificTools = fields.tools !== null || picking
  const engine = engineOfFields(fields)
  const cards = studioCards(engine)
  const codex = usesCodex(fields)
  const engines = engineChoices(fields.provider, codexInfo)
  const codexModels = codexModelChoices(fields.model, codexInfo)
  const colorName = fields.color ? label(fields.color) : 'None'
  const botName = isCustomIcon(fields.icon) ? `Custom: ${fields.icon}` : label(shapeOf(fields.icon))

  return (
    <div className="editor-body">
      <div className="editor-grid">
        <div className="editor-col">
          <section className="card" aria-labelledby="card-identity">
            <CardHead id="card-identity" icon="idcard" title="Identity & scope" />
            <div className="form-field">
              <label className="lbl" htmlFor="agent-name">
                Agent name
              </label>
              <input
                id="agent-name"
                className="field mono"
                spellCheck={false}
                value={emptyName ? '' : fields.name}
                aria-invalid={nameError !== undefined}
                onChange={(e) => {
                  setTouched((t) => ({ ...t, name: true }))
                  setEmptyName(e.target.value === '')
                  if (e.target.value !== '') onFields({ name: e.target.value })
                }}
                onBlur={() => setEmptyName(false)}
              />
              {nameError && <div className="field-error">{nameError}</div>}
              <div className="hint mono">
                <EditorIcon name="file" />
                ~/.claude/agents/{fields.name}.md
              </div>
            </div>
            <div className="form-field">
              <label className="lbl" htmlFor="agent-description">
                Description
              </label>
              <textarea
                id="agent-description"
                className="field"
                rows={4}
                value={fields.description}
                aria-invalid={descriptionError !== undefined}
                onChange={(e) => {
                  setTouched((t) => ({ ...t, description: true }))
                  onFields({ description: e.target.value })
                }}
              />
              {descriptionError && <div className="field-error">{descriptionError}</div>}
              <div className="hint">
                <EditorIcon name="info" />
                Tells Claude when to auto-invoke or delegate to this agent.
              </div>
            </div>
          </section>

          <section className="card" aria-labelledby="card-model">
            <CardHead id="card-model" icon="chip" title="Engine & model" />
            <div className="form-field">
              <label className="lbl" htmlFor="agent-engine">
                Engine
              </label>
              <SearchSelect
                id="agent-engine"
                className="field"
                data-testid="agent-engine"
                value={engineOfFields(fields)}
                onChange={(v) => {
                  const to = engines.find((c) => c.value === v) ?? engines[0]
                  // One edit: the engine, the model it can keep (so no model of the other engine stays behind) and the daily cap it can hold.
                  onFields({
                    provider: to.provider,
                    model: modelAfterEngineSwitch(fields.model, to.value, codexInfo.models),
                    dailySpendCap: dailyCapAfterEngineSwitch(fields.dailySpendCap, to.value)
                  })
                }}
              >
                {engines.map((c) => (
                  <option key={c.value} value={c.value} disabled={c.disabled} data-tip={c.title}>
                    {c.label}
                  </option>
                ))}
              </SearchSelect>
              {engines.some((c) => c.title !== undefined) && (
                <div className="hint">{engines.find((c) => c.title !== undefined)?.title}</div>
              )}
              {codexVaultNote(fields.provider) && (
                <div className="hint" data-testid="codex-vault-note">
                  {codexVaultNote(fields.provider)}
                </div>
              )}
            </div>
            {cards.models && engine === 'codex' && (
              <div className="choices models" role="group" aria-labelledby="card-model" data-testid="codex-models">
                {codexModels.choices.map((c) => (
                  <button
                    key={c.value ?? 'default'}
                    type="button"
                    className="choice"
                    aria-pressed={c.active}
                    onClick={() => !c.active && onFields({ model: c.value })}
                  >
                    {c.label}
                  </button>
                ))}
                <input
                  className="field mono choice wide"
                  aria-label="Custom model"
                  placeholder="Custom model"
                  spellCheck={false}
                  data-testid="codex-model-custom"
                  value={codexModels.custom ?? ''}
                  onChange={(e) => onFields({ model: e.target.value.trim() === '' ? null : e.target.value.trim() })}
                />
              </div>
            )}
            {cards.models && engine === 'claude' && (
              <div className="choices models" role="group" aria-labelledby="card-model">
                {MODEL_OPTIONS.map((m) => {
                  const active = m === 'inherit' ? inheritModel : fields.model === m
                  return (
                    <button
                      key={m}
                      type="button"
                      className="choice"
                      aria-pressed={active}
                      // Inherit is the absence of the key; leave an explicit `model: inherit` alone when it is already active.
                      onClick={() => !active && onFields({ model: m === 'inherit' ? null : m })}
                    >
                      {label(m)}
                      <span className="choice-sub" aria-hidden="true">
                        {MODEL_HINTS[m]}
                      </span>
                    </button>
                  )
                })}
                {customModel && (
                  <button type="button" className="choice wide" aria-pressed="true" disabled data-tip="Set in the raw file">
                    Custom: {fields.model}
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Picking ACP in the Engine select shows its card at once; Save refuses it until it has a command. */}
          {cards.acp && (
            <AcpCard
              fields={fields}
              onFields={onFields}
              acpEditable={acpEditable}
              saved={savedAcp}
              confirmed={confirmedAcp(confirmedLaunch)}
            />
          )}
          {cards.agui && (
            <AguiCard
              fields={fields}
              onFields={onFields}
              aguiEditable={aguiEditable}
              saved={savedAgui}
              confirmed={confirmedAgui(confirmedLaunch)}
              onDraftError={onAguiDraftError}
            />
          )}

          {cards.compact && (
            <section className="card" aria-labelledby="card-compact">
              <CardHead id="card-compact" icon="sliders" title="Compact at" meta="Context size" />
              <div className="choices compact-sizes" role="group" aria-labelledby="card-compact">
                {compactChoices(fields.autoCompactWindow).map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    className={c.hint ? 'choice' : 'choice wide'}
                    aria-pressed={c.active}
                    data-testid="compact-choice"
                    // A size set by hand in the file stays as it is; Default removes the key.
                    disabled={c.label.startsWith('Custom')}
                    data-tip={c.label.startsWith('Custom') ? 'Set in the raw file' : undefined}
                    onClick={() => !c.active && onFields({ autoCompactWindow: c.value })}
                  >
                    {c.label}
                    {c.hint && (
                      <span className="choice-sub" aria-hidden="true">
                        {c.hint}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <p className="card-note">
                The agent summarizes its conversation once it reaches this size. Lower uses fewer tokens on every message; older details are
                kept only as a summary.
              </p>
            </section>
          )}

          {cards.recall && (
            <section className="card" aria-labelledby="card-recall">
              <CardHead id="card-recall" icon="list" title="Recall" meta="Past chats" />
              <div className="choices compact-sizes" role="group" aria-labelledby="card-recall">
                {recallChoices(fields.recall).map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    className="choice"
                    aria-pressed={c.active}
                    data-testid="recall-choice"
                    onClick={() => !c.active && onFields({ recall: c.value })}
                  >
                    {c.label}
                    <span className="choice-sub" aria-hidden="true">
                      {c.hint}
                    </span>
                  </button>
                ))}
              </div>
              <p className="card-note">
                Lets the agent search and read earlier chats, never change them: its own chats and rooms, or every chat in the folder it
                works in, whatever agent it was with. It never sees the chat it is in through these tools.
              </p>
            </section>
          )}

          {cards.dailyCap && (
            <section className="card" aria-labelledby="card-spend">
              <CardHead id="card-spend" icon="sliders" title="Daily spend cap" meta="USD a day" />
              <div className="form-field">
                <SpendCapInput
                  id="agent-daily-cap"
                  value={fields.dailySpendCap}
                  onChange={(v) => onFields({ dailySpendCap: v })}
                  testId="agent-daily-cap"
                />
              </div>
              <p className="card-note">
                Once the agent has spent this much today, priced at API rates, its running replies pause and its routines and workflow steps
                wait until you allow more. Empty means no cap.
              </p>
            </section>
          )}

          {dailyCapBlocked(engine, fields.name, fields.dailySpendCap) !== null && (
            // A cap the file already holds (a hand edit, a sync) on an engine that can't hold one: removable here, or a save is refused.
            <section className="card" aria-labelledby="card-spend">
              <CardHead id="card-spend" icon="sliders" title="Daily spend cap" />
              <div className="form-field">
                <CapBlocked
                  reason={dailyCapBlocked(engine, fields.name, fields.dailySpendCap) ?? ''}
                  hasCap
                  onClear={() => onFields({ dailySpendCap: null })}
                  testId="agent-daily-cap-blocked"
                />
              </div>
            </section>
          )}

          <section className="card" aria-labelledby="card-avatar">
            <CardHead id="card-avatar" icon="palette" title="Icon & color" />
            <div className="avatar-preview">
              <div className="avatar-tile">
                <BotIcon icon={fields.icon} color={fields.color} working={previewWorking} size={40} />
                <button
                  type="button"
                  className="state-badge"
                  aria-pressed={previewWorking}
                  data-tip="Preview the working animation"
                  onClick={() => setPreviewWorking((w) => !w)}
                >
                  {previewWorking ? 'Working' : 'Idle'}
                </button>
              </div>
              <div className="avatar-text">
                <div className="avatar-name">
                  {botName} ({colorName})
                </div>
                <div className="avatar-desc">How this agent looks in the sidebar and chats. Click the badge to preview it working.</div>
              </div>
            </div>

            <div className="form-field">
              <div className="lbl-row">
                <div className="lbl" id="agent-icon-label">
                  Shape
                </div>
                <span className="lbl-value">{botName}</span>
              </div>
              <div className="choices shapes" role="group" aria-labelledby="agent-icon-label">
                {ICON_OPTIONS.map((shape) => (
                  <button
                    key={shape}
                    type="button"
                    className="choice"
                    aria-label={label(shape)}
                    data-tip={label(shape)}
                    aria-pressed={shapeSelected(fields.icon, shape)}
                    onClick={() => !shapeSelected(fields.icon, shape) && onFields({ icon: shape })}
                  >
                    <BotIcon icon={shape} color={fields.color} working={false} size={26} />
                  </button>
                ))}
                {isCustomIcon(fields.icon) && (
                  <button type="button" className="choice wide" aria-pressed="true" disabled data-tip="Set in the raw file">
                    Custom: {fields.icon}
                  </button>
                )}
              </div>
            </div>

            <div className="form-field">
              <div className="lbl-row">
                <div className="lbl" id="agent-color-label">
                  Color
                </div>
                <span className="lbl-value">{colorName}</span>
              </div>
              <div className="swatches" role="group" aria-labelledby="agent-color-label">
                {COLOR_OPTIONS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="swatch"
                    style={{ background: `var(--agent-${c})`, color: `var(--agent-${c})` }}
                    aria-label={c}
                    aria-pressed={fields.color === c}
                    data-tip={c}
                    onClick={() => onFields({ color: fields.color === c ? null : c })}
                  />
                ))}
              </div>
            </div>
          </section>

          {codex && (
            <section className="card" aria-label="Not used by Codex agents">
              <p className="card-note" data-testid="codex-unused-note">
                {CODEX_UNUSED_NOTE}
              </p>
            </section>
          )}

          {cards.tools && (
            <section className="card" aria-labelledby="card-tools">
              <CardHead
                id="card-tools"
                icon="tools"
                title="Tools"
                meta={fields.tools === null ? 'Inherited' : `${visibleTools(fields.tools).length} selected`}
              />
              <div className="choices tool-modes" role="group" aria-labelledby="card-tools">
                <button
                  type="button"
                  className="choice inline"
                  aria-pressed={!specificTools}
                  onClick={() => {
                    setPicking(false)
                    onFields({ tools: null })
                  }}
                >
                  <EditorIcon name="shield" />
                  All tools (inherit)
                </button>
                <button type="button" className="choice inline" aria-pressed={specificTools} onClick={() => setPicking(true)}>
                  <EditorIcon name="list" />
                  Pick specific…
                </button>
              </div>
              {specificTools && (
                <ToolsPicker
                  value={visibleTools(fields.tools ?? [])}
                  onChange={(tools) => {
                    // Emptying the list writes no key (all tools); keep the picker open so the click doesn't look undone.
                    // The hidden to-do tools ride along; the server adds them when a list is saved.
                    setPicking(true)
                    onFields({ tools: pickedTools(fields.tools ?? [], tools) })
                  }}
                />
              )}
            </section>
          )}

          <CommandsCard
            claudeModels={engine === 'claude'}
            commands={fields.commands ?? []}
            // Emptying the list removes the key, like the tools picker does.
            onChange={(next) => onFields({ commands: next.length > 0 ? next : null })}
          />
        </div>

        <PromptCard fileName={`${fields.name}.md`} body={body} onBody={onBody} note={cards.instructionsNote} />
      </div>
    </div>
  )
}
