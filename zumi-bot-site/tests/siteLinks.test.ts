import { describe, expect, it } from 'vitest'
import { NAV, SPONSOR_PATH, linkFor } from '../src/siteLinks.ts'

describe('site links', () => {
  it('keeps section anchors in-page on the home page and sends them home from elsewhere', () => {
    expect(linkFor('#download', true)).toBe('#download')
    expect(linkFor('#download', false)).toBe('/#download')
  })

  it('leaves paths and other sites alone', () => {
    expect(linkFor(SPONSOR_PATH, false)).toBe('/sponsor')
    expect(linkFor('https://docs.zumibot.run', false)).toBe('https://docs.zumibot.run')
  })

  it('has only in-page anchors in the section nav', () => {
    expect(NAV.every((n) => n.href.startsWith('#'))).toBe(true)
  })
})
