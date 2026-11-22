# Composer Row Fit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The picker row under the message box switches to a compact layout when its own width cannot hold the full row, not only on a phone.

**Architecture:** A pure decision helper (`state/pickerRow.ts`) plus a hook (`useFitRow.ts`) that measures the full row's natural width in a layout effect and watches the row with a ResizeObserver. `ChatView` (single chat and room) and `NewChatView` render their compact layout when `narrow || fit.compact`.

**Tech Stack:** React 19, TypeScript, plain CSS, vitest (node env, pure modules only).

**Spec:** `docs/superpowers/specs/2026-11-19-composer-row-fit-design.md`

## Global Constraints

- No commits (user rule): leave changes in the working tree.
- Test ids unchanged: `chat-agent`, `chat-model`, `chat-mode`, `chat-effort`, `chat-run`, `chat-folder`, `new-chat-*`.
- Phone layout (`useNarrow`) unchanged; the hook is disabled there.
- Comments short, say why.

## Review Focus

- Content change while compact (model picked, branch switched, cost grows): row must re-check whether the full row fits now, without a render loop.
- Sidebar or side panel toggled: compact turns on/off with no visible flash of the other layout.
- Long branch or folder name: compact row still one line; run and git chips ellipsize, the rest keep their size.
- Island popup (`compact` ChatView prop): no row, hook idle.
- Fixed popups (menus) inside the row must not count toward its measured width.

---

### Task 1: Decision helper

**Files:** Create `src/state/pickerRow.ts`; Test `tests/pickerRow.test.ts`

**Interfaces — Produces:** `nextCompact(compact: boolean, need: number | null, available: number): boolean`; `FIT_SLACK = 1`.

- [ ] Tests: full row wider than room → compact (`nextCompact(false, 900, 800) === true`); within 1px → stays full (`nextCompact(false, 800.5, 800) === false`); compact and room still short of the remembered need → stays compact (`nextCompact(true, 900, 850) === true`); room reaches the need → full (`nextCompact(true, 900, 900) === false`); need unknown → try full (`nextCompact(true, null, 300) === false`).
- [ ] Run `npx vitest run --project frontend tests/pickerRow.test.ts`: fails (module missing). Implement. Passes.

### Task 2: `useFitRow` hook

**Files:** Create `src/useFitRow.ts`

**Interfaces — Consumes:** `nextCompact`. **Produces:** `useFitRow(enabled: boolean): { ref: RefObject<HTMLDivElement | null>; compact: boolean }`.

- [ ] ResizeObserver on `ref.current` stores the content-box width (rounded) in state.
- [ ] Layout effect every render (no deps): disabled → reset to full and forget the need. Full mode: when width or `textContent` changed since the last measure, or just switched to full, add class `fit-measure` to the row, need = max right − min left of in-flow children (skip `position: fixed/absolute`), remove the class. Compact mode: a change in the compact row's own text forgets the need (so the full row is tried again). Then `setCompact(nextCompact(...))` when it differs. Compact text and full text are tracked apart so switching layouts never reads as a content change (render loop).

### Task 3: Open chat rows

**Files:** Modify `src/components/ChatView.tsx` (single-chat row, `GroupPickers`); `src/styles/new-chat.css`

- [ ] Single chat: `const fit = useFitRow(!narrow && !compact)`; `short = narrow || fit.compact`. `short` → `RunPicker`; no agent chip. Folder: hidden on a phone (as now), icon-only chip on a wide window when compact (`aria-label`/`title` = `folderTitle(chat)`, `data-testid="chat-folder"`). Row class `pickers one-line` + `compact` when `fit.compact`.
- [ ] Room: same hook; folder icon-only when `fit.compact`.
- [ ] Meter and cost wrapped in `<span className="pickers-end">` in both rows.
- [ ] CSS: `.pickers-end` (flex, gap 4px, `margin-left: auto`, `flex: none`); `.pickers.fit-measure > *` (`flex: none`, `margin-left: 0`); `.pickers.one-line.compact` (nowrap, `overflow-x: auto`, no scrollbar; children `flex: none` except `.run-picker`, `.git-chip`).

### Task 4: New-chat row

**Files:** Modify `src/components/NewChatView.tsx`

- [ ] `const fit = useFitRow(!narrow)` on its `.pickers` div; `RunPicker` when `narrow || fit.compact`. Agent and folder pickers unchanged.

### Task 5: Verify and document

- [ ] `npm run typecheck`, `npx vitest run --project frontend` pass.
- [ ] `npm run build:server`, then check in a browser: wide window full row; sidebar/side panel open or window ~900px → compact, labels readable; resize back → full.
- [ ] `npm run e2e:commands` passes (uses `chat-agent`, `chat-model`, `new-chat-mode` at the default viewport).
- [ ] Update `docs/architecture/chat-mode-and-effort.md` (UI paragraph) and `docs/architecture/ui.md` (Look paragraph: the row's compact layout).
