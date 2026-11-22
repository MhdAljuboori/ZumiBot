# App tooltips instead of native `title`

## Why

The browser's native `title` popup is a plain system box: wrong font, no theme, no wrapping control, a long delay, and it
cannot be styled (see the long agent description over the sidebar). The UI should show its own tooltip everywhere and
never use the `title` attribute.

## Goals

- One tooltip look for the whole UI (browser, desktop shell, island), in both themes.
- No `title` attribute and no SVG `<title>` in our code; a test keeps it that way.
- Third-party `title`s (React Flow's zoom buttons, markdown link titles) show the app tooltip too.
- Tips on disabled buttons (the reason they cannot act) keep working.
- Keyboard users see the tip on focus; screen readers keep every name they had.

## Non-goals

- Rich content (links, markup) in tooltips: tips stay plain text, as the titles were.
- Touch: no tooltip on touch screens, as today.

## Approaches

1. **Global layer + `data-tip` attribute (picked).** One `TooltipLayer` mounted once listens to hover and focus on the
   document, finds the nearest `[data-tip]`, and draws one floating bubble. Migration is a rename (`title=` →
   `data-tip=`). No wrapper elements, so flex and ellipsis layouts stay as they are; no new dependency; works for
   elements in portals and SVG.
2. **`<Tooltip>` wrapper per element.** React-idiomatic, but ~250 wrappers, ref plumbing through components, and real
   risk of breaking truncated rows.
3. **A library (Floating UI, Radix).** Same wrapping cost as 2 plus a new dependency.

## Design

- **Markup.** Any element takes `data-tip="text"`. An icon-only control whose `title` was its only accessible name gets
  an `aria-label` with the same text.
- **Layer.** `TooltipLayer.tsx`, mounted once in `main.tsx` beside the app, rendering into `document.body`. Pointer
  over/out, focus in/out (keyboard focus only, `:focus-visible`), Esc, scroll, pointer down, blur and resize drive it.
  Pure rules (which element, placement, warm-up timing) live in `src/state/tooltip.ts` with unit tests.
- **Placement.** Centered above the target, 6 px gap; below when it would leave the top; clamped 8 px inside the
  window horizontally.
- **Timing.** First show after 500 ms. While a tip is open, or within 300 ms after one closed, the next shows at once.
- **Truncation.** A tip whose text equals the element's own text shows only while the text is cut off
  (`scrollWidth > clientWidth`).
- **Third-party titles.** On hover or focus, an element with a `title` and no `data-tip` has it moved to `data-tip`
  before the native popup can show.
- **Accessibility.** The bubble is `role="tooltip"` with an id; the target gets `aria-describedby` while it shows,
  unless the tip only repeats the target's name.
- **Look.** `--bg-raised`, `1px --border`, `--shadow-pop`, 8 px radius, 12 px text, max 320 px wide, wraps, keeps line
  breaks. Not interactive (`pointer-events: none`).
- **Guard.** A frontend test fails on `title=` on a lowercase JSX element, `title:` in an attribute spread, or an SVG
  `<title>` in `src/**/*.tsx`.

## Left to the builder

- Exact event wiring for disabled buttons (verify pointer events reach them in Chromium; fall back to hit testing if
  not).
- Component props named `title` that end up as a DOM `title` would be renamed to `tip`. (Found none: `AuditText`,
  `VisitText` and the rest pass `title` to a dialog heading, so they stay.)
- E2E suites that read `getAttribute('title')` read `data-tip`.
