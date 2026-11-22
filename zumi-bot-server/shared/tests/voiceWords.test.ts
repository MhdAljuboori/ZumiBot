import { describe, expect, it } from 'vitest'
import { ASK_PREFIXES, FILLER_WORDS, normalizeUtterance, stripFillers } from '@zumibot/shared/voiceWords'

describe('normalizeUtterance', () => {
  it('folds alef and drops marks', () => expect(normalizeUtterance('  أَيْوَه؟ ')).toBe('ايوه'))
  it('drops tatweel and folds ya', () => expect(normalizeUtterance('شكـــرا، على')).toBe('شكرا علي'))
  it('lowercases, strips punctuation, joins apostrophes, collapses spaces', () =>
    expect(normalizeUtterance("Don't  STOP,  now!")).toBe('dont stop now'))
  it('keeps digits', () => expect(normalizeUtterance('٤ and 4')).toBe('٤ and 4'))
})

describe('word tables', () => {
  it('are stored already normalized', () => {
    for (const table of [ASK_PREFIXES, FILLER_WORDS]) {
      for (const w of table) expect(normalizeUtterance(w)).toBe(w)
    }
  })
  it('ASK_PREFIXES', () => expect(ASK_PREFIXES).toEqual(['ask', 'tell', 'اسال', 'قل ل', 'قول ل', 'خلي']))
})

describe('stripFillers', () => {
  it('drops fillers with their commas and keeps the capital', () =>
    expect(stripFillers('Um, so, uh, I want to go.')).toBe('So I want to go.'))
  it('moves a dropped end mark onto the word before', () => expect(stripFillers('I want to go, um.')).toBe('I want to go.'))
  it('keeps a question mark the filler carried', () => expect(stripFillers('Is it ready, uh?')).toBe('Is it ready?'))
  it('folds long letter runs before the lookup', () => expect(stripFillers('Ummm hmmm okay')).toBe('Okay'))
  it('cuts Arabic hums of three or more م', () => expect(stripFillers('اممم بدي ممم اجتماع امممم')).toBe('بدي اجتماع'))
  it('leaves a lowercase start lowercase', () => expect(stripFillers('uh so it works')).toBe('so it works'))
  // These mean yes, or are real words: cutting them would change what was said.
  it.each(['اه', 'آه', 'Mhm.', 'Mm-hmm.', 'Uh-huh.', 'umbrella', 'I like it, you know.', 'يعني', 'أم', 'Hummus'])('keeps %s', (t) =>
    expect(stripFillers(t)).toBe(t)
  )
  // Real words that look like hums: an abbreviation, a unit, a name ("Umm Ahmad"), أمم (nations), مِمَّ (from what).
  it.each([
    'Take him to the ER.',
    'A 10 mm bolt',
    'UM is my university.',
    'Send it to Umm Ahmad please.',
    'Call Um Ali tomorrow.',
    'أمم كثيرة',
    'مم تتكون المادة'
  ])('keeps the word in %s', (t) => expect(stripFillers(t)).toBe(t))
  it('still cuts an um before I', () => expect(stripFillers('so um I think')).toBe('so I think'))
  it('capitalises the next word after a dropped sentence-start filler', () =>
    expect(stripFillers('So I went there. Um, and then I left.')).toBe('So I went there. And then I left.'))
  it('drops the comma a mid-sentence filler leaves behind', () => {
    expect(stripFillers('I want to, uh, go home.')).toBe('I want to go home.')
    expect(stripFillers('Is it, um, ready?')).toBe('Is it ready?')
    expect(stripFillers('HM Revenue, uh, called.')).toBe('HM Revenue called.')
  })
  it('keeps line breaks', () => expect(stripFillers('Line one\nUm, line two\n\nPara two')).toBe('Line one\nLine two\n\nPara two'))
  it('never re-cases a mixed-case word', () => {
    expect(stripFillers('Um, iPhone it is')).toBe('iPhone it is')
    expect(stripFillers('Uh, eBay')).toBe('eBay')
  })
  it('cuts uhm with long m runs', () => expect(stripFillers('Uhm, uhmm, uhmmm okay')).toBe('Okay'))
  it('a clip of only fillers is empty', () => {
    expect(stripFillers('Um.')).toBe('')
    expect(stripFillers('Uh, um, hmm.')).toBe('')
  })
  it('empty stays empty', () => expect(stripFillers('')).toBe(''))
  it('collapses the spacing it leaves', () => expect(stripFillers('at  uh  three')).toBe('at three'))
})
