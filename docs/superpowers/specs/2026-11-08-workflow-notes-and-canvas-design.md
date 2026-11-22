# Workflow sticky notes, canvas groups and an n8n-style canvas

Status: design. The mockup was approved on 2026-11-08, and groups and custom colors were added the same day at the
user's request. Builds on `2026-11-07-workflows-design.md`.

## Intent

A workflow such as **Ship release** reads as phases: "1 · Prepare and submit release request", "2 · Prepare epic
branch", "3 · Cut release and deploy". The user wants to see those phases on the canvas the way n8n shows them:
colored sticky notes behind groups of steps, each with a heading and a few lines of Markdown, plus small notes beside a
step ("Approval link expires after 24 h"). The user also wants n8n's Canvas Groups, which put a named box around a
chain of steps that moves them together and collapses to its title. And the user wants the whole canvas to *feel* like
n8n, so the mouse and keys they already use in n8n work here: a left drag on empty canvas draws a selection box,
Ctrl+drag moves the canvas, and so on.

The user's words: "just like n8n, also make the whole experience like n8n". The approved mockup (notes and controls,
before groups were added) is kept at `.superpowers/brainstorm/812964-1794157530/content/canvas-notes.html`
(git-ignored).

Where n8n's docs are silent, this design picks a behavior and marks it *my call*.

## Goals

1. **Sticky notes**, as n8n's work: free colored boxes behind the steps, Markdown text, 7 preset colors plus custom hex
   colors, resizable. Dragging a note moves only the note.
2. **Canvas groups**, as n8n's work: Ctrl+G wraps a connected chain of steps (and notes) in a named box with an
   optional description. The box moves its contents, collapses to its title and expands again, and Ctrl+Shift+G
   ungroups it.
3. **n8n mouse controls** on the editor canvas: a left drag selects, Ctrl+drag, a middle drag or Space+drag pans, the
   wheel scrolls and Ctrl+wheel zooms.
4. **n8n keys**: zoom keys, Shift+S for a note, N for the Add step menu, copy, cut, paste, duplicate, undo and redo,
   arrow-key navigation, F2 and Enter, and the group keys.
5. **A floating bottom toolbar** (Select, Pan, Sticky note, Add step) and a **right-click menu**, both naming each
   action's shortcut, as n8n's do.
6. A run's view shows the notes and groups as they were when the run started.

## Non-goals

- **Images and YouTube embeds in notes.** The CSP allows `img-src 'self' data: blob:` and no frames, and it stays
  unchanged, as every feature so far kept it. A Markdown image renders as nothing (its alt text at most), never as a
  request.
- n8n's `d` (deactivate) and `p` (pin data): steps have neither. n8n's Command Bar (Ctrl+K) and Tidy up: not asked for.
- Nested groups (n8n has none either), and colors on groups (n8n has none).
- A hover toolbar on steps (n8n's run/deactivate/delete icons over a node): the inspector and the right-click menu
  already offer those actions.
- A shortcuts help screen: the toolbar's tooltips and the right-click menu show the shortcuts.
- The phone editor: it shows no canvas today ("Edit this workflow on a larger screen") and stays that way.

## Anti-goals

- **Notes and groups never change what runs.** The engine, `problemsOf`, templates, prompts, the Inbox and
  notifications never read them. A group is layout only: a collapsed group still runs every step inside it.
- The canvas controls must not break typing. No canvas key fires while focus is in a field, the inspector, a note
  being edited or a group name being renamed. Ctrl+Z in a text field stays the field's own undo, and Ctrl+C there
  copies text.
- Never a request to another host from a note (see the CSP non-goal above).
- A broken group must never block a save. As in n8n, it is ungrouped, and the user is told.

## Constraints

- React Flow `@xyflow/react` 12.12.0 is already the canvas (a lazy chunk). Notes and groups become React Flow node
  types beside `step`.
- Workflows save through `workflows:save` → `parseWorkflowInput` (`backend/src/core/workflows/workflowInput.ts`), which
  rebuilds the input key by key and refuses only what could trip the engine. Notes and groups must pass through it in
  the same style, or they are silently dropped on save.
- Frontend tests cover only pure modules in `src/state/` and `src/net/`. Logic goes there: note and group edits, the
  group rules, the clipboard format, the history, the key map and arrow navigation.
- `sync.mjs` treats `workflows.json` and `workflow-runs.json` newest-wins as whole files, so notes and groups need no
  sync work.

## Data model

```ts
// shared/src/workflows.ts
export type NoteColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | `#${string}`   // a preset, or a custom '#rrggbb' (lower case)
export interface Note { id: string; x: number; y: number; width: number; height: number; color: NoteColor; text: string }
export interface CanvasGroup { id: string; name: string; description?: string; steps: string[]; notes: string[] }

export interface Workflow { /* … as today … */ notes?: Note[]; groups?: CanvasGroup[] }   // absent in older workflows
export type WorkflowInput = Pick<Workflow, 'name' | 'enabled' | 'timeZone' | 'trigger' | 'steps' | 'edges'>
  & { id: string | null; notes: Note[]; groups: CanvasGroup[] }                            // the editor always sends both
export interface WorkflowRun {
  /* … */ snapshot: { steps: Step[]; edges: Edge[]; notes?: Note[]; groups?: CanvasGroup[] }
}

export const notesOf = (w: { notes?: Note[] }): Note[] => w.notes ?? []
export const groupsOf = (w: { groups?: CanvasGroup[] }): CanvasGroup[] => w.groups ?? []
export const NOTE_TEXT_MAX = 10_000
export const NOTES_MAX = 100
export const NOTE_MIN = { width: 150, height: 80 }
export const NOTE_MAX_SIDE = 5_000
export const NOTE_DEFAULT = { width: 240, height: 160, color: 1 as NoteColor, text: '## Note\nDouble-click to edit.' }
export const GROUP_NAME_MAX = 100
export const GROUP_DESCRIPTION_MAX = 145   // n8n's cap
export const GROUPS_MAX = 50
```

- A group's members are lists of ids. Its box on the canvas is **derived** from where its members are (their bounding
  box plus padding and a header), never stored. So moving the members moves the box, and moving some of them resizes
  it, which is exactly n8n's behavior.
- **Validation** (`parseWorkflowInput`): `notes` and `groups` absent are read as `[]`, so an older client still saves.
  - Each **note** is rebuilt key by key. `id` must pass `validId` and be unique among steps, notes *and* groups (React
    Flow shares one id space). `x`/`y` are finite. `width`/`height` are finite and clamped into
    `NOTE_MIN`…`NOTE_MAX_SIDE`. `color` is 1–7 or `#` plus 6 hex digits (stored lower case). `text` is at most
    `NOTE_TEXT_MAX`. There are at most `NOTES_MAX` notes.
  - Each **group** is rebuilt key by key. `id` is valid and unique as above. `name` is 1 to `GROUP_NAME_MAX`
    characters after trimming. `description` is optional, at most `GROUP_DESCRIPTION_MAX`. `steps` and `notes` name
    existing steps and notes. No id is a member of two groups, and no group holds the trigger. There are at most
    `GROUPS_MAX` groups.
  - Anything else is `Invalid workflow`.
  - The **chain rules** (see Groups) are *not* a refusal. A group that breaks them is dropped by the server on save
    (`dropBrokenGroups`, pure, in `shared/src/workflowGroups.ts`), as n8n does. The editor drops them first and says
    so, so the server's drop only matters for an odd client.
- **Save** (`workflows:save`) stores `notes` and `groups` with the other fields. **Duplicate** already spreads the
  source, so the copy carries both; check it in a test.
- **Run snapshot**: `WorkflowRunner` copies `notesOf(w)` and `groupsOf(w)` into the snapshot when a run starts. The
  engine ignores them. Runs stored before have none, and their view shows no notes or groups.
- `toInput` (frontend) sets `notes: notesOf(w)` and `groups: groupsOf(w)`. The editor's `dirty` check (canonical JSON)
  then covers them.
- **Preset colors** are tokens in `styles.css` (`--note-1` … `--note-7` for the fill, plus a border shade each),
  defined for light and dark. The order follows n8n's presets: yellow, orange, red, purple, blue, green, gray. *My
  call*.

## Notes

- **Stacking**: notes are drawn **under every step, edge and group header**, also while selected (React Flow node
  `zIndex` below the steps, with no elevation on select). A note never hides a step or a connector. Among notes, the
  smaller one is on top (by area, then the later in `notes`), so a small reminder inside a phase wrapper stays visible
  and clickable even when the wrapper was drawn after it. There is no "bring to front". *My call*.
- **Content**: the note renders its `text` with the app's `Markdown` component (the chat's renderer: headings, bold,
  lists, links, code, the same sanitizing, no raw HTML). Text longer than the box scrolls inside the note.
  `unicode-bidi: plaintext`, as elsewhere, so Arabic reads right to left.
- **Edit**: double-click the note (or F2 or Enter with it selected, or Edit in its hover bar or right-click menu). The
  note becomes a textarea of its Markdown source over the same box. Click outside or Esc ends editing. An editing
  session is one undo step. While it is open, every key goes to the textarea.
- **Hover bar** (over the note's top-right corner, as in the mockup): Edit, Color, Delete.
- **Color popover**: the 7 preset swatches, then **Custom…**, which opens the browser's color input (`<input
  type="color">`) and a hex field that accepts `#rrggbb` or `rrggbb`. Below the presets are the **recent custom
  colors**, the last 8 picked, kept per device in `localStorage` (`cb.wf.noteColors`, read and written in try/catch,
  and the list works empty), as n8n keeps them. *My call*: per device, since n8n's docs don't say where.
- **A custom color** fills the note as picked in both themes. Its border is that color mixed toward black in the light
  theme and toward white in the dark theme (`color-mix`). The text is dark or light, whichever contrasts more with the
  fill (WCAG relative luminance, a pure `noteInk(hex)`). As in n8n, the fill does not change with the theme.
- **Resize**: from any edge or corner, with React Flow's `NodeResizer`, only while selected. Minimum `NOTE_MIN`, and
  the size snaps to the grid.
- **Move**: a drag that starts anywhere on a note moves the note **only**. Steps on top of it stay put (n8n). To move a
  phase, the user draws a box around the note and its steps (it must enclose the note fully, see Selection), or puts
  them in a group.
- **Add**: Shift+S, the toolbar's note button, or the right-click menu's **Add sticky note**. The note is placed with
  `NOTE_DEFAULT` at the pointer when the pointer is over the canvas (right-click: where it was clicked), else at the
  view's centre. It becomes the selection. It is not opened for editing, as in n8n.
- **Read-only canvas** (a run's view): notes from the run snapshot, with no hover bar, resize, edit or drag.

## Groups

Modelled on n8n's Canvas Groups (n8n 2.28+, docs "Canvas groups").

**Making one.** Select at least two items, one of them a step, by box or Ctrl+click. Then press Ctrl/Cmd+G, or use
**Group** in the right-click menu or in the multi-selection inspector. The group gets a default name ("Group 1", the
next free number) and its name field opens, text selected, so the user types the name straight away. When the
selection does not qualify, Group is disabled and its tooltip (and the inspector) gives the first rule it breaks.

**Rules** (`groupRuleBreak(w, steps, notes)`, pure, in `shared/src/workflowGroups.ts`; each returns a short reason):
1. At least two members, at least one of them a step.
2. No trigger.
3. No member already in another group.
4. The steps form one connected chain: the edges among them, taken in either direction, join them all.
5. Outside steps connect only to the group's first or last step. At most one member step has edges coming in from
   outside (the *entry*), and at most one member step has edges going out to outside (the *exit*). They may be the
   same step. This is what lets a collapsed group show one input and the exit's outputs.

Notes may be members, as n8n allows. They are not part of the chain rules.

**Look, expanded**: a box around its members (their bounds plus 24 px padding and a 36 px header), drawn under the
steps and edges and above notes that are not members. It has a neutral translucent fill and a 1 px border (n8n gives
groups no colors), and it is not itself selectable or draggable (n8n). The header shows a collapse chevron, the name,
and the description in smaller text under it, or a dim **Add description** link when there is none.
- Click the name to rename it inline. Enter or a click outside saves, and Esc cancels. A blank name is refused and
  reverts.
- Click Add description, or the description, to edit it inline, up to 145 characters. Enter saves.
- Click the chevron, or the header elsewhere, to collapse.

**Look, collapsed**: one node about a step's size at the group's top-left. It shows a chevron, the name, an info icon
whose tooltip is the description (when there is one), and "N steps" (plus "· N notes" when there are notes). It has
one input handle when the group has an entry step, and on its right the exit step's ports that have edges going
outside, labelled as on a step. Edges from outside are drawn to and from these handles, and edges among members are
hidden. A collapsed group **can** be selected (click, box) and dragged: a drag moves every member by the same delta.

**Collapse state** is a view preference, as in n8n. It is kept per device in `localStorage` (`cb.wf.collapsed.<workflow
id>`, the collapsed group ids, try/catch, so it works empty), not in the workflow and not in the undo history. A
workflow not yet saved keeps it in memory. The run view starts with every group **expanded**, as n8n's read-only views
do. The user can collapse groups there, and that is not remembered. *My call*.

**Expanding pushes neighbors**, as in n8n. When a group expands and its box would overlap steps, notes or collapsed
groups outside it, those are pushed right just far enough to clear the box plus 40 px. The push cascades, so a pushed
item does not land on another, and items it does not overlap stay put. The push is a normal edit: saved and undoable.
*My call*: to the right, since the flow reads left to right.

**Keeping a group valid.**
- Deleting a member takes it out of the group, and a group left with fewer than two members, or with no step, goes too.
- Inserting a step into an edge between two members (the edge's +) makes the new step a member.
- A step dropped or pasted onto a group's box does *not* join it. To change who is in a group, the user ungroups and
  groups again, as n8n's docs give no other way.
- Any edit can break the chain rules: a new edge from outside into a middle step, or a deleted middle edge. The editor
  checks every group after each edit. A broken group gets a red border and a header warning ("Will be ungrouped on
  save: <reason>"). On save the editor drops it and shows the notice "Ungrouped <name>: <reason>" (several at once:
  "Ungrouped 2 groups: …"). The steps stay where they are.

**Ungroup**: Ctrl/Cmd+Shift+G, or **Ungroup** in the menus and the inspector. It applies to the groups that hold any
selected item or a selected collapsed group. The members stay on the canvas. **Delete group** (right-click menu)
removes the group *and* its members in one undo step. Delete or Backspace on a selected collapsed group does the same.
*My call*: Delete removes what you see.

**Keys**: Ctrl/Cmd+G group, Ctrl/Cmd+Shift+G ungroup, Alt+G expand and Shift+Alt+G collapse the selected groups (a
group counts as selected when any of its members or the collapsed group is picked), or every group when nothing is
selected (n8n's expand-all and collapse-all). F2 renames the selected group. n8n's Space-to-rename is left out,
because Space is held to pan. *My call*.

**Inspector**: a selected collapsed group shows a group panel with its name and description fields, "N steps · N
notes", and **Expand**, **Ungroup** and **Delete group**. The multi-selection panel ("N items selected") gains
**Group** (disabled with the reason when the selection breaks a rule) and, when the picked items belong to a group,
**Ungroup**.

**Run view**: groups from the run snapshot, starting expanded. A collapsed group shows one state mark for its steps:
failed if any visit failed, else waiting or paused, else running, else done once every member step that ran is done,
else none. n8n shows an error on a collapsed group the same way. A click on a collapsed group in a run expands it.

## Selection

`Selection` (`state/workflowEditor.ts`) grows to hold notes and collapsed groups:

```ts
export type Selection =
  | { kind: 'step' | 'edge' | 'note' | 'group'; id: string }            // 'group': a collapsed group
  | { kind: 'items'; steps: string[]; notes: string[]; groups: string[] } // replaces { kind: 'steps', ids }
```

- One step → the step inspector, as today. One note → the inspector shows the workflow overview, as with nothing
  selected (notes have no panel in n8n either). One collapsed group → the group panel. Several items →
  `GroupInspector`, "N items selected", with Delete (the trigger aside), Group and Ungroup.
- Delete/Backspace removes the selected notes, steps and collapsed groups (with their members). Ctrl+A picks every
  step, note and collapsed group.
- The selection box picks items it **fully** encloses (`SelectionMode.Full`, React Flow's default). A box drawn inside
  a wrapper note must therefore start on empty canvas, as in n8n. A box around an expanded group picks its members,
  and dragging them moves the group (its box follows).
- `applySelect`, `selectedSteps`, `groupSteps` and `sameSelection` are reworked for the new shape. After an undo or a
  redo, items that no longer exist drop out of the selection.

## Mouse (editor canvas)

| Action | Does | Today |
|---|---|---|
| Left drag on empty canvas (Shift too) | Selection box | plain drag pans; Shift drag boxes |
| Ctrl/Cmd + left drag, middle drag, Space + left drag | Pan (grab cursor) | – |
| Wheel / Shift + wheel; two-finger trackpad scroll | Scroll the view vertically / sideways | wheel zooms |
| Ctrl/Cmd + wheel, trackpad pinch | Zoom at the pointer | – |
| Click / Ctrl+click an item | Select / add or remove it | same (now notes and groups too) |
| Drag a step, a selection, or a collapsed group | Move (snaps to a 20 px grid) | same, no snap |
| Drag a note | Moves the note only | – |
| Double-click a step | Select it and open the inspector at its first field | – |
| Double-click a note | Edit it | – |
| Click a group's name / chevron | Rename / collapse or expand | – |
| Right-click | Context menu | – |

These are n8n's own settings (Vue Flow in `Canvas.vue`): `pan-on-scroll`, `pan-on-drag` on the middle button,
`pan-activation-key-code` and `zoom-activation-key-code` set to Space or Ctrl, a selection box on a plain drag, and
`snap-to-grid`. In React Flow terms: `selectionOnDrag`, `panOnDrag={[1]}` (plus left while Space or Ctrl is held, or
in Pan mode), `panOnScroll`, `zoomActivationKeyCode` (Ctrl, Meta), `snapToGrid` with a `[20, 20]` grid (matching the
dot background). Zoom range 0.1–4. *My call*: n8n allows 0–4, and today's 0.2–2 is too tight for a wide workflow of
notes. Snapping applies to an item when it is moved; existing positions are not changed on load.

**Touch** (a tablet, since a phone gets no canvas): one-finger drag pans, pinch zooms, and a box needs Shift, as n8n
does on touch. *My call*.

## Keys (editor canvas)

Never while typing (`isTypingTarget`, which already covers inputs, textareas and contenteditable), never while a
dialog is open, and, except Ctrl+S, only when focus is in the editor (the rule today's `keyAction` already follows).

| Key | Does |
|---|---|
| `+` / `=`, `-` / `_` | Zoom in, out |
| `0` | Zoom to 100% |
| `1` | Fit the workflow in view |
| Shift+S | Add a sticky note |
| N | Open the Add step menu |
| Ctrl/Cmd+C, X, V | Copy, cut, paste the selection (see Clipboard) |
| Ctrl/Cmd+D | Duplicate the selection |
| Ctrl/Cmd+Z; Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y | Undo; redo |
| Ctrl/Cmd+G; Ctrl/Cmd+Shift+G | Group; ungroup |
| Alt+G; Shift+Alt+G | Expand; collapse (selected groups, else all) |
| Arrow Right / Left | Select the next step downstream / upstream along an edge |
| Arrow Up / Down | Select the sibling step above / below (same upstream step, by y) |
| Shift+Arrow Right / Left | Add every step downstream / upstream to the selection |
| F2 | Rename: the step's name field (text selected), the note's editor, the group's name |
| Enter | Open: the step's inspector at its first field; edit the note; expand a selected collapsed group |
| Space (held) | Pan with a left drag |
| H | Toggle Pan mode (see Toolbar) |
| Ctrl/Cmd+Enter | Run workflow (the same button and checks as the header's) |
| Delete / Backspace, Esc, Ctrl/Cmd+A, Ctrl/Cmd+S | As today, now with notes and groups |

`keyAction` in `state/workflowEditor.ts` grows to return these actions. Arrow navigation is a pure function over steps
and edges (`state/workflowNav.ts`). With nothing selected, the arrows select the trigger. With several items selected,
they move from the last picked step. With only notes, an edge or a collapsed group selected, they do nothing. A step
hidden in a collapsed group is never selected by an arrow: the arrow selects the collapsed group instead. *My call*.

## Toolbar, zoom buttons and right-click menu

- **Bottom toolbar**, centred and floating, as in the mockup: **Select** (the default mode), **Pan** (the hand, H: a
  left drag pans, n8n's panning mode), a divider, **Sticky note** (Shift+S), a divider, **+ Add step** (N). The Add
  step button moves here from the top-left panel and keeps `data-testid="wf-add"`. Each button's tooltip names its
  shortcut.
- **Zoom buttons** stay bottom-left (React Flow `Controls`): fit, zoom in, zoom out, plus a **reset zoom** button that
  the editor adds.
- **Right-click menu**, a small menu at the pointer (the app's `menu` class), closed by Esc, a click outside or a
  pick. Each item shows its shortcut on the right.
  - *On a step*: Open (Enter), Rename (F2), Copy, Cut, Duplicate, Group/Ungroup, Delete. Copy, Cut and Delete are
    disabled for the trigger alone.
  - *On a note*: Edit (Enter), Color ▸, Copy, Cut, Duplicate, Group/Ungroup, Delete.
  - *On a group header or a collapsed group*: Rename (F2), Edit description, Collapse/Expand (Shift+Alt+G / Alt+G),
    Select its items, Copy group, Ungroup (Ctrl+Shift+G), Delete group.
  - *On a multi-selection*: Copy, Cut, Duplicate, Group (Ctrl+G) or Ungroup, Delete. A right-click on an unselected
    item first selects that item alone, as in n8n.
  - *On empty canvas*: Add step (N), Add sticky note (Shift+S), Paste (Ctrl+V), Select all (Ctrl+A), Expand all /
    Collapse all groups, Fit view (1). Add step and Add sticky note place their item where the menu was opened.
- Read-only canvas: no toolbar buttons except the zoom buttons, and no right-click menu.

## Clipboard

- **Format**: JSON text `{"zumibot": "workflow-clip", "v": 1, "steps": [...], "edges": [...], "notes": [...],
  "groups": [...]}`. It holds the selected steps (the trigger always left out), the edges *between* them, the selected
  notes, and every group all of whose members are copied (a collapsed group counts as all its members). Copy and cut
  write it through the document `copy`/`cut` events (`clipboardData.setData('text/plain', …)`). Paste reads it from
  the `paste` event, so no clipboard permission prompt ever shows, in a browser or the desktop shell.
- **Paste** parses with the same rules as `parseWorkflowInput` (a pure `parseClip` in `state/workflowClipboard.ts`).
  Text that is not a valid clip is ignored, with no error and no change.
  - Every pasted item gets a new id. Every step gets a handle unique in the target workflow (the `setHandle`/`handleFor`
    rules). Groups keep their name and description.
  - `{{steps.<old>.output}}` inside a pasted step's template fields that names *another pasted step* is rewritten to
    that step's new handle. One that names a step not pasted is left as written, and `problemsOf` flags it if no such
    handle exists in the target.
  - Positions keep their layout, moved so the pasted items' top-left lands at the pointer when the pointer is over the
    canvas, else 40 px right and down of the copied items.
  - The pasted items become the selection. A paste is one undo step.
  - A paste that would pass `NOTES_MAX` or `GROUPS_MAX` adds nothing and shows the editor's error notice ("A workflow
    holds at most 100 notes"). *My call*.
- **Copy group** (menu) copies the group's members and the group.
- **Duplicate** (Ctrl/Cmd+D, menus) is copy and paste at +40/+40 without touching the system clipboard.
- **Cut** is copy, then delete the selection (one undo step).
- **Between workflows**: copy in one workflow and paste into another works, in the same tab or another. Agent steps
  keep their agent, folder and model, and `problemsOf` flags anything the target cannot run.

## Undo and redo

- The editor keeps a history of drafts (`state/workflowHistory.ts`, pure): each `edit()` pushes the draft it replaced,
  up to 100 entries. Redo clears on any new edit.
- **What it covers**: steps, edges, notes, groups, trigger, name and time zone. Never `enabled`, which a switch
  applies, never the id, and never collapse state (a view preference). Undo and redo restore those fields and keep
  the current `enabled`.
- **Coalescing**: consecutive edits that come from the same text field (same step, note or group id, same field)
  within 1 second of each other are one entry. A drag is one entry (it is already one `moveSteps` edit), as is a
  resize, a note editing session, and an expand together with its push.
- Lives for the editor's mount. Save does not clear it, so an undo after a save makes the draft dirty again. Discard
  changes clears it. Opening another workflow starts a new history. The ungrouping a save does is not undoable (the
  saved draft is the new base, as after Discard).
- Ctrl+Z goes to the history only when focus is not in a field (see the anti-goals).

## Testing

- **Shared/backend (vitest)**:
  - `parseWorkflowInput` with notes and groups: absent → `[]`, a bad or custom color, non-finite values, oversize
    clamped, a duplicate id across steps, notes and groups, too many, text, name and description over their caps, a
    member twice, the trigger as a member, an unknown member.
  - `groupRuleBreak` and `dropBrokenGroups` for each rule, with loops, Condition branches and an entry that is also
    the exit.
  - `workflows:save` keeps notes and groups and drops broken groups. `workflows:duplicate` copies them. A run's
    snapshot carries them. `problemsOf` ignores them.
- **Frontend pure modules (vitest)**:
  - Edits: add, move, resize with clamp and snap, color (preset and custom), text, remove, and `removeItems` with
    members leaving their groups.
  - Groups: create with a default name, ungroup, delete group, the derived box, the collapsed node's handles,
    expand-push (cascade, nothing moved that does not overlap), insert into an inner edge.
  - `noteInk` contrast, and selection (`applySelect` and friends with notes and groups).
  - `keyAction` for every key above, including "never while typing".
  - Arrow navigation (`workflowNav`).
  - Clipboard: round trip, the trigger left out, edges kept only between pasted steps, groups kept only when whole,
    new ids, unique handles, template rewrite, offset, garbage ignored.
  - History: push, cap, coalesce by field and time, undo and redo keep `enabled`, redo cleared by an edit.
- **e2e (`e2e:workflows`, fake claude, no quota)**:
  - Notes:
    - Shift+S adds a note at the pointer. Double-click, type Markdown, click outside: the heading renders.
    - Pick a preset, then a custom hex color. Resize from the corner. Save and reload: the note is as left.
    - Dragging the note leaves a step on it where it was.
  - Groups:
    - Box two connected steps, press Ctrl+G and type a name. Collapse it: one node, edges into and out of it.
    - Drag the collapsed group: both steps move. Reload: still collapsed (`localStorage`).
    - Expand next to a step: the step is pushed right.
    - Add an edge from outside into a middle step, then save: the "Ungrouped" notice shows and the group is gone.
    - Ctrl+Shift+G ungroups.
  - Mouse and keys:
    - A left drag on empty canvas boxes two steps and a note, and dragging one moves all three.
    - Ctrl+drag pans (the viewport transform changes, nothing is selected). The wheel pans. Ctrl+wheel zooms.
    - Ctrl+Z restores a deleted step, and Ctrl+Shift+Z deletes it again.
  - Copy a group of two connected steps and paste it into a second workflow: new handles, the edge and the group kept.
  - A run started after adding the note and the group shows both in the run view, the group expanded.
  - The existing group tests (Shift box, Ctrl-click, Ctrl+A, Esc, Delete) still pass. The "a plain drag still pans"
    check becomes "a plain drag boxes".

## Order of work

Three parts, each usable on its own, built and tested in this order on one branch:

1. **The canvas controls**: mouse, keys, toolbar, right-click menu, the history and the clipboard, steps only.
2. **Sticky notes**: they extend the selection, clipboard and history from part 1.
3. **Groups**: they need both earlier parts.

*My call*: the controls come first because notes and groups are driven through them.

## Docs

Update the **Workflows** paragraph in `CLAUDE.md` (notes and groups in the data and the run snapshot, the group rules
and the ungroup on save, the canvas controls, the clipboard, the history) and the `e2e:workflows` line in Commands.

## Left to the builder

- The exact z-index settings in React Flow 12 that put notes under group boxes, group boxes under edges, and edges
  under steps.
- How the hover bar, color popover, group header and collapsed node are drawn, matching the mockup and the app's
  existing menus and steps.
- The expand-push algorithm's details within the rule above.
- The test ids for the new controls (`wf-note`, `wf-note-edit`, `wf-group`, `wf-group-collapsed`, `wf-tool-select`,
  `wf-tool-pan`, `wf-tool-note`, `wf-ctx-menu` are suggestions).
- How to split each part into commits.
