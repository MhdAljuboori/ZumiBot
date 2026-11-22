import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { styleFile, styleFiles } from './stylesheet'

describe('src/styles', () => {
  it('imports every area file exactly once, so none is left out of the build', () => {
    const onDisk = readdirSync(new URL('../src/styles/', import.meta.url))
      .filter((f) => f.endsWith('.css') && f !== 'index.css')
      .sort()
    const imported = styleFiles()
    expect(new Set(imported).size).toBe(imported.length)
    expect([...imported].sort()).toEqual(onDisk)
  })

  it('starts with the palette, which every other file reads', () => {
    expect(styleFiles()[0]).toBe('tokens.css')
  })

  it('opens each file with a line saying what it holds', () => {
    for (const f of styleFiles()) expect(styleFile(f), f).toMatch(/^\/\* \S/)
  })
})
