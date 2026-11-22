import { describe, expect, it } from 'vitest'
import {
  arabicStem,
  fold,
  foldMap,
  hasPhrases,
  matchRanges,
  parseQuery,
  phraseText,
  plainText,
  snippet,
  textTokens,
  tokensOf,
  SEARCH_QUERY_MAX,
  SEARCH_TERMS_MAX,
  TOKEN_MAX,
  type SearchQuery
} from '@zumibot/shared/search'

const q = (raw: string): SearchQuery => {
  const parsed = parseQuery(raw)
  if (!parsed) throw new Error(`no query in ${raw}`)
  return parsed
}

const marked = (text: string, ranges: Array<[number, number]>): string[] => ranges.map(([a, b]) => text.slice(a, b))

describe('fold', () => {
  it('drops case, accents and compatibility forms', () => {
    expect(fold('Café ÉLAN ﬁle Ｆｕｌｌ')).toBe('cafe elan file full')
    expect(fold('İstanbul')).toBe('istanbul')
  })
  it('folds Arabic as Arabic search does', () => {
    // harakat, tatweel, hamza and madda on alef, alef maqsura and ta marbuta
    expect(fold('مُحَمَّد')).toBe('محمد')
    expect(fold('جـــميل')).toBe('جميل')
    expect(fold('أحمد إسلام آمن')).toBe('احمد اسلام امن')
    expect(fold('مستشفى مدرسة')).toBe('مستشفي مدرسه')
  })
  it('makes Greek final sigma the plain one, as a single letter folds', () => {
    expect(fold('ΟΔΟΣ')).toBe('οδοσ')
    expect(fold('οδος')).toBe('οδοσ')
  })
})

describe('foldMap', () => {
  const samples = [
    'Hello World',
    'Café ÉLAN ﬁle',
    'ΟΔΟΣ οδός',
    'مُحَمَّد جـــميل',
    '東京タワー',
    'emoji 🎉 here',
    'Ｆｕｌｌ ①',
    '한국어',
    'x́y',
    ''
  ]
  it('folds as fold does', () => {
    for (const s of samples) expect(foldMap(s).folded).toBe(fold(s))
  })
  it('maps every folded unit back to where it came from', () => {
    const { folded, at } = foldMap('aﬁB🎉ç')
    expect(folded).toBe('afib🎉c')
    expect(at).toEqual([0, 1, 1, 2, 3, 3, 5, 6])
  })
})

describe('tokensOf', () => {
  it('splits on anything but letters and digits', () => {
    expect(tokensOf(fold('Deploy the v8.6.5 build_script, now!'))).toEqual(['deploy', 'the', 'v8', '6', '5', 'build', 'script', 'now'])
  })
  it('makes each CJK character a token', () => {
    expect(tokensOf(fold('東京タワー to 大阪'))).toEqual(['東', '京', 'タ', 'ワ', 'ー', 'to', '大', '阪'])
  })
  it('cuts long runs', () => {
    expect(tokensOf('a'.repeat(100))).toEqual(['a'.repeat(TOKEN_MAX)])
  })
  it('textTokens folds and keeps each token once', () => {
    expect([...textTokens('Go go GO, Café')]).toEqual(['go', 'cafe'])
  })
  it('textTokens also keeps an Arabic word without its article or particle', () => {
    expect([...textTokens('المستشفى والكتاب للبيت ورد وطن')]).toEqual([
      'المستشفي',
      'مستشفي',
      'والكتاب',
      'كتاب',
      'للبيت',
      'بيت',
      'ورد',
      'وطن'
    ])
    expect(arabicStem('ال')).toBeNull()
  })
})

describe('parseQuery', () => {
  it('is null without a word', () => {
    expect(parseQuery('')).toBeNull()
    expect(parseQuery('  -- ,, ""')).toBeNull()
  })
  it('matches longer words by prefix and one letter whole', () => {
    expect(q('Deplo x')).toEqual({
      terms: [
        { token: 'deplo', prefix: true },
        { token: 'x', prefix: false }
      ],
      phrases: []
    })
  })
  it('keeps a quoted word whole', () => {
    expect(q('"deploy"').terms).toEqual([{ token: 'deploy', prefix: false }])
    // the exact use wins when a word is typed both ways
    expect(q('deploy "deploy"').terms).toEqual([{ token: 'deploy', prefix: false }])
  })
  it('checks a quoted phrase and a joined chunk as typed', () => {
    expect(q('"Fix  the Build" v8.6.5 (deploy),')).toEqual({
      terms: ['fix', 'the', 'build', 'v8', '6', '5', 'deploy'].map((token) => ({ token, prefix: token.length >= 2 })),
      phrases: [
        { text: 'fix the build', whole: true },
        { text: 'v8.6.5', whole: false }
      ]
    })
  })
  it('reads an unclosed quote as a phrase being typed', () => {
    expect(q('"fix the bu').phrases).toEqual([{ text: 'fix the bu', whole: false }])
    expect(q('"depl').terms).toEqual([{ token: 'depl', prefix: true }])
  })
  it('makes a CJK run a phrase of single characters', () => {
    expect(q('東京')).toEqual({
      terms: [
        { token: '東', prefix: false },
        { token: '京', prefix: false }
      ],
      phrases: [{ text: '東京', whole: false }]
    })
  })
  it('caps the words and the query', () => {
    expect(q(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')).terms).toHaveLength(SEARCH_TERMS_MAX)
    expect(q('a'.repeat(SEARCH_QUERY_MAX) + ' zebra').terms).toEqual([{ token: 'a'.repeat(TOKEN_MAX), prefix: true }])
  })
})

describe('hasPhrases', () => {
  it('reads phrases across folded case, accents and spacing', () => {
    expect(hasPhrases(phraseText('Please FIX\n  the  build.'), q('"fix the build"'))).toBe(true)
    expect(hasPhrases(phraseText('the build, fix it'), q('"fix the build"'))).toBe(false)
    expect(hasPhrases(phraseText('anything'), q('words only'))).toBe(true)
  })
  it('starts a phrase at a word, and ends a closed one at a word', () => {
    expect(hasPhrases(phraseText('prefix the build'), q('"fix the build"'))).toBe(false)
    expect(hasPhrases(phraseText('the builder'), q('"the build"'))).toBe(false)
    expect(hasPhrases(phraseText('the builder'), q('"the build'))).toBe(true)
    expect(hasPhrases(phraseText('see v8.6.50'), q('v8.6.5'))).toBe(true)
    expect(hasPhrases(phraseText('明日は東京へ'), q('東京'))).toBe(true)
  })
})

describe('matchRanges', () => {
  it('marks word starts only, in the original text', () => {
    const text = 'Redeploy? No: DEPLOYMENT and deploy.'
    expect(marked(text, matchRanges(text, q('deploy')))).toEqual(['DEPLOY', 'deploy'])
  })
  it('marks whole words for a short or quoted word', () => {
    const text = 'a cat at a catalog'
    expect(marked(text, matchRanges(text, q('a')))).toEqual(['a', 'a'])
    expect(marked(text, matchRanges(text, q('"cat"')))).toEqual(['cat'])
  })
  it('maps folded matches back over accents and ligatures', () => {
    const text = 'Le café ﬁnal'
    expect(marked(text, matchRanges(text, q('cafe fin')))).toEqual(['café', 'ﬁn'])
  })
  it('marks a phrase across a line break, merged with its words', () => {
    const text = 'Run the\n  build now'
    expect(matchRanges(text, q('"the build"'))).toEqual([[4, 15]])
  })
  it('marks CJK characters anywhere', () => {
    const text = '明日は東京へ'
    expect(marked(text, matchRanges(text, q('東京')))).toEqual(['東京'])
  })
  it('marks Arabic across its diacritics', () => {
    const text = 'اسمي مُحَمَّد'
    expect(marked(text, matchRanges(text, q('محمد')))).toEqual(['مُحَمَّد'])
  })
  it('marks an Arabic word after its article or particle, not inside a word', () => {
    const text = 'في المستشفى وللمستشفى ورد'
    expect(marked(text, matchRanges(text, q('مستشفى')))).toEqual(['مستشفى', 'مستشفى'])
    // و keeps at least three letters: ورد is a word of its own, not و + رد
    expect(marked(text, matchRanges(text, q('رد')))).toEqual([])
  })
})

describe('plainText', () => {
  it('drops Markdown marks and keeps the words in order', () => {
    expect(
      plainText('## The **Zephyrine** `relay`\n> see [the docs](https://x.y/z "t") and ![a chart](c.png)\n```ts\nconst snake_case = 1\n```')
    ).toBe('The Zephyrine relay\nsee the docs and a chart\n\nconst snake_case = 1\n')
  })
})

describe('snippet', () => {
  it('shows a short text whole, with its marks', () => {
    expect(snippet('Deploy  the\nbuild', q('build'))).toEqual({ snippet: 'Deploy the build', marks: [[11, 16]] })
  })
  it('opens a window around the first match, at a word', () => {
    const text = `${'lorem ipsum '.repeat(20)}the needle sits here ${'dolor sit '.repeat(30)}`
    const s = snippet(text, q('needle'), 80)
    expect(s.snippet.startsWith('…')).toBe(true)
    expect(s.snippet.endsWith('…')).toBe(true)
    expect(s.snippet.length).toBeLessThanOrEqual(82)
    expect(s.snippet).toMatch(/^…(lorem|ipsum) /)
    expect(s.marks).toHaveLength(1)
    const [a, b] = s.marks[0]
    expect(s.snippet.slice(a, b)).toBe('needle')
  })
  it('falls back to the start when nothing marks', () => {
    expect(snippet('hello world', q('zebra'))).toEqual({ snippet: 'hello world', marks: [] })
  })
  it('never splits a surrogate pair', () => {
    const text = `${'🎉'.repeat(60)} needle`
    const s = snippet(text, q('needle'), 30)
    expect(s.snippet).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
  })
})
