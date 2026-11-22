import { describe, expect, it } from 'vitest'
import { plainTodoText, todoLines } from '../src/state/todoLine'

describe('todoLines', () => {
  it('is empty without a touch or with an empty one', () => {
    expect(todoLines(undefined, null)).toEqual({ chip: null, lines: [] })
    expect(todoLines({ added: 0, ticked: [], unticked: [], removed: [] }, null)).toEqual({ chip: null, lines: [] })
  })
  it('counts new to-dos in the chip, singular and plural', () => {
    expect(todoLines({ added: 1, ticked: [], unticked: [], removed: [] }, null).chip).toBe('☑ 1 new to-do')
    expect(todoLines({ added: 4, ticked: [], unticked: [], removed: [] }, null).chip).toBe('☑ 4 new to-dos')
  })
  it('has a line per ticked, unticked and removed text, in that order', () => {
    expect(todoLines({ added: 0, ticked: ['Reply to Morjan', 'Pay'], unticked: ['Call'], removed: ['Reply to Homam'] }, null)).toEqual({
      chip: null,
      lines: ['☑ Ticked: Reply to Morjan', '☑ Ticked: Pay', '☐ Unticked: Call', '✕ Removed: Reply to Homam']
    })
  })
  it('prefixes every line with the member in a room, the chip stays plain', () => {
    expect(todoLines({ added: 2, ticked: ['A'], unticked: [], removed: ['B'] }, 'Ana')).toEqual({
      chip: '☑ 2 new to-dos',
      lines: ['Ana: ☑ Ticked: A', 'Ana: ✕ Removed: B']
    })
  })
  it('shows a markdown item as its plain words', () => {
    expect(
      todoLines({ added: 0, ticked: ['Review [WK-1](https://w.io/r/1) **today**'], unticked: [], removed: ['Run `npm test`'] }, null).lines
    ).toEqual(['☑ Ticked: Review WK-1 today', '✕ Removed: Run npm test'])
  })
})

describe('plainTodoText', () => {
  it("keeps a link's text and drops its target", () => {
    expect(plainTodoText('Reply to [Morjan](https://slack.com/x?a=1&b=2) and [Homam](mailto:h@x.io)')).toBe('Reply to Morjan and Homam')
    expect(plainTodoText('Read [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) now')).toBe('Read Foo now')
    expect(plainTodoText('See [spec](https://x.io/s "The spec")')).toBe('See spec')
    expect(plainTodoText('Logo ![alt text](https://x.io/a.png) here')).toBe('Logo alt text here')
  })
  it('drops bold and code markers, and leaves plain text as it is', () => {
    expect(plainTodoText('**Pay** the `rent` bill')).toBe('Pay the rent bill')
    expect(plainTodoText('Call Homam [maybe] (today)')).toBe('Call Homam [maybe] (today)')
    expect(plainTodoText('a * b and 2*3')).toBe('a * b and 2*3')
  })
})

describe('todoLines on a task card', () => {
  it('names the questions a task agent put on its card, and its review', () => {
    expect(todoLines({ added: 0, ticked: [], unticked: [], removed: [], asked: ['Which\nDB?'], review: true }, null)).toEqual({
      chip: null,
      lines: ['? Asked on the task card: Which DB?', '✓ Marked the task card ready for review']
    })
  })
  it('says which cards the agent commented on', () => {
    expect(todoLines({ added: 0, ticked: [], unticked: [], removed: [], commented: ['Ship it'] }, null).lines).toEqual([
      '💬 Commented on: Ship it'
    ])
  })
})
