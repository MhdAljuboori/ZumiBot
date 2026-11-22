// Agent-supplied text is shown where a reader must judge it (approval cards, tool rows). Characters nobody can see, or that
// reorder what is read, are shown as escapes instead: controls, format and default-ignorable characters (bidi controls,
// zero-width and tag characters, variation selectors, fillers), line and paragraph separators, lone surrogates. U+FE0F
// (emoji presentation) stays, so emoji read normally.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{DI}\p{Cs}]/gu
const EMOJI_PRESENTATION = 0xfe0f

/**
 * Each hidden character as `\u{hex}`. A typed `\u{202e}` reads the same as an escaped one; the Input panel
 * (`visibleJson`) tells them apart, since JSON doubles a typed backslash.
 */
export function visibleText(v: string): string {
  return v.replace(HIDDEN, (c) => (c.codePointAt(0) === EMOJI_PRESENTATION ? c : `\\u{${c.codePointAt(0)!.toString(16)}}`))
}

/**
 * `JSON.stringify(value, null, 2)` with every hidden character as a JSON escape (`\uXXXX`, a surrogate pair past the BMP),
 * so it is still valid JSON. Outside strings JSON holds only its own indentation, whose newlines stay.
 */
export function visibleJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2) as string | undefined
  if (text === undefined) return ''
  return text.replace(HIDDEN, (c) => {
    const code = c.codePointAt(0)
    if (code === 0x0a || code === EMOJI_PRESENTATION) return c
    let out = ''
    for (let i = 0; i < c.length; i++) out += `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`
    return out
  })
}

/** `visibleText` that keeps line breaks, for text shown as the lines it would send (a message body in an approval card). */
export function visibleLines(v: string): string {
  return v.split('\n').map(visibleText).join('\n')
}
