import { describe, expect, it } from 'vitest'
import { connectorAction, humanizeName, inputFields } from '../src/state/approvalFields'

describe('humanizeName', () => {
  it('reads snake, kebab and camel case as words, with acronyms upper-cased', () => {
    expect(humanizeName('channel_id')).toBe('Channel ID')
    expect(humanizeName('threadTs')).toBe('Thread ts')
    expect(humanizeName('notion-create-pages')).toBe('Notion create pages')
    expect(humanizeName('file_urls')).toBe('File URLs')
    expect(humanizeName('__')).toBe('__')
  })
})

describe('connectorAction', () => {
  it("drops the service's own prefix", () => {
    expect(connectorAction('slack', 'slack_send_message')).toBe('Send message')
    expect(connectorAction('notion', 'notion-create-pages')).toBe('Create pages')
    expect(connectorAction('gmail', 'send_message')).toBe('Send message')
    expect(connectorAction('slack', 'slack_')).toBe('Slack')
  })
  it('escapes hidden characters in the tool name', () => {
    expect(connectorAction('slack', 'slack_send\u202e_message')).toBe('Send\\u{202e} message')
  })
})

describe('inputFields', () => {
  it('lists each top-level field, keeping line breaks in text', () => {
    const f = inputFields({ channel_id: 'U0BD9', message: 'Hi\nthere', count: 2, ok: true, none: null, to: ['a', 'b'] })!
    expect(f.map((x) => [x.label, x.value, x.block])).toEqual([
      ['Channel ID', 'U0BD9', false],
      ['Message', 'Hi\nthere', true],
      ['Count', '2', false],
      ['Ok', 'true', false],
      ['None', 'null', false],
      ['To', '[\n  "a",\n  "b"\n]', true]
    ])
  })
  it('still escapes hidden characters other than line breaks', () => {
    expect(inputFields({ m: 'a‮b\r\nc' })![0]!.value).toBe('a\\u{202e}b\\u{d}\nc')
  })
  // The field view is "the input the user is told to read", like the JSON: a key must not hide or reorder what it says.
  it('escapes hidden characters in field names too, in the label and the hover title', () => {
    const f = inputFields({ 'to\u202e\u200b': 'x' })![0]!
    expect(f.label).toBe('To\\u{202e}\\u{200b}')
    expect(f.title).toBe('to\\u{202e}\\u{200b}')
    expect(f.key).toBe('to\u202e\u200b') // the React key stays the real one
  })
  it('marks long text as a block', () => {
    expect(inputFields({ m: 'x'.repeat(81) })![0]!.block).toBe(true)
  })
  it('gives null for anything but a non-empty plain object', () => {
    for (const v of [null, undefined, 'x', 3, [], [1], {}]) expect(inputFields(v)).toBeNull()
  })
})
