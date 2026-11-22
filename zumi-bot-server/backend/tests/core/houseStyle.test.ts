import { describe, expect, it } from 'vitest'
import { HOUSE_STYLE } from '../../src/core/chat/houseStyle'

describe('HOUSE_STYLE question layout', () => {
  const lines = HOUSE_STYLE.split('\n')
  const start = lines.findIndex((l) => l.includes('AskUserQuestion') && l.endsWith(':'))
  const rules = start === -1 ? [] : lines.slice(start + 1).filter((l) => l.startsWith('- '))

  it('has its own section of layout rules for AskUserQuestion', () => {
    expect(start).toBeGreaterThan(-1)
    expect(rules.length).toBeGreaterThanOrEqual(5)
  })

  // An agent's template otherwise wins over the house rules, and the skills that ask the longest questions have one.
  it('applies to a question even when the agent instructions give it a template, changing layout only', () => {
    expect(lines[0]).toMatch(/question layout rules .*exception/i)
    expect(lines[start]).toMatch(/template/i)
    expect(lines[start]).toMatch(/keep its words, facts and order/i)
  })

  it('asks for paragraphs, bold labels, code spans, lists and the question on its own line', () => {
    const text = rules.join('\n')
    expect(text).toMatch(/blank line between parts/i)
    expect(text).toMatch(/bold label/i)
    expect(text).toMatch(/backticks/i)
    expect(text).toMatch(/bulleted list/i)
    expect(text).toMatch(/question itself, alone on its own line/i)
  })
})
