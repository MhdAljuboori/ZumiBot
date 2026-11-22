/**
 * What `browser_computed_style` reads: a fixed list, so an agent can't ask for every property of a page (or a custom one a
 * page stuffs with text). Kept apart from chromiumAdapter.ts so the server can use it without reaching Playwright.
 */
export const COMPUTED_STYLE_PROPS: readonly string[] = Object.freeze([
  'color',
  'background-color',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-align',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'box-shadow',
  'gap',
  'display',
  'width',
  'height'
])
/** The most an agent gets of one value; the worker hands it over SCRUB_MARGIN longer, as page text (browserLimits.ts). */
export const STYLE_VALUE_MAX = 200
