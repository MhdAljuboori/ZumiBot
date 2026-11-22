# Composer picker row fits its width (short design)

## Intent

The row under the message box (agent, model, mode, effort, folder, git, context meter, cost) cuts every label to a few
letters once the box gets narrow: a small window, the sidebar or the side panel open. The user wants every chip readable.

## Today

- The compact row (model, mode and effort in one `RunPicker` chip; agent and folder left out) switches on window width
  only (`useNarrow`, under 800 px). A wide window with the sidebar or side panel open keeps the full row and squeezes it.
- The container query at 620 px only drops chip outlines and padding.

## Approaches

- **A. Fit to the box's width (picked).** Measure the row itself; when the full row would cut labels, switch to a compact
  row. Reuses `RunPicker`, fixes the sidebar and side panel cases.
- B. Two rows (settings, status). Plain CSS, but the box is always a line taller when narrow and very narrow still cuts.
- C. Overflow "⋯" menu. Most adaptive, but chips come and go as the width changes and are hard to find.

## Design

- **When.** A hook (`useFitRow`) measures the full row's natural width (children at `flex: none`, read in a layout
  effect, so nothing paints in between) against the row's own width, on resize (ResizeObserver) and when the row's text
  changes. Too wide → compact, remembering the width the full row needed; wide enough again → full. A pure helper in
  `state/` makes the switch decision and gets unit tests. A phone (`useNarrow`) keeps its own layout, unmeasured.
- **Open chat, compact (wide window).** Model, mode and effort become one `RunPicker` chip; the agent chip goes (the
  title row and the "Message <agent>…" placeholder name it); the folder becomes an icon chip, its name in the tooltip;
  the git chip and the run chip shrink to an ellipsis, the rest keep their size; a row still too long scrolls sideways,
  as on a phone.
- **Rooms.** Same rule: the folder chip goes icon-only when compact.
- **Status on the right.** Context meter and cost sit together at the right end of the row in every layout.
- **New-chat screen.** Same measuring; compact merges model, mode and effort into the run chip. Agent and folder keep
  their labels, since they are picked there.
- **Kept.** Test ids stay (`chat-model`/`chat-run` etc. as today); the phone layout is unchanged.

## Non-goals

No overflow menu, no second row, no change to the menus themselves.

## Left to the builder

Exact class names, the measuring tolerance, where the CSS lives (`new-chat.css` / `studio.css` / `phone.css`).
