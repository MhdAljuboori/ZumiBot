import { expect, test } from 'vitest'
import {
  indexLinkable,
  capNote,
  checkMemoryInput,
  effectiveLimit,
  indexLine,
  isMemoryFileName,
  memoryFull,
  memoryLineText,
  MEMORY_CHANGED,
  type MemoryInput,
  newMemoryFile,
  parseIndex,
  parseMemoryFile,
  serializeNewMemory,
  updateMemoryFile
} from '@zumibot/shared/memory'

const input = (o: Record<string, unknown> = {}): MemoryInput =>
  ({ title: 'T', description: 'd', type: null, body: 'b', ...o }) as MemoryInput

test('parseMemoryFile reads metadata.type and plain type', () => {
  const a = parseMemoryFile('a.md', '---\nname: n\ndescription: d\nmetadata:\n  type: user\n---\n\nbody\n')
  expect(a).toEqual({ name: 'n', description: 'd', type: 'user', body: 'body' })
  expect(parseMemoryFile('a.md', '---\nname: n\ntype: feedback\n---\nx').type).toBe('feedback')
  expect(parseMemoryFile('a.md', '---\nname: n\ntype: preference\n---\nx').type).toBe('preference')
})

test('parseMemoryFile falls back without frontmatter or on broken YAML', () => {
  expect(parseMemoryFile('user_x.md', 'just text')).toEqual({ name: 'user_x', description: '', type: null, body: 'just text' })
  const broken = '---\nname: [oops\n---\nbody'
  expect(parseMemoryFile('b.md', broken)).toEqual({ name: 'b', description: '', type: null, body: broken })
})

test('parseMemoryFile keeps CRLF inside the body', () => {
  expect(parseMemoryFile('a.md', '---\r\nname: n\r\n---\r\nl1\r\nl2\r\n').body).toBe('l1\r\nl2')
})

test('parseIndex keys by file, first line wins, lines are 1-based', () => {
  const m = parseIndex('# Notes\n- [Teal](user_colour.md) — likes teal\n\n- [X](a.md)\n- [Dup](a.md)\n')
  expect(m.get('a.md')).toEqual({ title: 'X', line: 4 })
  expect(m.get('user_colour.md')).toEqual({ title: 'Teal', line: 2 })
  expect(m.size).toBe(2)
  expect(parseIndex('- [A](a.md) - hook\n').get('a.md')?.title).toBe('A')
})

test('indexLine escapes the title and round-trips', () => {
  const line = indexLine('A [b](c)', 'f.md', 'd')
  expect(line).toBe('- [A \\[b\\]\\(c\\)](f.md) — d')
  expect(parseIndex(line).get('f.md')?.title).toBe('A [b](c)')
  expect(indexLine('T', 'f.md', '')).toBe('- [T](f.md)')
})

test('newMemoryFile builds file and name from the slug', () => {
  expect(newMemoryFile('feedback', 'Never commit — without asking!', new Set())).toEqual({
    file: 'feedback_never_commit_without_asking.md',
    name: 'never-commit-without-asking'
  })
  expect(newMemoryFile(null, 'Hi', new Set()).file).toBe('other_hi.md')
  expect(newMemoryFile('weird', 'Hi', new Set()).file).toBe('other_hi.md')
  expect(newMemoryFile('user', '!!!', new Set())).toEqual({ file: 'user_memory.md', name: 'memory' })
  expect(newMemoryFile('user', 'a'.repeat(60), new Set()).name).toBe('a'.repeat(48))
  expect(newMemoryFile('user', `${'a'.repeat(47)} b`, new Set()).name).toBe('a'.repeat(47))
  expect(newMemoryFile('user', 'x', new Set(['user_x.md'])).file).toBe('user_x_2.md')
  expect(newMemoryFile('user', 'x', new Set(['user_x.md', 'user_x_2.md'])).file).toBe('user_x_3.md')
})

test('serializeNewMemory matches the spec block', () => {
  expect(
    serializeNewMemory('never-commit-without-asking', {
      title: 'Never commit',
      description: 'Commit only when told, even if a skill suggests it',
      type: 'feedback',
      body: 'Never run git commit unless the user says so.\n**Why:** they review every diff first.'
    })
  ).toBe(
    '---\nname: never-commit-without-asking\ndescription: Commit only when told, even if a skill suggests it\nmetadata:\n  type: feedback\n---\n\nNever run git commit unless the user says so.\n**Why:** they review every diff first.\n'
  )
})

test('serializeNewMemory omits the type block when null and round-trips', () => {
  const raw = serializeNewMemory('n', input({ description: 'a: b # c', body: 'x' }))
  expect(raw).not.toContain('metadata')
  expect(parseMemoryFile('n.md', raw)).toEqual({ name: 'n', description: 'a: b # c', type: null, body: 'x' })
})

test('updateMemoryFile keeps unknown keys and a non-standard type', () => {
  const raw = '---\nname: n\ndescription: old\norigin: cli\ntype: preference\n---\n\nold body\n'
  const out = updateMemoryFile(raw, input({ description: 'new', type: 'preference', body: 'new body' }), 'f')
  expect(out).toBe('---\nname: n\ndescription: new\norigin: cli\ntype: preference\n---\n\nnew body\n')
})

test('updateMemoryFile writes a picked type where the old one was', () => {
  const plain = updateMemoryFile('---\nname: n\ndescription: d\ntype: preference\n---\nb\n', input({ type: 'user' }), 'f')
  expect(plain).toContain('type: user')
  expect(plain).not.toContain('metadata')
  const nested = updateMemoryFile('---\nname: n\ndescription: d\nmetadata:\n  type: user\n---\nb\n', input({ type: 'project' }), 'f')
  expect(nested).toContain('  type: project')
  const none = updateMemoryFile('---\nname: n\ndescription: d\n---\nb\n', input({ type: 'user' }), 'f')
  expect(none).toContain('metadata:\n  type: user')
  expect(updateMemoryFile('---\nname: n\ndescription: d\ntype: user\n---\nb\n', input({ type: null }), 'f')).not.toContain('type')
})

test('updateMemoryFile adds frontmatter when missing', () => {
  const out = updateMemoryFile('loose text', input({ type: 'user', body: 'nb' }), 'fallback-name')
  expect(out).toBe('---\nname: fallback-name\ndescription: d\nmetadata:\n  type: user\n---\n\nnb\n')
})

test('updateMemoryFile keeps CRLF', () => {
  const out = updateMemoryFile('---\r\nname: n\r\ndescription: d\r\n---\r\nold\r\n', input({ description: 'e', body: 'l1\nl2' }), 'f')
  expect(out).toBe('---\r\nname: n\r\ndescription: e\r\n---\r\n\r\nl1\r\nl2\r\n')
})

test('updateMemoryFile does not double the CR of a body that already has CRLF', () => {
  const out = updateMemoryFile('---\r\nname: n\r\ndescription: d\r\n---\r\nold\r\n', input({ body: 'l1\r\nl2' }), 'f')
  expect(out).toBe('---\r\nname: n\r\ndescription: d\r\n---\r\n\r\nl1\r\nl2\r\n')
})

test('isMemoryFileName', () => {
  for (const ok of ['User_Role.md', 'a.md']) expect(isMemoryFileName(ok)).toBe(true)
  for (const bad of ['MEMORY.md', '.x.md', 'a/b.md', 'a\\b.md', 'a.txt', 'x\u0000.md', 'a\nb.md', 'a\rb.md', `${'a'.repeat(198)}.md`])
    expect(isMemoryFileName(bad)).toBe(false)
  expect(isMemoryFileName(`${'a'.repeat(197)}.md`)).toBe(true)
})

test('checkMemoryInput', () => {
  expect(checkMemoryInput(input({ type: null }))).toEqual({ title: 'T', description: 'd', type: null, body: 'b' })
  expect(checkMemoryInput(input({ description: '' })).description).toBe('')
  const bad: Record<string, unknown>[] = [
    { title: 'a\nb' },
    { title: 'x'.repeat(101) },
    { title: '' },
    { description: 'x'.repeat(151) },
    { description: 'a\nb' },
    { body: '' },
    { body: 'x'.repeat(8001) },
    { type: 5 }
  ]
  for (const b of bad) expect(() => checkMemoryInput(input(b))).toThrow(TypeError)
  expect(() => checkMemoryInput('x')).toThrow(TypeError)
  expect(() => checkMemoryInput(input({ title: 'secret\ntext' }))).toThrow(/^title$/)
})

test('effectiveLimit', () => {
  expect(effectiveLimit(undefined)).toBe(100)
  expect(effectiveLimit(null)).toBe(100)
  expect(effectiveLimit(30)).toBe(100)
  expect(effectiveLimit(50)).toBe(50)
})

test('capNote and copy', () => {
  expect(capNote(12, 100)).toBe('Agent memory: you have 12 of at most 100 memories.')
  const full = (n: number) =>
    `Agent memory is full (${n} of 100). Do not add a new memory file. To save something new, update a related memory with the combined text, or merge two related memories into one and delete the other. Never delete a memory that is still true only to make room. If nothing can be merged, tell the user that memory is full.`
  expect(capNote(100, 100)).toBe(full(100))
  expect(capNote(101, 100)).toBe(full(101))
  expect(memoryFull(50)).toBe('This agent has reached its limit of 50 memories. Edit, merge or delete one before adding another.')
  expect(MEMORY_CHANGED).toBe('This memory changed since you opened it.')
})

test('memoryLineText', () => {
  expect(memoryLineText({ saved: 1, updated: 0 }, null)).toBe('Memory: 1 saved')
  expect(memoryLineText({ saved: 1, updated: 2 }, 'Ana')).toBe("Ana's memory: 1 saved, 2 updated")
  expect(memoryLineText({ saved: 0, updated: 1 }, null)).toBe('Memory: 1 updated')
})

test('index lines for names with spaces or parens round-trip', () => {
  for (const f of ['my notes.md', 'a(1).md']) {
    const line = indexLine('T', f, 'd')
    expect(line).toBe(`- [T](<${f}>) — d`)
    expect(parseIndex(line).get(f)).toEqual({ title: 'T', line: 1 })
  }
  expect(indexLine('T', 'plain.md', '')).toBe('- [T](plain.md)')
  expect(indexLinkable('a <b>.md')).toBe(false)
  expect(indexLinkable('a<b.md')).toBe(true)
})
