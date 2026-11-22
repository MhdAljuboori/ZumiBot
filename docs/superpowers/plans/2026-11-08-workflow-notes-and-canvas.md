# Workflow Sticky Notes, Canvas Groups and n8n Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The workflow editor gets n8n's canvas controls (mouse, keys, toolbar, right-click menu, undo/redo, clipboard), then n8n-style sticky notes, then n8n-style canvas groups.

**Architecture:** Every rule is a pure function in `shared/src/` or `frontend/src/state/`, tested with vitest. The React components (`WorkflowCanvas.tsx`, `WorkflowEditor.tsx`, new node components) only wire those rules to React Flow 12. Notes and groups are optional fields on `Workflow` and on the run snapshot. They are validated by `parseWorkflowInput` (moved to `shared` so the clipboard can reuse it), and the engine never reads them.

**Tech Stack:** TypeScript, React 19, `@xyflow/react` 12.12.0, vitest (projects `shared`, `frontend`, `backend`), e2e with `playwright-core` and the fake workflow claude.

**Spec:** `docs/superpowers/specs/2026-11-08-workflow-notes-and-canvas-design.md` (read it with this plan; section names below refer to it).

## Global Constraints

- **No commits.** The user commits only on explicit request (`~/.claude/CLAUDE.md`). Each task ends with a checkpoint (tests and typecheck), not a commit.
- Run everything from the repo root. Node >= 22.
- One test file: `npx vitest run <path>`. One project: `npx vitest run --project frontend`. Types: `npm run typecheck`.
- The e2e suite builds first: `npm run e2e:workflows` (fake claude, no quota).
- The CSP in `backend/src/http/headers.ts` stays unchanged.
- Comments are short and say *why*, in the repo's style. Dependencies stay as they are: no new packages.
- Notes and groups never reach the engine, `problemsOf`, templates, prompts, the Inbox or notifications.
- No canvas key fires while `isTypingTarget(document.activeElement)` is true. The one exception is Ctrl/Cmd+S (save).
- Values from the spec: grid 20 px; zoom 0.1–4; `NOTE_TEXT_MAX` 10 000; `NOTES_MAX` 100; `NOTE_MIN` 150×80; `NOTE_MAX_SIDE` 5 000; `NOTE_DEFAULT` 240×160, color 1, text `'## Note\nDouble-click to edit.'`; `GROUP_NAME_MAX` 100; `GROUP_DESCRIPTION_MAX` 145; `GROUPS_MAX` 50; history 100 entries, coalesce 1 000 ms; paste/duplicate offset 40 px; group padding 24 px, header 36 px; push gap 40 px; recent custom colors 8.
- Preset colors in order 1–7: yellow, orange, red, purple, blue, green, gray.
- `localStorage` keys `cb.wf.collapsed.<workflowId>` and `cb.wf.noteColors`, always read and written inside try/catch.

**One deviation from the spec's type sketch, decided here:** `WorkflowInput.notes` and `WorkflowInput.groups` are *optional* in the type (`Pick<Workflow, … | 'notes' | 'groups'>`), and every reader goes through `notesOf`/`groupsOf`. The behavior is the same, since the editor and `parseWorkflowInput` always produce both arrays. It saves editing every test fixture that builds a `WorkflowInput`.

**A second decision the spec left open:** the right-click menu's **Paste** pastes the last clip copied *in this tab* (`lastClip`, module state). Reading the system clipboard from a menu would need the permission prompt the spec rules out. Ctrl/Cmd+V always reads the system clipboard through the `paste` event. When no clip was copied in this tab, Paste is disabled with the reason "Copy something first, or press Ctrl+V".

## Review Focus

1. **Typing never triggers canvas keys.** A user typing in a note's textarea, a group's inline name or description, or any inspector field expects letters, digits, Delete, Backspace, arrows, Shift+S, N, H, Ctrl+Z and Ctrl+D to act on the text only. This is pinned in Task 1 (`canvasKey` with `typing: true` returns null for every key but save) and in Task 11 (e2e: typing "N1+" in a note adds no step and keeps the zoom).
2. **Ctrl+click still multi-selects while Ctrl also pans.** A user Ctrl+clicking a step expects it toggled in the selection, not a pan or a move. Pinned in Task 7's e2e.
3. **A foreign paste changes nothing, and a field's own paste is untouched.** Pasting plain text on the canvas must not alter the workflow. Pasting into an inspector field must paste the text into the field. Pinned in Task 3 (`parseClip` garbage cases) and Task 7 (e2e: paste text into the prompt field, check its value and the step count).
4. **Old workflows and runs open clean.** A workflow saved before notes and groups must open with no "Unsaved" pill and save unchanged. A run stored before them must show its canvas. Pinned in Task 8 (`toInput` of a workflow without `notes` equals `newWorkflow`-style empty arrays; the editor's `dirty` is false) and Task 12 (the same for `groups`).
5. **Deleting a member of a collapsed group leaves no orphan.** A user who deletes a step from a collapsed group (Delete, the inspector, cut, undo of an add) expects the group to shrink, or to vanish below two members or with no step left. Pinned in Task 13 (`removeItems` prunes, and drops groups that fall below rule 1).

---

## File Structure

**Shared** (`zumi-bot-server/shared/src/`)
- `workflows.ts` (modify): `Note`, `NoteColor`, `CanvasGroup`, optional `notes`/`groups` on `Workflow`, `WorkflowInput` and the run snapshot, `notesOf`, `groupsOf` and the constants.
- `workflowInput.ts` (create, moved from the backend): `parseWorkflowInput` plus the exported pieces `parseStep`, `parseEdges`, `parseNote`, `parseGroup`, and `INVALID_WORKFLOW`, `validId`, `HANDLE_RE`, `NAME_MAX`, `SAVED_TEXT_MAX`, `FILTER_TEXT_MAX`.
- `workflowGroups.ts` (create): the group rules, `groupEnds`, `brokenGroups`, `dropBrokenGroups`, `GROUP_RULE_TEXT`.

**Backend** (`zumi-bot-server/backend/src/`)
- `core/workflows/workflowInput.ts` (modify): becomes `export * from '@zumibot/shared/workflowInput'`, so existing imports keep working.
- `rpc/handlers.ts` (modify): `workflows:save` stores `notes` and `groups` and drops broken groups.
- `core/workflows/workflowRunner.ts` (modify): the snapshot copies `notes` and `groups`.

**Frontend pure modules** (`zumi-bot-server/frontend/src/state/`)
- `workflowEditor.ts` (modify): the new `Selection`, `picked`, `itemsSelection`, `applySelect`, `pruneSelection`, `sameSelection`, and `toInput` with notes and groups. `keyAction` moves out.
- `workflowKeys.ts` (create): `canvasKey`.
- `workflowHistory.ts` (create): undo and redo.
- `workflowClipboard.ts` (create): `copyClip`, `clipText`, `parseClip`, `pasteClip`, `lastClip`/`setLastClip`.
- `workflowNav.ts` (create): arrow navigation.
- `workflowMenu.ts` (create): right-click menu items.
- `workflowNotes.ts` (create): note edits, `noteInk`, recent custom colors.
- `workflowGroupEdit.ts` (create): group edits, the derived box, the collapsed view, `expandPush`, collapse storage.
- `workflowCanvas.ts` (modify): `moveItems` (replacing `moveSteps`), `removeItems` (replacing `removeSteps`), `toFlow` emitting note and group nodes, `snap`, and an exported `rewriteHandles`.
- `workflowRun.ts` (modify): `groupRunState`.

**Frontend components** (`zumi-bot-server/frontend/src/components/`)
- `WorkflowCanvas.tsx` (modify): React Flow props, toolbar, `CanvasCommands` handle, node types, and context menu events.
- `WorkflowEditor.tsx` (modify): the key handler on `canvasKey`, history, clipboard events, notices, inspectors.
- `WorkflowPanels.tsx` (modify): `SelectionInspector` (replacing `GroupInspector`) and `CanvasGroupInspector`.
- `WorkflowNotes.tsx` (create): `NoteNode` and `NoteColorPopover`.
- `WorkflowGroups.tsx` (create): `GroupBoxNode` and `CollapsedGroupNode`.
- `WorkflowMenu.tsx` (create): `CanvasContextMenu`.
- `WorkflowRunView.tsx` (modify): notes and groups from the snapshot.
- `Markdown.tsx` (modify): an `images={false}` prop.
- `StepInspector.tsx` (modify): coalescing keys on text edits, and `focusField` for F2 and Enter.
- `styles.css` (modify): note tokens and classes for notes, groups, the toolbar and the menu.

**Tests**
- `shared/tests/workflowInput.test.ts` (create), `shared/tests/workflowGroups.test.ts` (create).
- `backend/tests/rpc/handlers.test.ts` (modify), `backend/tests/core/workflowRunner.test.ts` (modify).
- `frontend/tests/workflowEditor.test.ts` (modify), `workflowCanvas.test.ts` (modify).
- `frontend/tests/workflowKeys.test.ts`, `workflowHistory.test.ts`, `workflowClipboard.test.ts`, `workflowNav.test.ts`, `workflowMenu.test.ts`, `workflowNotes.test.ts`, `workflowGroupEdit.test.ts` (create).
- `e2e/workflows.e2e.mjs` (modify): case 15 updated, new cases 16–18.

---

# Part 1 — Canvas controls (steps only)

### Task 1: Selection of many kinds, and the canvas key map

**Files:**
- Modify: `frontend/src/state/workflowEditor.ts` (the `Selection` type and helpers; remove `keyAction`, `selectedSteps`, `stepSelection`, `groupSteps`)
- Create: `frontend/src/state/workflowKeys.ts`
- Modify: `frontend/src/components/WorkflowEditor.tsx`, `WorkflowCanvas.tsx`, `WorkflowPanels.tsx` (callers; `GroupInspector` → `SelectionInspector`)
- Test: `frontend/tests/workflowEditor.test.ts` (rewrite the `step selection` and `keyAction` blocks), `frontend/tests/workflowKeys.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // workflowEditor.ts
  export type ItemKind = 'step' | 'note' | 'group'          // 'group' = a collapsed group node
  export type Selection =
    | { kind: 'step' | 'edge' | 'note' | 'group'; id: string }
    | { kind: 'items'; steps: string[]; notes: string[]; groups: string[] }
  export interface Picked { steps: string[]; notes: string[]; groups: string[] }
  export function picked(s: Selection | null): Picked                          // edge → all empty
  export function itemsSelection(p: Partial<Picked>): Selection | null         // 0 → null, 1 → single kind, else items
  export function applySelect(s: Selection | null, changes: { id: string; selected: boolean }[], kindOf: (id: string) => ItemKind | null): Selection | null
  export function sameSelection(a: Selection | null, b: Selection | null): boolean
  export function pruneSelection(s: Selection | null, w: WorkflowInput, collapsedGroups: Set<string>): Selection | null
  export const pickedCount = (p: Picked): number
  // workflowKeys.ts
  export type CanvasKey =
    | 'save' | 'selectAll' | 'delete' | 'clear' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'fit'
    | 'addNote' | 'addStep' | 'duplicate' | 'undo' | 'redo' | 'group' | 'ungroup' | 'expand' | 'collapse'
    | 'next' | 'prev' | 'up' | 'down' | 'allNext' | 'allPrev' | 'rename' | 'open' | 'panMode' | 'run'
  export interface KeyLike { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
  export function canvasKey(e: KeyLike, typing: boolean, hasSelection: boolean): CanvasKey | null
  ```
  `isTypingTarget` stays in `workflowEditor.ts`.

- [ ] **Step 1: Write the failing tests**

`workflowKeys.test.ts`, with a helper `k(key, mods = {}, code?)`:

```ts
it('saves on Ctrl+S or Cmd+S, even while typing', () => {
  expect(canvasKey(k('s', { ctrlKey: true }), true, false)).toBe('save')
  expect(canvasKey(k('S', { metaKey: true }), false, false)).toBe('save')
})
it('returns null for every other key while typing', () => {
  for (const e of [k('Delete'), k('Backspace'), k('n'), k('S', { shiftKey: true }), k('1'), k('+'), k('ArrowRight'),
    k('z', { ctrlKey: true }), k('d', { ctrlKey: true }), k('g', { ctrlKey: true }, 'KeyG'), k('F2'), k('Enter'), k('h'),
    k('a', { ctrlKey: true }), k('Enter', { ctrlKey: true })])
    expect(canvasKey(e, true, true), e.key).toBeNull()
})
it('maps the zoom keys', () => {
  expect(canvasKey(k('+'), false, false)).toBe('zoomIn'); expect(canvasKey(k('='), false, false)).toBe('zoomIn')
  expect(canvasKey(k('-'), false, false)).toBe('zoomOut'); expect(canvasKey(k('_'), false, false)).toBe('zoomOut')
  expect(canvasKey(k('0'), false, false)).toBe('zoomReset'); expect(canvasKey(k('1'), false, false)).toBe('fit')
})
it('maps adding, editing and history keys', () => {
  expect(canvasKey(k('S', { shiftKey: true }), false, false)).toBe('addNote')
  expect(canvasKey(k('n'), false, false)).toBe('addStep')
  expect(canvasKey(k('h'), false, false)).toBe('panMode')
  expect(canvasKey(k('d', { ctrlKey: true }), false, true)).toBe('duplicate')
  expect(canvasKey(k('z', { ctrlKey: true }), false, false)).toBe('undo')
  expect(canvasKey(k('Z', { ctrlKey: true, shiftKey: true }), false, false)).toBe('redo')
  expect(canvasKey(k('y', { metaKey: true }), false, false)).toBe('redo')
  expect(canvasKey(k('Enter', { ctrlKey: true }), false, false)).toBe('run')
})
it('maps the group keys by code, so Alt+G on a Mac (©) still works', () => {
  expect(canvasKey(k('g', { ctrlKey: true }, 'KeyG'), false, true)).toBe('group')
  expect(canvasKey(k('G', { ctrlKey: true, shiftKey: true }, 'KeyG'), false, true)).toBe('ungroup')
  expect(canvasKey(k('©', { altKey: true }, 'KeyG'), false, false)).toBe('expand')
  expect(canvasKey(k('˝', { altKey: true, shiftKey: true }, 'KeyG'), false, false)).toBe('collapse')
})
it('needs a selection for Delete, Esc, arrows, F2 and Enter', () => {
  for (const key of ['Delete', 'Backspace', 'Escape', 'F2', 'Enter']) expect(canvasKey(k(key), false, false), key).toBeNull()
  expect(canvasKey(k('Delete'), false, true)).toBe('delete'); expect(canvasKey(k('Escape'), false, true)).toBe('clear')
  expect(canvasKey(k('F2'), false, true)).toBe('rename'); expect(canvasKey(k('Enter'), false, true)).toBe('open')
  expect(canvasKey(k('ArrowRight'), false, true)).toBe('next'); expect(canvasKey(k('ArrowLeft'), false, true)).toBe('prev')
  expect(canvasKey(k('ArrowUp'), false, true)).toBe('up'); expect(canvasKey(k('ArrowDown'), false, true)).toBe('down')
  expect(canvasKey(k('ArrowRight', { shiftKey: true }), false, true)).toBe('allNext')
  expect(canvasKey(k('ArrowLeft', { shiftKey: true }), false, true)).toBe('allPrev')
})
it('lets the arrows pick the trigger with nothing selected', () => {
  expect(canvasKey(k('ArrowRight'), false, false)).toBe('next')
})
it('selects all on Ctrl+A or Cmd+A', () => {
  expect(canvasKey(k('a', { ctrlKey: true }), false, false)).toBe('selectAll')
})
```

In `workflowEditor.test.ts`, replace the `step selection` block. The `kindOf` stub maps ids starting `n` to `'note'`, `g` to `'group'`, else `'step'`:

```ts
it('itemsSelection is nothing, one item of its kind, or items', () => {
  expect(itemsSelection({})).toBeNull()
  expect(itemsSelection({ steps: ['a'] })).toEqual({ kind: 'step', id: 'a' })
  expect(itemsSelection({ notes: ['n1'] })).toEqual({ kind: 'note', id: 'n1' })
  expect(itemsSelection({ groups: ['g1'] })).toEqual({ kind: 'group', id: 'g1' })
  expect(itemsSelection({ steps: ['a', 'a'], notes: ['n1'] })).toEqual({ kind: 'items', steps: ['a'], notes: ['n1'], groups: [] })
})
it('applySelect adds and removes items of every kind', () => {
  let s = applySelect(null, [{ id: 'a', selected: true }], kindOf)
  s = applySelect(s, [{ id: 'n1', selected: true }, { id: 'g1', selected: true }], kindOf)
  expect(s).toEqual({ kind: 'items', steps: ['a'], notes: ['n1'], groups: ['g1'] })
  expect(applySelect(s, [{ id: 'n1', selected: false }, { id: 'g1', selected: false }], kindOf)).toEqual({ kind: 'step', id: 'a' })
})
it('applySelect keeps an edge until an item is picked', () => {
  expect(applySelect({ kind: 'edge', id: 'e' }, [{ id: 'a', selected: false }], kindOf)).toEqual({ kind: 'edge', id: 'e' })
})
it('pruneSelection drops ids the workflow no longer has', () => {
  const w = { ...newWorkflow('UTC', seq()), steps: [step('a')], notes: [], groups: [] }
  expect(pruneSelection({ kind: 'items', steps: ['a', 'gone'], notes: ['n-gone'], groups: [] }, w, new Set())).toEqual({ kind: 'step', id: 'a' })
  expect(pruneSelection({ kind: 'edge', id: 'gone' }, w, new Set())).toBeNull()
})
```

Keep the old block's cases ("a plain click takes that step alone", "sameSelection") rewritten for the new shape.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run zumi-bot-server/frontend/tests/workflowKeys.test.ts zumi-bot-server/frontend/tests/workflowEditor.test.ts`
Expected: FAIL (`canvasKey`/`itemsSelection` not exported).

- [ ] **Step 3: Implement**

- In `canvasKey`, the modifier test is `ctrlKey || metaKey`. Group keys match `code === 'KeyG'`. Shift+S matches `key === 'S' || (shiftKey && key.toLowerCase() === 's')` with no Ctrl or Alt. Arrows, F2, Enter, Delete, Backspace and Esc need `hasSelection`, except a plain arrow, which may run with none (`next`, `prev`, `up`, `down`).
- In `WorkflowEditor.tsx`, the key handler switches on `canvasKey`. In this task, only `save`, `selectAll`, `delete` and `clear` do something. The other actions are wired in later tasks: Task 2 for history, Task 3 for duplicate, Task 4 for zoom, addStep, panMode and run, Task 5 for navigation, Task 10 for addNote, Task 14 for groups. Ctrl+A selects every step, note and collapsed group.
- In `WorkflowCanvas.tsx`, node `selected` comes from `picked(sel)`. `onNodesChange` passes `kindOf` from the node's `type` (`'step' | 'note' | 'groupCollapsed'` → `ItemKind`). The Selection inspector replaces `GroupInspector`: `SelectionInspector({ count, removable, onRemove, children? })`, with `data-testid="wf-selection-inspector"`, heading "N items selected" and button `wf-selection-remove` ("Delete N items"; the trigger is not counted).
- The overview hint text drops "Shift-drag" and reads "drag a box around them on empty canvas".

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project frontend && npm run typecheck`
Expected: PASS.

### Task 2: Undo and redo

**Files:**
- Create: `frontend/src/state/workflowHistory.ts`
- Modify: `frontend/src/components/WorkflowEditor.tsx` (`edit` takes a coalescing key, history refs, undo/redo keys, Discard clears), `StepInspector.tsx` and `TriggerInspector.tsx` (pass keys on text edits)
- Test: `frontend/tests/workflowHistory.test.ts`

**Interfaces:**
- Consumes: `WorkflowInput`, `pruneSelection` (Task 1).
- Produces:
  ```ts
  export type Undoable = Pick<WorkflowInput, 'name' | 'timeZone' | 'trigger' | 'steps' | 'edges' | 'notes' | 'groups'>
  export interface History { past: Undoable[]; future: Undoable[]; last: { key: string; at: number } | null }
  export const HISTORY_MAX = 100
  export const COALESCE_MS = 1_000
  export const emptyHistory: History
  export function record(h: History, before: WorkflowInput, after: WorkflowInput, key: string | null, now: number): History
  export function undo(h: History, current: WorkflowInput): { h: History; w: WorkflowInput } | null
  export function redo(h: History, current: WorkflowInput): { h: History; w: WorkflowInput } | null
  // WorkflowEditor: edit(change: (w: WorkflowInput) => WorkflowInput, key?: string): void
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it('records a change and undoes it, keeping enabled and the id', () => {
  const a = wf({ name: 'A' }), b = { ...a, name: 'B', enabled: true }
  const h = record(emptyHistory, a, b, null, 0)
  const u = undo(h, b)!
  expect(u.w).toEqual({ ...a, enabled: true })
  expect(redo(u.h, u.w)!.w.name).toBe('B')
})
it('records nothing when only enabled changed', () => {
  const a = wf(), b = { ...a, enabled: !a.enabled }
  expect(record(emptyHistory, a, b, null, 0)).toBe(emptyHistory)
})
it('coalesces edits from the same field within 1 s, not after, and not across fields', () => {
  let h = record(emptyHistory, wf({ name: '' }), wf({ name: 'a' }), 's1:prompt', 0)
  h = record(h, wf({ name: 'a' }), wf({ name: 'ab' }), 's1:prompt', 900)
  expect(h.past).toHaveLength(1)
  h = record(h, wf({ name: 'ab' }), wf({ name: 'abc' }), 's1:prompt', 1_901)
  expect(h.past).toHaveLength(2)
  h = record(h, wf({ name: 'abc' }), wf({ name: 'abcd' }), 's1:name', 1_902)
  expect(h.past).toHaveLength(3)
})
it('a null key never coalesces', () => {
  let h = record(emptyHistory, wf({ name: 'a' }), wf({ name: 'b' }), null, 0)
  h = record(h, wf({ name: 'b' }), wf({ name: 'c' }), null, 1)
  expect(h.past).toHaveLength(2)
})
it('caps the past at 100 and a new edit clears redo', () => {
  let h = emptyHistory
  for (let i = 0; i < 120; i++) h = record(h, wf({ name: String(i) }), wf({ name: String(i + 1) }), null, i * 10_000)
  expect(h.past).toHaveLength(100)
  const u = undo(h, wf({ name: '120' }))!
  expect(record(u.h, u.w, wf({ name: 'x' }), null, 0).future).toEqual([])
})
it('undo and redo with nothing to do return null', () => {
  expect(undo(emptyHistory, wf())).toBeNull(); expect(redo(emptyHistory, wf())).toBeNull()
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run zumi-bot-server/frontend/tests/workflowHistory.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

- `record` compares the two drafts' undoable parts with the same canonical JSON that `dirty` uses (export `canon` from `workflowCanvas.ts`). When they are equal, it returns `h` itself.
- `edit` in the editor computes `next = change(draftRef.current)`. If `next` is the same object, it stops. Otherwise it sets `draftRef.current = next` at once, so two edits in one tick chain, records the history (kept in a ref, with a state tick so the UI re-renders), then calls `setDraft(next)`.
- Undo and redo run `pruneSelection` on the selection.
- **Discard changes** and opening the editor start with `emptyHistory`. Save keeps the history.
- Keys for text fields: `${stepId}:${field}` in `StepInspector`, `trigger:${field}` in `TriggerInspector`, `workflow:name` for the name input. Drags, connects, adds and removes pass no key.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project frontend && npm run typecheck`
Expected: PASS.

### Task 3: Shared input parsing, and the clipboard

**Files:**
- Create: `shared/src/workflowInput.ts` (the backend file's content, plus exported pieces)
- Modify: `backend/src/core/workflows/workflowInput.ts` → `export * from '@zumibot/shared/workflowInput'`
- Create: `frontend/src/state/workflowClipboard.ts`
- Modify: `frontend/src/state/workflowCanvas.ts` (export `rewriteHandles` from the body of `rehandle`)
- Modify: `frontend/src/components/WorkflowEditor.tsx` (`copy`/`cut`/`paste` document listeners, duplicate)
- Test: `frontend/tests/workflowClipboard.test.ts` (the backend's `workflows:save` tests in `handlers.test.ts` keep covering the moved parser)

**Interfaces:**
- Produces:
  ```ts
  // shared/src/workflowInput.ts — parseWorkflowInput unchanged in behavior, plus:
  export function parseStep(v: unknown): Step
  export function parseEdges(v: unknown, kinds: Map<string, StepKind>): Edge[]
  // workflowCanvas.ts
  export function rewriteHandles(step: Step, map: Map<string, string>): Step   // {{steps.<old>.output}} → new, whitespace kept
  // workflowClipboard.ts
  export const CLIP_MARK = 'workflow-clip'
  export interface Clip { steps: Step[]; edges: Edge[]; notes: Note[]; groups: CanvasGroup[] }
  export function copyClip(w: WorkflowInput, sel: Selection | null, collapsed: Set<string>): Clip | null
  export const clipText = (c: Clip): string   // JSON.stringify({ zumibot: CLIP_MARK, v: 1, ...c })
  export function parseClip(text: string): Clip | null
  export function pasteClip(w: WorkflowInput, c: Clip, at: { x: number; y: number } | null, gen?: IdGen):
    { w: WorkflowInput; picked: Selection | null } | { error: string }
  export function setLastClip(c: Clip): void
  export function lastClip(): Clip | null
  ```
  In this task `notes` and `groups` are always `[]` (the types arrive in Tasks 8 and 12; until then declare `notes: unknown[]; groups: unknown[]` and tighten them there).

- [ ] **Step 1: Write the failing tests**

```ts
const w = base([
  trig('t', 0, 0), llm('a', 'A', 100, 0, '{{steps.b.output}} and {{ steps.x.output }}'), llm('b', 'B', 400, 0, 'hi')
], [edge('t', 'out', 'a'), edge('a', 'out', 'b')])
it('copies the picked steps and only the edges between them, never the trigger', () => {
  const c = copyClip(w, { kind: 'items', steps: ['t', 'a', 'b'], notes: [], groups: [] }, new Set())!
  expect(c.steps.map((s) => s.id)).toEqual(['a', 'b'])
  expect(c.edges.map((e) => e.id)).toEqual(['a-out-b'])
})
it('copies nothing for only the trigger, an edge or no selection', () => {
  expect(copyClip(w, { kind: 'step', id: 't' }, new Set())).toBeNull()
  expect(copyClip(w, { kind: 'edge', id: 'a-out-b' }, new Set())).toBeNull()
  expect(copyClip(w, null, new Set())).toBeNull()
})
it('round-trips through text', () => {
  const c = copyClip(w, { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }, new Set())!
  expect(parseClip(clipText(c))).toEqual(c)
})
it('ignores text that is not a valid clip', () => {
  for (const t of ['', 'hello', '{}', '[]', '{"zumibot":"other","v":1}', '{"zumibot":"workflow-clip","v":2,"steps":[]}',
    JSON.stringify({ zumibot: CLIP_MARK, v: 1, steps: [{ id: 'x', kind: 'shell' }], edges: [], notes: [], groups: [] }),
    JSON.stringify({ zumibot: CLIP_MARK, v: 1, steps: [], edges: [{ id: 'e', from: 'a', port: 'out', to: 'b' }], notes: [], groups: [] })])
    expect(parseClip(t), t).toBeNull()
})
it('pastes with new ids, unique handles and rewritten templates among the pasted steps', () => {
  const c = copyClip(w, { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }, new Set())!
  const r = pasteClip(w, c, null, seq('p'))
  if ('error' in r) throw new Error(r.error)
  const [a2, b2] = r.w.steps.slice(3)
  expect(new Set(r.w.steps.map((s) => s.id)).size).toBe(5)
  expect(b2.handle).toBe('b-2')
  expect((a2 as LlmStep).prompt).toBe('{{steps.b-2.output}} and {{ steps.x.output }}')
  expect(r.w.edges.at(-1)).toMatchObject({ from: a2.id, to: b2.id, port: 'out' })
  expect(r.picked).toEqual({ kind: 'items', steps: [a2.id, b2.id], notes: [], groups: [] })
})
it('offsets by 40 px without a point, and puts the top-left at the point', () => {
  const c = copyClip(w, { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }, new Set())!
  const off = pasteClip(w, c, null, seq('p')) as { w: WorkflowInput }
  expect(off.w.steps.slice(3).map((s) => [s.x, s.y])).toEqual([[140, 40], [440, 40]])
  const at = pasteClip(w, c, { x: 1000, y: 500 }, seq('q')) as { w: WorkflowInput }
  expect(at.w.steps.slice(3).map((s) => [s.x, s.y])).toEqual([[1000, 500], [1300, 500]])
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run zumi-bot-server/frontend/tests/workflowClipboard.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

- Move `backend/src/core/workflows/workflowInput.ts` to `shared/src/workflowInput.ts` unchanged, then export `parseStep` (today's `step`) and `parseEdges`. The backend file re-exports it. Backend tests must still pass untouched.
- `parseClip` runs `JSON.parse` in try/catch. It needs `zumibot === CLIP_MARK` and `v === 1`, then parses `steps` with `parseStep`, refuses a trigger, and parses `edges` with `parseEdges` against the clip's own steps. Any throw returns null. `notes` and `groups` are parsed in Tasks 9 and 13.
- `pasteClip` gives new ids through `freshId` against all of `w`'s ids. Handles go through `handleFor(copiedStep.handle, taken)` against the target's handles, adding each new one as it is given. Templates are rewritten with `rewriteHandles` using the old→new map of pasted steps only. The placement shift uses the clip's min x and min y.
- `WorkflowEditor` adds `document` listeners for `copy`, `cut` and `paste`. Each does nothing when `isTypingTarget(document.activeElement)`, when a dialog is open, or when focus is outside the editor root (the same rule as the keys). Copy and cut call `e.clipboardData.setData('text/plain', clipText(c))` and `e.preventDefault()`, and also `setLastClip(c)`. Cut then removes the items (one `edit`). Paste reads `e.clipboardData.getData('text/plain')`. When `parseClip` is null, it returns without `preventDefault`. Otherwise it calls `pasteClip` at the pointer (from `CanvasCommands.pointer()`, Task 4; pass `null` until then), applies one `edit`, sets the selection, and shows an `error` as an error notice.
- The `duplicate` key runs `copyClip` then `pasteClip(…, null)` and leaves the system clipboard alone.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project frontend --project shared --project backend && npm run typecheck`
Expected: PASS.

### Task 4: n8n mouse, toolbar, zoom keys, snap and read-only panning

**Files:**
- Modify: `frontend/src/components/WorkflowCanvas.tsx`, `WorkflowEditor.tsx`, `WorkflowRunView.tsx` (nothing beyond what the shared canvas gives), `styles.css`
- Modify: `frontend/src/state/workflowCanvas.ts` (`snap`, and `GRID = 20`)
- Test: `frontend/tests/workflowCanvas.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // workflowCanvas.ts
  export const GRID = 20
  export const ZOOM = { min: 0.1, max: 4 }
  export const snap = (v: number): number   // Math.round(v / GRID) * GRID
  // WorkflowCanvas.tsx — new optional prop
  export interface CanvasCommands {
    zoomIn(): void; zoomOut(): void; zoomReset(): void; fit(): void
    pointer(): { x: number; y: number } | null          // flow coords of the last pointer over the canvas, null when it left
    viewCentre(): { x: number; y: number }
    openAddMenu(at?: { x: number; y: number }): void
    togglePan(): void
  }
  // WorkflowCanvasProps gains: commands?: RefObject<CanvasCommands | null>
  ```

- [ ] **Step 1: Write the failing test**

```ts
describe('snap', () => {
  it('rounds to the 20 px grid', () => {
    expect([snap(0), snap(9), snap(10), snap(-11), snap(333)]).toEqual([0, 0, 20, -20, 340])
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run zumi-bot-server/frontend/tests/workflowCanvas.test.ts -t snap`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **React Flow props (editable)**: `selectionOnDrag`, `selectionKeyCode={null}`, `panOnDrag={panMode ? [0, 1] : [1]}`, `panActivationKeyCode={['Space', 'Control', 'Meta']}`, `zoomActivationKeyCode={['Control', 'Meta']}`, `panOnScroll`, `zoomOnScroll={false}`, `snapToGrid`, `snapGrid={[GRID, GRID]}`, `minZoom={ZOOM.min}`, `maxZoom={ZOOM.max}`. Keep `multiSelectionKeyCode` (Control, Meta). Delete `BOX_KEY`. Drops already round, so they now go through `snap`.
- **Read-only** (no `onEdit`): `panOnDrag` true, `selectionOnDrag` false, `panOnScroll`, and the same zoom activation and range.
- **Toolbar**: replace the top-left `Panel` with `<Panel position="bottom-center" className="wf-toolbar">`. Its buttons are `wf-tool-select` (aria-pressed when not in Pan mode), `wf-tool-pan` (aria-pressed in Pan mode), a divider, `wf-tool-note` (disabled until Task 10, hidden in read-only), a divider, and `wf-add` ("Add step"). Their titles are "Select", "Pan (H, or hold Space or Ctrl)", "Add sticky note (Shift+S)" and "Add step (N)". Pan mode is canvas state, toggled by the button and `commands.togglePan()`.
- **Touch** (`matchMedia('(pointer: coarse)')` at mount): `panOnDrag` true, `selectionOnDrag` false and `selectionKeyCode="Shift"`, so one finger pans, pinch zooms and a box needs Shift, as n8n does on touch.
- **Zoom buttons**: `<Controls showInteractive={false}>` plus a `<ControlButton>` "Reset zoom" (`wf-zoom-reset`) running `zoomTo(1)`.
- **Commands**: the canvas fills `p.commands.current` in an effect: `zoomIn`/`zoomOut` with `{ duration: 150 }`, `zoomReset` as `zoomTo(1)`, `fit` as `fitView({ padding: 0.25, maxZoom: 1 })`. `pointer` is tracked by `onPointerMove`/`onPointerLeave` on the wrapper through `screenToFlowPosition`. `viewCentre` is the wrapper's centre. `openAddMenu` is today's toggle, anchored at the toolbar's Add button (or at `at`).
- **Editor keys**: `zoomIn`, `zoomOut`, `zoomReset`, `fit`, `addStep` (`openAddMenu()`), `panMode` and `run` (the header's Run handler, with its checks). Each calls `preventDefault()`.
- `styles.css`: `.wf-toolbar` styled as in the mockup (12 px radius, raised background, 32 px buttons, `aria-pressed` highlighted). `.react-flow__pane.dragging` keeps the grab cursor.

- [ ] **Step 4: Run tests, typecheck and a manual look**

Run: `npx vitest run --project frontend && npm run typecheck`
Expected: PASS. In `npm run dev`, open a workflow and check:
- A left drag on empty canvas boxes steps.
- Ctrl+drag, a middle drag and Space+drag pan.
- The wheel pans and Ctrl+wheel zooms.
- `+ - 0 1` zoom.
- N opens the menu, and H toggles Pan.
- A run's view pans on a left drag.

### Task 5: Arrow navigation, F2, Enter and double-click

**Files:**
- Create: `frontend/src/state/workflowNav.ts`
- Modify: `frontend/src/components/WorkflowEditor.tsx`, `WorkflowCanvas.tsx` (`onNodeDoubleClick`), `StepInspector.tsx` (`focusField`)
- Test: `frontend/tests/workflowNav.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NavDir = 'next' | 'prev' | 'up' | 'down'
  export function navTarget(w: Pick<WorkflowInput, 'steps' | 'edges'>, from: string | null, dir: NavDir): string | null
  export function reachAll(w: Pick<WorkflowInput, 'steps' | 'edges'>, from: string, dir: 'next' | 'prev'): string[]
  // StepInspector props gain: focus?: { field: 'name' | 'first'; n: number }   // n changes on each request
  ```

- [ ] **Step 1: Write the failing tests**

Graph: `t → a`, `a → b (out)`, `c (condition) yes → d`, `c no → e`, `t → c`. Positions: a(300, 0), c(300, 200), b(600, 0), d(600, 150), e(600, 300).

```ts
it('picks the trigger from nothing', () => expect(navTarget(w, null, 'next')).toBe('t'))
it('goes downstream to the topmost child and upstream to the topmost parent', () => {
  expect(navTarget(w, 't', 'next')).toBe('a'); expect(navTarget(w, 'c', 'next')).toBe('d')
  expect(navTarget(w, 'b', 'prev')).toBe('a'); expect(navTarget(w, 't', 'prev')).toBeNull()
})
it('moves among siblings by y', () => {
  expect(navTarget(w, 'd', 'down')).toBe('e'); expect(navTarget(w, 'e', 'up')).toBe('d')
  expect(navTarget(w, 'a', 'down')).toBe('c'); expect(navTarget(w, 'a', 'up')).toBeNull()
})
it('reachAll lists every step downstream or upstream, without the start, loops included once', () => {
  expect(reachAll(w, 'c', 'next').sort()).toEqual(['d', 'e'])
  expect(reachAll(w, 'b', 'prev').sort()).toEqual(['a', 't'])
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run zumi-bot-server/frontend/tests/workflowNav.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Children and parents are sorted by `y`, then `x`, then id. Siblings are the children of all of `from`'s parents, without `from`, sorted the same way. `up` picks the nearest above, and `down` the nearest below.
- Editor: `next`/`prev`/`up`/`down` start from the single selected step or the last step of `picked().steps`, or from `null` with nothing selected. Notes alone, an edge, or a collapsed group (until Task 14 maps hidden steps) do nothing. `allNext`/`allPrev` add `reachAll` to the picked steps. The selected step is panned into view with the existing `panInto` and `VIEW_MARGIN`.
- `rename` with a step sets `focus: { field: 'name' }`, and `open` sets `{ field: 'first' }`. The first field is the first `textarea` or `input` after the name in the inspector (`StepInspector` focuses it in an effect keyed by `n`, and selects the text for `name`). Double-clicking a step selects it and opens it the same way.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project frontend && npm run typecheck`
Expected: PASS.

### Task 6: The right-click menu (steps and canvas)

**Files:**
- Create: `frontend/src/state/workflowMenu.ts`, `frontend/src/components/WorkflowMenu.tsx`
- Modify: `frontend/src/components/WorkflowCanvas.tsx` (`onNodeContextMenu`, `onPaneContextMenu`, `onSelectionContextMenu`), `WorkflowEditor.tsx` (runs the actions)
- Test: `frontend/tests/workflowMenu.test.ts`

**Interfaces:**
- Consumes: `Selection`, `picked` (Task 1), `lastClip` (Task 3).
- Produces:
  ```ts
  export type MenuAction =
    | 'open' | 'rename' | 'copy' | 'cut' | 'duplicate' | 'delete' | 'group' | 'ungroup' | 'edit' | 'color'
    | 'editDescription' | 'collapse' | 'expand' | 'selectGroup' | 'copyGroup' | 'deleteGroup'
    | 'addStep' | 'addNote' | 'paste' | 'selectAll' | 'expandAll' | 'collapseAll' | 'fit'
  export interface MenuItem { action: MenuAction; label: string; keys?: string; disabled?: string }
  export type MenuTarget = { kind: 'pane' } | { kind: 'step' | 'note' | 'group'; id: string } | { kind: 'selection' }
  export interface MenuContext { canPaste: boolean; collapsed: Set<string>; groupRule?: string | null }
  export function menuItems(w: WorkflowInput, target: MenuTarget, sel: Selection | null, ctx: MenuContext): MenuItem[]
  export function selectionForMenu(sel: Selection | null, target: MenuTarget): Selection | null
  // WorkflowMenu.tsx
  export function CanvasContextMenu(p: { at: { left: number; top: number }; items: MenuItem[]; onPick: (a: MenuAction) => void; onClose: () => void }): JSX.Element
  ```
  In this task, only the step, pane and selection items are built. Note items come in Task 9 and group items in Task 13.

- [ ] **Step 1: Write the failing tests**

```ts
const actions = (items: MenuItem[]) => items.map((i) => i.action)
it('offers step actions with their keys', () => {
  const items = menuItems(w, { kind: 'step', id: 'a' }, { kind: 'step', id: 'a' }, ctx)
  expect(actions(items)).toEqual(['open', 'rename', 'copy', 'cut', 'duplicate', 'delete'])
  expect(items.find((i) => i.action === 'rename')?.keys).toBe('F2')
})
it('disables copy, cut and delete for the trigger alone', () => {
  const items = menuItems(w, { kind: 'step', id: 't' }, { kind: 'step', id: 't' }, ctx)
  for (const a of ['copy', 'cut', 'delete'] as const) expect(items.find((i) => i.action === a)?.disabled).toBeTruthy()
})
it('offers the pane actions, paste disabled without a clip', () => {
  const items = menuItems(w, { kind: 'pane' }, null, { ...ctx, canPaste: false })
  expect(actions(items)).toEqual(['addStep', 'addNote', 'paste', 'selectAll', 'fit'])
  expect(items.find((i) => i.action === 'paste')?.disabled).toBe('Copy something first, or press Ctrl+V')
})
it('a right-click on an unselected item selects it alone; on a selected one keeps the selection', () => {
  const sel: Selection = { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }
  expect(selectionForMenu(sel, { kind: 'step', id: 'c' })).toEqual({ kind: 'step', id: 'c' })
  expect(selectionForMenu(sel, { kind: 'step', id: 'a' })).toBe(sel)
})
```

(`addNote` is listed now and disabled with "Notes come in a later task" until Task 10 removes that reason. Expand all / Collapse all are added in Task 13.)

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run zumi-bot-server/frontend/tests/workflowMenu.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `keys` labels: Open `Enter`, Rename `F2`, Copy `Ctrl+C`, Cut `Ctrl+X`, Duplicate `Ctrl+D`, Delete `Del`, Add step `N`, Add sticky note `Shift+S`, Paste `Ctrl+V`, Select all `Ctrl+A`, Fit view `1`. Use `⌘` in place of `Ctrl` when `navigator.platform` starts with `Mac`, passing the platform into the component, not into the pure module.
- The component is an absolutely placed `.menu` in the canvas wrapper, kept inside the canvas like `openMenu`. It closes on Esc, a pick or a click outside (`useDismiss`). Its test ids are `wf-ctx-menu` and `wf-ctx-<action>`. A disabled item shows its reason as `title`.
- The canvas calls `e.preventDefault()` on every context-menu event in the editor. Read-only canvases show no menu.
- **Add step** and **Add sticky note** from the pane menu place the item at the flow point of the right-click.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project frontend && npm run typecheck`
Expected: PASS.

### Task 7: e2e for the canvas controls

**Files:**
- Modify: `e2e/workflows.e2e.mjs` (case 15 for the new selection test ids and plain-drag box; new case 16; `CASES = 16`)

- [ ] **Step 1: Update case 15**

- The box is a plain drag with no Shift.
- `groupTitle` reads `wf-selection-inspector h3`, and the texts become "2 items selected", "3 items selected" and "4 items selected".
- `wf-group-remove` → `wf-selection-remove`, with the text "Delete 3 items".

- [ ] **Step 2: Add case 16**

Title: `'canvas: Ctrl+drag, wheel and Ctrl+wheel move the view; Ctrl-click toggles; undo/redo; copy/paste across workflows; a field keeps its own paste'`. It saves two workflows by RPC ("Source": `trig → a → b`; "Target": a trigger only) and opens Source. The checks:

- Read the viewport with `page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform)`.
- Ctrl+drag on empty canvas changes the transform, and nothing is picked. The wheel (`page.mouse.wheel(0, 300)`) changes the y translation, not the scale. Ctrl+wheel changes the scale.
- `node(page, 'a').click({ modifiers: ['Control'] })` twice: picked, then not picked, and the step's saved position is unchanged.
- Select `b`, press Delete, then Ctrl+Z: `b` and its edge are back. Ctrl+Shift+Z removes them again, and Ctrl+Z brings them back.
- Click `a`, then Ctrl+Click `b`. Press Ctrl+C, then go to Target and click its empty canvas. Press Ctrl+V: two new steps and one edge appear, and the handles `a`/`b` are reused because Target has none. Save, then read the saved workflow through `workflows:list`.
- Back in Source, select `a` and focus `wf-step-name`. Then dispatch, through `page.evaluate`, a bubbling `ClipboardEvent('paste')` on the field whose `DataTransfer` holds a *valid* clip text (copied above). The event is not `defaultPrevented`, and the step count is unchanged, because the editor leaves a field's paste alone.
- On empty canvas, dispatch the same kind of event with the text `hello`: the step count is unchanged and no notice shows.

- [ ] **Step 3: Run the suite**

Run: `npm run e2e:workflows`
Expected: all 16 cases PASS and "no unexpected console or server errors".

---

# Part 2 — Sticky notes

### Task 8: Notes in the data, the save and the run snapshot

**Files:**
- Modify: `shared/src/workflows.ts`, `shared/src/workflowInput.ts`, `backend/src/rpc/handlers.ts` (`workflows:save` fields), `backend/src/core/workflows/workflowRunner.ts` (`start`), `frontend/src/state/workflowEditor.ts` (`toInput`), `frontend/src/state/workflowCanvas.ts` (`newWorkflow`)
- Test: `shared/tests/workflowInput.test.ts`, `backend/tests/rpc/handlers.test.ts`, `backend/tests/core/workflowRunner.test.ts`, `frontend/tests/workflowEditor.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export type NoteColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | `#${string}`
  export interface Note { id: string; x: number; y: number; width: number; height: number; color: NoteColor; text: string }
  export const NOTE_HEX_RE = /^#[0-9a-f]{6}$/
  export const NOTE_TEXT_MAX = 10_000, NOTES_MAX = 100, NOTE_MAX_SIDE = 5_000
  export const NOTE_MIN = { width: 150, height: 80 }
  export const NOTE_DEFAULT = { width: 240, height: 160, color: 1 as NoteColor, text: '## Note\nDouble-click to edit.' }
  export const notesOf = (w: { notes?: Note[] }): Note[] => w.notes ?? []
  // Workflow.notes?: Note[]; WorkflowInput = Pick<Workflow, … | 'notes'> & { id }; WorkflowRun.snapshot.notes?: Note[]
  export function parseNote(v: unknown): Note        // shared/src/workflowInput.ts
  ```
  `parseWorkflowInput` returns `notes` always (an array).

- [ ] **Step 1: Write the failing tests**

`shared/tests/workflowInput.test.ts`:

```ts
const good = { id: 'n1', x: 0, y: 0, width: 240, height: 160, color: 1, text: '## Hi' }
it('reads absent notes as none', () => expect(parseWorkflowInput(input()).notes).toEqual([]))
it('keeps a valid note, a custom color lower-cased, and clamps the size', () => {
  const w = parseWorkflowInput(input({ notes: [good, { ...good, id: 'n2', color: '#AABBCC', width: 10, height: 99_999 }] }))
  expect(w.notes[0]).toEqual(good)
  expect(w.notes[1]).toMatchObject({ color: '#aabbcc', width: 150, height: 5_000 })
})
it('refuses bad notes', () => {
  for (const notes of [[{ ...good, color: 8 }], [{ ...good, color: 'red' }], [{ ...good, x: Infinity }],
    [{ ...good, text: 'x'.repeat(10_001) }], [good, good], [{ ...good, id: 't' }], [{ ...good, id: 'constructor' }],
    Array.from({ length: 101 }, (_, i) => ({ ...good, id: `n${i}` }))])
    expect(() => parseWorkflowInput(input({ notes })), JSON.stringify(notes).slice(0, 80)).toThrow(/^Invalid workflow$/)
})
it('drops keys it does not know', () => {
  expect(parseWorkflowInput(input({ notes: [{ ...good, evil: 1 }] })).notes[0]).not.toHaveProperty('evil')
})
```

(`input()` builds a valid input whose trigger step has id `t`, so `{ ...good, id: 't' }` is an id clash.)

`handlers.test.ts`: `workflows:save` keeps `notes` (a reload of `workflows:list` returns them), and `workflows:duplicate` copies them with the same ids.

`workflowRunner.test.ts`: a run of a workflow with one note has `snapshot.notes` equal to it, and a later edit of the workflow's note does not change it.

`workflowEditor.test.ts`: `toInput` of a stored workflow with no `notes` key gives `notes: []`, and `dirty(toInput(old), toInput(old))` is false.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run zumi-bot-server/shared/tests/workflowInput.test.ts zumi-bot-server/backend/tests/rpc/handlers.test.ts zumi-bot-server/backend/tests/core/workflowRunner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `parseNote` rebuilds the note key by key. Its id is unique across steps and notes (one `Set` in `parseWorkflowInput`). Width and height are clamped. The text is checked with `text(v, NOTE_TEXT_MAX)`.
- The save's `fields` adds `notes: input.notes`.
- `start` copies `notesOf(w)` into `snapshot.notes` (with `structuredClone` as today).
- `useCanvasWorkflow` in the run view passes `notes: r.snapshot.notes ?? []`.
- `newWorkflow` gets `notes: []`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

### Task 9: Note edits, ink, recent colors, and notes in the flow, clipboard, history and menu

**Files:**
- Create: `frontend/src/state/workflowNotes.ts`
- Modify: `frontend/src/state/workflowCanvas.ts` (`moveItems`, `removeItems`, `toFlow` notes), `workflowClipboard.ts`, `workflowMenu.ts`
- Test: `frontend/tests/workflowNotes.test.ts`, `workflowCanvas.test.ts`, `workflowClipboard.test.ts`, `workflowMenu.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // workflowNotes.ts
  export function addNote(w: WorkflowInput, at: { x: number; y: number }, gen?: IdGen): { w: WorkflowInput; noteId: string } | { error: string }
  export function resizeNote(w: WorkflowInput, id: string, box: { x: number; y: number; width: number; height: number }): WorkflowInput
  export function setNoteColor(w: WorkflowInput, id: string, color: NoteColor): WorkflowInput
  export function setNoteText(w: WorkflowInput, id: string, text: string): WorkflowInput
  export function noteInk(hex: string): 'dark' | 'light'
  export const RECENT_COLORS_MAX = 8
  export function pushRecentColor(list: string[], hex: string): string[]   // newest first, no repeats, max 8
  export function loadRecentColors(storage?: Storage): string[]
  export function saveRecentColors(list: string[], storage?: Storage): void
  export const NOTE_COLOR_NAMES: Record<1|2|3|4|5|6|7, string>             // 'Yellow' … 'Gray'
  // workflowCanvas.ts
  export function moveItems(w: WorkflowInput, moves: { id: string; x: number; y: number }[]): WorkflowInput  // steps and notes
  export function removeItems(w: WorkflowInput, p: Picked): WorkflowInput  // steps (not the trigger) with their edges, notes
  export type FlowItem = FlowNode | NoteFlowNode
  export interface NoteFlowNode { id: string; type: 'note'; position: { x: number; y: number }; width: number; height: number; zIndex: number; data: { note: Note } }
  // toFlow now returns { nodes: FlowItem[]; edges: FlowEdge[] }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it('adds a default note at the point, snapped, and refuses past 100', () => {
  const r = addNote(base(), { x: 13, y: 27 }, seq('n')) as { w: WorkflowInput; noteId: string }
  expect(r.w.notes).toEqual([{ id: r.noteId, x: 20, y: 20, width: 240, height: 160, color: 1, text: '## Note\nDouble-click to edit.' }])
  const full = { ...base(), notes: Array.from({ length: 100 }, (_, i) => ({ ...r.w.notes![0], id: `x${i}` })) }
  expect(addNote(full, { x: 0, y: 0 })).toEqual({ error: 'A workflow holds at most 100 notes' })
})
it('resizes with the minimum and the grid', () => {
  const w = withNote()
  expect(resizeNote(w, 'n1', { x: 3, y: 0, width: 90, height: 333 }).notes![0]).toMatchObject({ x: 0, width: 160, height: 340 })
})
it('sets a color, lower-casing a custom one, and refuses a bad one', () => {
  expect(setNoteColor(withNote(), 'n1', '#AABBCC').notes![0].color).toBe('#aabbcc')
  const w = withNote(); expect(setNoteColor(w, 'n1', '#abc' as NoteColor)).toBe(w)
})
it('picks readable ink', () => {
  expect(noteInk('#ffffff')).toBe('dark'); expect(noteInk('#000000')).toBe('light'); expect(noteInk('#ffeb3b')).toBe('dark')
})
it('keeps 8 recent colors, newest first, without repeats', () => {
  let l: string[] = []
  for (const c of ['#000001', '#000002', '#000001']) l = pushRecentColor(l, c)
  expect(l).toEqual(['#000001', '#000002'])
  for (let i = 3; i < 12; i++) l = pushRecentColor(l, `#0000${String(i).padStart(2, '0')}`)
  expect(l).toHaveLength(8)
})
it('loads an empty list from broken storage', () => {
  expect(loadRecentColors({ getItem: () => { throw new Error('denied') } } as unknown as Storage)).toEqual([])
})
```

`workflowCanvas.test.ts`:
- `moveItems` moves a step and a note in one edit, and returns the same object when nothing moves.
- `removeItems` removes the picked notes and steps, keeps the trigger, and drops edges.
- `toFlow` gives notes `zIndex` below every step. The smaller note has the higher `zIndex` (two notes 300×300 and 200×100 → the second higher), and on equal area the later note is higher.

`workflowClipboard.test.ts`:
- Notes are copied and pasted with new ids and shifted with the steps.
- A paste past `NOTES_MAX` returns `{ error: 'A workflow holds at most 100 notes' }`.
- `parseClip` refuses a note with color 9.

`workflowMenu.test.ts`: a note target gives `['edit', 'color', 'copy', 'cut', 'duplicate', 'delete']`, and the pane's `addNote` is enabled.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run zumi-bot-server/frontend/tests/workflowNotes.test.ts zumi-bot-server/frontend/tests/workflowCanvas.test.ts zumi-bot-server/frontend/tests/workflowClipboard.test.ts zumi-bot-server/frontend/tests/workflowMenu.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `noteInk` uses WCAG relative luminance and compares contrast against `#1a1d24` (dark ink) and `#ffffff` (light ink).
- Note `zIndex` = `-1000 + rank`, where rank orders notes by area descending, then by index ascending. So the biggest note is lowest and every note stays below steps (zIndex 0) and edges. Group boxes (Task 13) use `-2000`.
- `moveSteps` and `removeSteps` stay as thin wrappers over `moveItems`/`removeItems` only if callers remain; otherwise delete them and update callers.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project frontend && npm run typecheck`
Expected: PASS.

### Task 10: The note on the canvas, the editor wiring and the run view

**Files:**
- Create: `frontend/src/components/WorkflowNotes.tsx`
- Modify: `frontend/src/components/WorkflowCanvas.tsx` (node type `note`, `NodeResizer`, the double-click and the toolbar button), `WorkflowEditor.tsx` (`addNote` key, Delete with notes, the inspector for one note = overview), `Markdown.tsx` (the `images` prop), `styles.css` (note tokens and classes)

**Interfaces:**
- Consumes: Task 9 functions, `CanvasCommands.pointer()`/`viewCentre()` (Task 4).
- Produces:
  ```ts
  export function NoteNode(p: NodeProps<RFNode<{ note: Note; editable: boolean; editing: boolean }, 'note'>>): JSX.Element
  export function NoteColorPopover(p: { color: NoteColor; recent: string[]; onPick: (c: NoteColor) => void; onClose: () => void }): JSX.Element
  // Markdown props gain images?: boolean (default true); false renders <img> as its alt text in a span
  // Canvas actions context gains: editNote(id), endEdit(id, text), colorNote(id, c), removeNote(id), resizeNote(id, box)
  ```

- [ ] **Step 1: Build the note node**

- **Read mode**: `<div className="wf-note" data-testid="wf-note" data-note-id data-color>` with `<Markdown text={note.text} images={false} />` in a scrolling body. `unicode-bidi: plaintext` applies.
- **Hover bar** (`wf-note-bar`, editor only): `wf-note-edit`, `wf-note-color` and `wf-note-delete`, each `nodrag nopan` with a `mousedown` stop, as the edge buttons have.
- **Edit mode**: a `<textarea className="wf-note-text nodrag nopan nowheel" data-testid="wf-note-input">` over the box. Esc and blur end editing and save once through `endEdit`, which calls `edit` with the key `note:<id>:text` and a fresh coalescing window, so one session is one undo step.
- **Resize**: a `NodeResizer` shown while selected (editable), with `minWidth`/`minHeight` from `NOTE_MIN`. `onResizeEnd` → `resizeNote`, as one `edit`.
- **Colors**: preset fills come from `--note-N` and `--note-N-border` tokens, defined under `:root` with `light-dark()`, like the app's other tokens. A custom color is set inline as `background` and `--note-border: color-mix(in srgb, <hex> 70%, black)` (light) or `white` (dark, through `light-dark()`), and the ink class `ink-dark`/`ink-light` comes from `noteInk`.
- **Popover**: 7 swatches named by `NOTE_COLOR_NAMES`, then the recent colors, then `Custom…` (an `<input type="color">` plus a hex `<input>` accepting `#rrggbb` or `rrggbb`). Picking a custom color pushes it to the recent list and saves it.

- [ ] **Step 2: Wire the canvas and editor**

- `NODE_TYPES = { step: StepNode, note: NoteNode }`. Note nodes are `draggable` in the editor, `selectable`, and `deletable: false`.
- `onNodeDoubleClick` on a note starts editing. F2 and Enter on a single note do the same.
- `addNote` (key, toolbar `wf-tool-note`, menu) places the note at `commands.pointer() ?? commands.viewCentre()`, or at the right-click point, then selects it.
- `elevateNodesOnSelect={false}` keeps notes below steps when selected.
- The run view's canvas gets the snapshot's notes, read-only.

- [ ] **Step 3: Typecheck and look**

Run: `npm run typecheck && npx vitest run --project frontend`
Expected: PASS. In `npm run dev`, check:
- Shift+S adds a note at the pointer.
- A double-click opens the textarea. While typing, `N`, `1` and Delete only type.
- A heading renders after a click outside.
- A small note inside a bigger one stays on top.
- A note never covers a step or an edge.

### Task 11: e2e for notes

**Files:**
- Modify: `e2e/workflows.e2e.mjs` (case 17; `CASES = 17`)

- [ ] **Step 1: Add case 17**

Title: `'notes: Shift+S adds one at the pointer, Markdown edits render, colors and resize persist, a drag moves the note only, typing never hits canvas keys, a run shows it'`. It saves a workflow `trig → a` by RPC and opens it. The checks:

- Move the mouse over empty canvas and press Shift+S: one `wf-note` appears, and its box contains the pointer.
- Double-click it and fill `wf-note-input` with `# Phase one\nN1+ text`.
  - The step count is unchanged.
  - The viewport scale is unchanged.
- Click empty canvas: `wf-note h1` reads `Phase one`.
- Pick color 5 from the hover bar. Then Custom… → type `#123456` in the hex field.
  - `data-color` is `#123456`.
  - Drag the resizer's bottom-right handle by +100/+60.
- Save and reload: the note keeps its text, color and size. `workflows:list` shows `width`/`height` on the 20 px grid.
- Drag the note by its body over step `a`, then save: the note moved, and `a`'s saved position is unchanged.
- Run the workflow by RPC (`workflows:run`) and open its run view: one `wf-note` shows, with no hover bar.

- [ ] **Step 2: Run the suite**

Run: `npm run e2e:workflows`
Expected: 17/17 PASS.

---

# Part 3 — Canvas groups

### Task 12: Group rules, groups in the data, the save drop and the snapshot

**Files:**
- Create: `shared/src/workflowGroups.ts`
- Modify: `shared/src/workflows.ts`, `shared/src/workflowInput.ts`, `backend/src/rpc/handlers.ts`, `backend/src/core/workflows/workflowRunner.ts`, `frontend/src/state/workflowEditor.ts` (`toInput`), `frontend/src/state/workflowCanvas.ts` (`newWorkflow`)
- Test: `shared/tests/workflowGroups.test.ts`, `shared/tests/workflowInput.test.ts`, `backend/tests/rpc/handlers.test.ts`, `backend/tests/core/workflowRunner.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // workflows.ts
  export interface CanvasGroup { id: string; name: string; description?: string; steps: string[]; notes: string[] }
  export const GROUP_NAME_MAX = 100, GROUP_DESCRIPTION_MAX = 145, GROUPS_MAX = 50
  export const groupsOf = (w: { groups?: CanvasGroup[] }): CanvasGroup[] => w.groups ?? []
  // Workflow.groups?, WorkflowInput gains 'groups', WorkflowRun.snapshot.groups?
  // workflowInput.ts
  export function parseGroup(v: unknown): CanvasGroup     // shape only; membership checked by parseWorkflowInput
  // workflowGroups.ts
  export type GroupRuleBreak = 'too-few' | 'trigger' | 'taken' | 'not-connected' | 'many-entries' | 'many-exits'
  export const GROUP_RULE_TEXT: Record<GroupRuleBreak, string>
  type G = Pick<WorkflowInput, 'steps' | 'edges' | 'groups'>
  export function groupRuleBreak(w: G, steps: string[], notes: string[], self?: string): GroupRuleBreak | null
  export function groupEnds(w: Pick<WorkflowInput, 'edges'>, steps: string[]): { entry: string | null; exit: string | null }
  export function brokenGroups(w: G): { group: CanvasGroup; reason: GroupRuleBreak }[]
  export function dropBrokenGroups<T extends G>(w: T): T
  ```
  The `GROUP_RULE_TEXT` copy:
  - `too-few`: 'A group needs at least two items, one of them a step'
  - `trigger`: 'The trigger cannot be in a group'
  - `taken`: 'A step or note is already in another group'
  - `not-connected`: 'The steps must form one connected chain'
  - `many-entries`: 'Steps outside can only connect into the first step of the group'
  - `many-exits`: 'Steps outside can only connect from the last step of the group'

- [ ] **Step 1: Write the failing tests**

`workflowGroups.test.ts`, on graph `t → a → b → c → d`, plus `c (condition) no → x`. Remember that `self` excludes a group from `taken`:

```ts
it('accepts a chain inside the flow', () => expect(groupRuleBreak(w, ['b', 'c'], [])).toBeNull())
it('needs two items, one a step', () => {
  expect(groupRuleBreak(w, ['b'], [])).toBe('too-few')
  expect(groupRuleBreak(w, [], ['n1', 'n2'])).toBe('too-few')
  expect(groupRuleBreak(w, ['b'], ['n1'])).toBeNull()
})
it('refuses the trigger and taken items', () => {
  expect(groupRuleBreak(w, ['t', 'a'], [])).toBe('trigger')
  const g = { ...w, groups: [{ id: 'g1', name: 'G', steps: ['a', 'b'], notes: [] }] }
  expect(groupRuleBreak(g, ['b', 'c'], [])).toBe('taken')
  expect(groupRuleBreak(g, ['a', 'b'], [], 'g1')).toBeNull()
})
it('needs one connected chain', () => expect(groupRuleBreak(w, ['a', 'c'], [])).toBe('not-connected'))
it('allows one entry and one exit, the same step when it is both', () => {
  expect(groupEnds(w.edges, ['b', 'c'])).toEqual({ entry: 'b', exit: 'c' })
  expect(groupRuleBreak(w, ['a', 'b'], [])).toBeNull()
})
it('refuses a second entry or exit', () => {
  const w2 = { ...w, edges: [...w.edges, edge('t', 'out', 'c')] }
  expect(groupRuleBreak(w2, ['b', 'c'], [])).toBe('many-entries')
  const w3 = { ...w, edges: [...w.edges, edge('b', 'out', 'x')] }
  expect(groupRuleBreak(w3, ['b', 'c'], [])).toBe('many-exits')
})
it('keeps a loop inside the group', () => {
  const w4 = { ...w, edges: [...w.edges, edge('c', 'yes', 'b')] }
  expect(groupRuleBreak(w4, ['b', 'c'], [])).toBeNull()
})
it('dropBrokenGroups removes broken groups and members that are gone', () => {
  const g = { ...w, groups: [
    { id: 'ok', name: 'OK', steps: ['b', 'c', 'gone'], notes: [] },
    { id: 'bad', name: 'Bad', steps: ['a', 'd'], notes: [] }] }
  expect(dropBrokenGroups(g).groups).toEqual([{ id: 'ok', name: 'OK', steps: ['b', 'c'], notes: [] }])
})
```

`workflowInput.test.ts`:
- Absent `groups` → `[]`.
- A valid group is kept and its keys rebuilt (description absent stays absent).
- These are refused: a blank name after trimming, a name over 100, a description over 145, an unknown step or note id, the trigger as a member, a member in two groups, a group id that clashes with a step or note, and 51 groups.

`handlers.test.ts`:
- `workflows:save` keeps a valid group and drops a broken one (`a`+`d`), still saving the rest.
- Duplicate copies groups.

`workflowRunner.test.ts`: the snapshot carries `groups`.

`frontend/tests/workflowEditor.test.ts`: `toInput` of a stored workflow with no `groups` key gives `groups: []`, and `dirty(toInput(old), toInput(old))` is false.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run zumi-bot-server/shared/tests/workflowGroups.test.ts zumi-bot-server/shared/tests/workflowInput.test.ts zumi-bot-server/backend/tests/rpc/handlers.test.ts zumi-bot-server/backend/tests/core/workflowRunner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Connectivity is a union-find (or BFS) over member steps using edges whose two ends are both members, ignoring direction.
- Entry steps are members that are the `to` of an edge whose `from` is not a member. Exit steps are members that are the `from` of an edge whose `to` is not a member. More than one of either is a break.
- `dropBrokenGroups` first filters each group's members to existing ids (and removes the trigger). It then checks each group with `self` = its id, in order, so an earlier group keeps a contested item.
- The save handler runs `dropBrokenGroups(input)` before building `fields`, and `fields` adds `groups`.
- `start` copies `groupsOf(w)` into the snapshot. The run view passes `groups: r.snapshot.groups ?? []`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

### Task 13: Group edits, the box, the collapsed view and the push

**Files:**
- Create: `frontend/src/state/workflowGroupEdit.ts`
- Modify: `frontend/src/state/workflowCanvas.ts` (`removeItems` prunes groups; `insertStep` joins the group of an inner edge; `toFlow` emits group nodes and hides collapsed members), `workflowClipboard.ts` (groups), `workflowMenu.ts` (group items, Expand/Collapse all), `workflowRun.ts` (`groupRunState`)
- Test: `frontend/tests/workflowGroupEdit.test.ts`, `workflowCanvas.test.ts`, `workflowClipboard.test.ts`, `workflowMenu.test.ts`, `workflowRun.test.ts`

**Interfaces:**
- Consumes: `groupRuleBreak`, `groupEnds`, `brokenGroups` (Task 12).
- Produces:
  ```ts
  export type Box = { x: number; y: number; width: number; height: number }
  export type SizeOf = (id: string) => { width: number; height: number }
  export const GROUP_PAD = 24, GROUP_HEAD = 36, PUSH_GAP = 40
  export const COLLAPSED_SIZE = { width: 220, height: 64 }
  export function makeGroup(w: WorkflowInput, p: Picked, gen?: IdGen): { w: WorkflowInput; groupId: string } | { error: string }
  export function ungroup(w: WorkflowInput, ids: string[]): WorkflowInput
  export function deleteGroup(w: WorkflowInput, id: string): WorkflowInput          // the group and its members
  export function renameGroup(w: WorkflowInput, id: string, name: string): WorkflowInput   // blank → same object
  export function setGroupDescription(w: WorkflowInput, id: string, text: string): WorkflowInput  // '' removes the key
  export function groupOf(w: Pick<WorkflowInput, 'groups'>, itemId: string): CanvasGroup | null
  export function groupsOfPicked(w: WorkflowInput, p: Picked): string[]
  export function groupBox(w: WorkflowInput, g: CanvasGroup, sizeOf: SizeOf): Box
  export function collapsedView(w: WorkflowInput, collapsed: Set<string>):
    { hidden: Set<string>; edgeEnds: Map<string, { source?: string; target?: string; sourceHandle?: string }> }
  export function visibleItem(w: WorkflowInput, collapsed: Set<string>, id: string): string   // a hidden step → its group id
  export function expandPush(w: WorkflowInput, groupId: string, sizeOf: SizeOf, collapsed: Set<string>): WorkflowInput
  export function moveGroup(w: WorkflowInput, groupId: string, dx: number, dy: number): WorkflowInput
  export function loadCollapsed(workflowId: string | null, storage?: Storage): Set<string>
  export function saveCollapsed(workflowId: string | null, ids: Set<string>, storage?: Storage): void  // null id: no-op
  // workflowRun.ts
  export function groupRunState(states: Record<string, StepRunState>, steps: string[]): StepRunState['status'] | null
  ```
  Collapsed edge handles: target `<groupId>` with handle `in`, source `<groupId>` with handle `<port>` of the exit step.

- [ ] **Step 1: Write the failing tests**

```ts
it('makes a group named Group N and refuses a selection that breaks a rule', () => {
  const r = makeGroup(w, { steps: ['b', 'c'], notes: ['n1'], groups: [] }, seq('g')) as { w: WorkflowInput; groupId: string }
  expect(r.w.groups).toEqual([{ id: r.groupId, name: 'Group 1', steps: ['b', 'c'], notes: ['n1'] }])
  const r2 = makeGroup(r.w, { steps: ['d', 'x'], notes: [], groups: [] }, seq('h'))
  expect(r2).toEqual({ error: 'The steps must form one connected chain' })
})
it('names the next free number', () => {
  const w2 = { ...w, groups: [{ id: 'g1', name: 'Group 1', steps: ['a', 'b'], notes: [] }] }
  expect((makeGroup(w2, { steps: ['c', 'd'], notes: [], groups: [] }, seq('g')) as { w: WorkflowInput }).w.groups![1].name).toBe('Group 2')
})
it('ungroup keeps the items; deleteGroup removes them and their edges', () => {
  const g = grouped() // group g1 = b, c, n1
  expect(ungroup(g, ['g1']).groups).toEqual([]); expect(ungroup(g, ['g1']).steps).toHaveLength(g.steps.length)
  const d = deleteGroup(g, 'g1')
  expect(d.steps.map((s) => s.id)).not.toContain('b'); expect(d.notes!.map((n) => n.id)).not.toContain('n1')
  expect(d.edges.some((e) => ['b', 'c'].includes(e.from) || ['b', 'c'].includes(e.to))).toBe(false)
})
it('removing members prunes the group and drops it below two items or with no step', () => {
  const g = grouped()
  expect(removeItems(g, { steps: ['b'], notes: [], groups: [] }).groups![0]).toMatchObject({ steps: ['c'], notes: ['n1'] })
  expect(removeItems(g, { steps: ['b', 'c'], notes: [], groups: [] }).groups).toEqual([])
})
it('renames (never blank) and sets or clears the description', () => {
  const g = grouped()
  expect(renameGroup(g, 'g1', '  ')).toBe(g)
  expect(setGroupDescription(g, 'g1', 'Hi').groups![0].description).toBe('Hi')
  expect(setGroupDescription(setGroupDescription(g, 'g1', 'Hi'), 'g1', '').groups![0]).not.toHaveProperty('description')
})
it('derives the box from its members with padding and header', () => {
  // b at (300,0) 220x80, c at (600,0) 220x80, n1 at (300,120) 240x160
  expect(groupBox(grouped(), grouped().groups![0], size)).toEqual({ x: 276, y: -60, width: 568, height: 364 })
})
it('hides collapsed members and reroutes outside edges to the group', () => {
  const v = collapsedView(grouped(), new Set(['g1']))
  expect([...v.hidden].sort()).toEqual(['b', 'b-out-c', 'c', 'n1'])
  expect(v.edgeEnds.get('a-out-b')).toEqual({ target: 'g1' })
  expect(v.edgeEnds.get('c-out-d')).toEqual({ source: 'g1', sourceHandle: 'out' })
  expect(visibleItem(grouped(), new Set(['g1']), 'c')).toBe('g1')
})
it('expanding pushes overlapping items right, cascading, and leaves the rest', () => {
  // d at (520,0) would sit inside g1's box (x 276..844); e at (900,0) is clear; f at (900,40) gets hit by pushed d.
  const p = expandPush(crowded(), 'g1', size, new Set())
  expect(stepAt(p, 'd').x).toBe(884)         // box right 844 + 40
  expect(stepAt(p, 'f').x).toBeGreaterThanOrEqual(884 + 220 + 40)
  expect(stepAt(p, 'a')).toEqual(stepAt(crowded(), 'a'))
})
it('moves every member by the drag', () => {
  const m = moveGroup(grouped(), 'g1', 40, 20)
  expect([stepAt(m, 'b').x, stepAt(m, 'c').y, m.notes![0].x]).toEqual([340, 20, 340])
})
it('an inserted step in an inner edge joins the group', () => {
  const r = insertStep(grouped(), 'b-out-c', 'wait', { x: 450, y: 0 }, seq('i'))
  expect(r.w.groups![0].steps).toContain(r.stepId)
})
it('collapse state survives broken storage and skips an unsaved workflow', () => {
  expect(loadCollapsed('w1', { getItem: () => { throw new Error('x') } } as unknown as Storage)).toEqual(new Set())
  const mem = memoryStorage(); saveCollapsed(null, new Set(['g1']), mem); expect(mem.length).toBe(0)
})
```

`workflowRun.test.ts`:

```ts
it('groupRunState: failed beats waiting beats running beats done', () => {
  expect(groupRunState({ a: st('done'), b: st('failed') }, ['a', 'b'])).toBe('failed')
  expect(groupRunState({ a: st('paused'), b: st('running') }, ['a', 'b'])).toBe('waiting')
  expect(groupRunState({ a: st('running'), b: st('done') }, ['a', 'b'])).toBe('running')
  expect(groupRunState({ a: st('done') }, ['a', 'b'])).toBe('done')
  expect(groupRunState({}, ['a', 'b'])).toBeNull()
})
```

Then:
- `workflowClipboard.test.ts`: copying all of a group's members (or the collapsed group) copies the group with new ids for it and its members, while copying part of a group copies no group. Pasting past `GROUPS_MAX` gives the error text 'A workflow holds at most 50 groups'.
- `workflowMenu.test.ts`: a group target gives `['rename', 'editDescription', 'collapse', 'selectGroup', 'copyGroup', 'ungroup', 'deleteGroup']` (or `expand` when collapsed). A selection that breaks a rule shows `group` disabled with the rule text, and the pane adds `expandAll` and `collapseAll` before `fit` when the workflow has groups.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run --project frontend`
Expected: FAIL in the new and extended files.

- [ ] **Step 3: Implement**

- `groupBox` is the members' bounding box (steps by `sizeOf`, notes by their own size), grown by `GROUP_PAD` on each side and by `GROUP_HEAD` on top.
- `expandPush` repeats until stable, at most `steps + notes` passes (a guard against loops). An item outside the group whose box (its collapsed group's box when collapsed) overlaps the expanding box, or an item already pushed in this call, moves to `x = overlapping.right + PUSH_GAP`. Positions are snapped.
- `toFlow(w, problems, states, opts?: { collapsed: Set<string>; sizeOf: SizeOf })`:
  - For an expanded group, it emits a `group` node (box position, width and height; `zIndex: -2000`; not selectable or draggable). For a collapsed group, it emits a `groupCollapsed` node at the box's top-left (`COLLAPSED_SIZE`, selectable and draggable).
  - It drops hidden nodes and edges, and applies `edgeEnds` to the edges it keeps.
  - With no `opts`, it behaves as before plus notes.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project frontend && npm run typecheck`
Expected: PASS.

### Task 14: Group boxes, the collapsed node, keys, the inspector, the save notice and the run view

**Files:**
- Create: `frontend/src/components/WorkflowGroups.tsx`
- Modify: `frontend/src/components/WorkflowCanvas.tsx` (node types, sizes for `sizeOf` from `measured`, collapse state), `WorkflowEditor.tsx` (group keys, `pruneSelection` with collapsed, navigation mapping through `visibleItem`, the save-time drop and notice), `WorkflowPanels.tsx` (`CanvasGroupInspector`; Group and Ungroup in `SelectionInspector`), `WorkflowRunView.tsx`, `styles.css`

**Interfaces:**
- Consumes: Tasks 12 and 13.
- Produces:
  ```ts
  export function GroupBoxNode(p: NodeProps<RFNode<{ group: CanvasGroup; broken: string | null; editable: boolean; renaming: boolean }, 'group'>>): JSX.Element
  export function CollapsedGroupNode(p: NodeProps<RFNode<{ group: CanvasGroup; ports: Port[]; hasInput: boolean; state?: StepRunState['status'] | null; counts: { steps: number; notes: number } }, 'groupCollapsed'>>): JSX.Element
  export function CanvasGroupInspector(p: { group: CanvasGroup; edit: (c: (w: WorkflowInput) => WorkflowInput, key?: string) => void; onExpand: () => void; onUngroup: () => void; onDelete: () => void }): JSX.Element
  export function ungroupNotice(dropped: { group: CanvasGroup; reason: GroupRuleBreak }[]): string | null
  // "Ungrouped <name>: <reason text>" for one; "Ungrouped 2 groups: <name> (<reason>), <name> (<reason>)" for more
  ```
  `ungroupNotice` lives in `state/workflowGroupEdit.ts` with a test in `workflowGroupEdit.test.ts`:

```ts
it('says which groups the save ungrouped and why', () => {
  expect(ungroupNotice([])).toBeNull()
  expect(ungroupNotice([{ group: g('Deploy'), reason: 'many-entries' }]))
    .toBe('Ungrouped Deploy: Steps outside can only connect into the first step of the group')
  expect(ungroupNotice([{ group: g('A'), reason: 'too-few' }, { group: g('B'), reason: 'not-connected' }]))
    .toBe('Ungrouped 2 groups: A (A group needs at least two items, one of them a step), B (The steps must form one connected chain)')
})
```

- [ ] **Step 1: Write the `ungroupNotice` test, run it to fail, implement it, run it to pass**

Run: `npx vitest run zumi-bot-server/frontend/tests/workflowGroupEdit.test.ts -t ungroupNotice`
Expected: FAIL, then PASS.

- [ ] **Step 2: Build the nodes**

- `GroupBoxNode` (`wf-group`, `data-group-id`, `data-broken`) has a header with the chevron (`wf-group-toggle`), the name (`wf-group-name`) and either the description or a dim **Add description** (`wf-group-desc`).
  - Clicking the name opens an inline `<input class="nodrag nopan">`. Enter or blur saves with the key `group:<id>:name`, Esc cancels, and a blank name reverts.
  - Clicking the description opens an inline input with `maxLength={145}`.
  - A click on the chevron or elsewhere on the header collapses the group. The body area passes pointer events through (`pointer-events: none` on the body, `auto` on the header), so a box drag inside it still works.
  - A broken group gets a red border and a header warning: "Will be ungrouped on save: <reason>".
- `CollapsedGroupNode` (`wf-group-collapsed`, `data-group-id`) shows the chevron, the name, an info icon with `title` = the description, and "N steps · N notes".
  - It has an input `Handle` `in` when `hasInput`, and one source `Handle` per port in `ports`, labelled as on `StepNode` (reuse `PORT_TEXT`).
  - In a run view it shows a `StateMark` from `groupRunState`.

- [ ] **Step 3: Wire the canvas and editor**

- **Collapse state**: `useState(() => loadCollapsed(draft.id))`, saved on change (an unsaved workflow keeps it in memory, and the first save carries it to the new id). Collapse and expand are not edits. Expanding also runs `expandPush` as one `edit`.
- **Keys**:
  - `group` runs `makeGroup(picked(sel))`. On success it selects nothing, puts the new group in rename mode and records one history entry. On error it shows a warn notice with the reason.
  - `ungroup` runs `ungroup(groupsOfPicked)`.
  - `expand` and `collapse` act on `groupsOfPicked`, or on all groups when nothing is selected.
  - `rename` with a selected collapsed group, or with a single item that belongs to a group whose box is the target of the menu, starts the rename. `open` on a collapsed group expands it.
  - `delete` with a collapsed group selected runs `deleteGroup`.
- **Arrows**: a target id that `visibleItem` maps to a group selects that group.
- **Save**: before `api.workflows.save`, compute `brokenGroups(d)`. When any exist, save `dropBrokenGroups(d)`, set the warn notice `ungroupNotice(…)`, and reset the history to `emptyHistory` (the spec makes that ungroup not undoable: the saved draft is the new base, as after Discard). A save that drops nothing keeps the history.
- **Inspector**: one collapsed group selected → `CanvasGroupInspector` (`wf-canvas-group-inspector`; name and description inputs with keys; Expand, Ungroup and Delete group). `SelectionInspector` gains a **Group** button (`wf-selection-group`), disabled with the rule text from `groupRuleBreak`, and an **Ungroup** button (`wf-selection-ungroup`) when `groupsOfPicked` is non-empty.
- **Drag of a collapsed node**: on drop → `moveGroup(dx, dy)`, one `edit`.
- **Run view**: groups start expanded, with collapse state in memory only. A click on a collapsed group expands it, and steps inside an expanded group still open their visits.

- [ ] **Step 4: Typecheck and look**

Run: `npm run typecheck && npx vitest run --project frontend`
Expected: PASS. In `npm run dev`, check:
- Box two steps, press Ctrl+G and type a name.
- Collapse: one node, with edges into and out of it.
- Drag it, then expand next to a step: the step is pushed right.
- Add an edge from outside into the middle and save: the notice shows and the group is gone.
- Ctrl+Z after a Ctrl+G removes the group.

### Task 15: e2e for groups

**Files:**
- Modify: `e2e/workflows.e2e.mjs` (case 18; `CASES = 18`)

- [ ] **Step 1: Add case 18**

Title: `'groups: Ctrl+G names a chain, collapse reroutes edges and survives a reload, a drag moves it, expand pushes a neighbor, a broken group is ungrouped on save, copy to another workflow, a run shows it expanded'`. It saves `trig → a → b → c` and a step `side` at a spot the expanded group would cover once `a` and `b` are grouped and collapsed (place `side` after collapsing, through the canvas drag). The checks:

- Box `a`+`b` with a plain drag, press Ctrl+G and type `Deploy`, then Enter: `wf-group-name` reads `Deploy`. Save: `workflows:list` holds the group with steps `[a, b]`.
- Click `wf-group-toggle`: one `wf-group-collapsed`, no `wf-node` for `a`/`b`, and the edges `trig→group` and `group→c` are drawn (`.react-flow__edge` count 2). Reload: still collapsed.
- Drag the collapsed node by +80/+0 and save: `a` and `b` both moved by the same dx.
- Drag `side` onto the collapsed group's right side, save, then expand: `side` moved right (`x` grew), and the save shows it.
- Ctrl+Shift+G with `a` picked: no `wf-group`. Ctrl+Z: the group is back.
- Drag from `trig`'s `wf-port-out` handle onto `b` (expanded group), adding the edge `trig → b`. The group shows `data-broken="true"`. Click Save: `wf-notice` reads `Ungrouped Deploy: Steps outside can only connect into the first step of the group`, and `workflows:list` has no groups. Remove that edge again (its hover trash) and save.
- Group `a`+`b` again, select the collapsed group, Ctrl+C, open a second workflow, click the canvas, Ctrl+V: one group with two new steps.
- Run the first workflow by RPC and open its run: `wf-group` is shown expanded.

- [ ] **Step 2: Run the suite**

Run: `npm run e2e:workflows`
Expected: 18/18 PASS and no unexpected errors.

### Task 16: Docs and the full check

**Files:**
- Modify: `CLAUDE.md` (Commands' `e2e:workflows` sentence; the **Workflows** paragraph)

- [ ] **Step 1: Update `CLAUDE.md`**

- In Commands, append to the `e2e:workflows` list: "the canvas controls (a plain drag boxes, Ctrl+drag and the wheel pan, Ctrl+wheel zooms, undo and redo, copy and paste across workflows), sticky notes and canvas groups (Ctrl+G, collapse, the push, the ungroup on save)".
- In **Workflows**:
  - Data: `notes`/`groups` on the workflow and in the run snapshot (`notesOf`/`groupsOf`, validated in `shared/src/workflowInput.ts`, now shared so the clipboard parses with it), and never read by the engine.
  - The group rules (`shared/src/workflowGroups.ts`) and the drop on save.
  - The n8n controls: the props, the keys (`state/workflowKeys.ts`), the toolbar, the right-click menu (`state/workflowMenu.ts`, Paste from `lastClip`), the history (`state/workflowHistory.ts`, without `enabled` or collapse state) and the clipboard format (`workflow-clip` v1 through the copy/cut/paste events).
  - The note colors (`--note-N`, custom hex, the recent 8 in `cb.wf.noteColors`) and collapse in `cb.wf.collapsed.<id>`.
  - Replace the "groups (a Shift box and Ctrl-click…; a plain drag still pans)" sentence with the new selection behavior.

- [ ] **Step 2: Full verification**

Run, in order:
```bash
npm test
```
```bash
npm run typecheck
```
```bash
npm run e2e:workflows
```
```bash
npm run e2e:pause
```
Expected: all PASS. (`e2e:pause` reads `wf-node` states in a run view, so it checks the canvas still draws runs.)
