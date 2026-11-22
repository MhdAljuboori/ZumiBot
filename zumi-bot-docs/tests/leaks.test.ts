import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codeBlockProblems, findLeaks } from '../src/lib/leaks.ts'

const ROOT = join(import.meta.dirname, '../..')
const DOCS = join(import.meta.dirname, '../src/content/docs')

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.mdx?$/.test(e.name) ? [join(dir, e.name)] : []
  )

const files = [...walk(DOCS), join(ROOT, 'CHANGELOG.md')]

describe('leaks', () => {
  it('flags each forbidden string', () => {
    const samples = [
      'https://github.com/MhdAljuboori/ZumiBot/releases',
      'https://github.com/MhdAljuboori/ZumiBot/blob/main/install.sh',
      'https://github.com/MhdAljuboori/ZumiBot.git',
      'https://github.com/MhdAljuboori/Other',
      'https://raw.githubusercontent.com/x/y/main/install.sh',
      'zumibot.mhdaljuboori.me',
      'zumi-bot-server/backend',
      'docs/architecture/data.md',
      'see src/state/itemSync.ts for it',
      'see src/ui/Rail.tsx for it'
    ]
    for (const s of samples) expect(findLeaks(s), s).not.toEqual([])
    expect(findLeaks('zumibot.example.com')).toEqual([])
    expect(findLeaks('https://zumibot.run/releases/latest/install.sh')).toEqual([])
  })

  it('lets the repo home page through, and nothing under it', () => {
    for (const s of [
      '[GitHub](https://github.com/MhdAljuboori/ZumiBot)',
      'See https://github.com/MhdAljuboori/ZumiBot.',
      'https://github.com/MhdAljuboori/ZumiBot/',
      '<a href="https://github.com/MhdAljuboori/ZumiBot">'
    ]) {
      expect(findLeaks(s), s).toEqual([])
    }
    expect(findLeaks('[GitHub](https://github.com/MhdAljuboori/ZumiBot) by MhdAljuboori')).toEqual(['MhdAljuboori'])
  })

  it('flags a task number, the owner handle bare, and any letter case of the private paths', () => {
    for (const s of ['written when the macOS pages land (Task 12)', 'Task 3 is done', 'by MhdAljuboori', 'ZUMI-BOT-SERVER/backend', 'Docs/Architecture/data.md']) {
      expect(findLeaks(s), s).not.toEqual([])
    }
    expect(findLeaks('Ask a task to run later. A background task 12 hours long.')).toEqual([])
  })

  it('flags prompts and curly quotes in shell blocks only', () => {
    expect(codeBlockProblems('```bash\n$ ls\n```')).toHaveLength(1)
    expect(codeBlockProblems('```text\n$ ls\n```')).toHaveLength(0)
  })

  it('flags curly quotes, indented prompts, other shell tags and longer fences', () => {
    expect(codeBlockProblems('```bash\necho “hi”\n```')).toHaveLength(1)
    expect(codeBlockProblems('1. Run it:\n\n   ```bash\n   $ ls\n   ```\n')).toHaveLength(1)
    expect(codeBlockProblems('~~~sh\n$ ls\n~~~')).toHaveLength(1)
    expect(codeBlockProblems('````shell\n$ ls\n````')).toHaveLength(1)
    // A shorter fence inside a longer one does not close it.
    expect(codeBlockProblems('````shell\n```\n$ ls\n````')).toHaveLength(1)
    expect(codeBlockProblems('```bash\nls\n```\n\n$ not code\n“quoted”')).toHaveLength(0)
    expect(codeBlockProblems('```bash\r\n$ ls\r\n```\r\n')).toEqual(['prompt: $ ls'])
  })

  it('does not read a one-line triple backtick as a fence', () => {
    // Inline code, so the lines after it are not code.
    expect(codeBlockProblems('```bash echo hi```\n$ ls')).toHaveLength(0)
    expect(codeBlockProblems('```bash\n$ ls\n```')).toHaveLength(1)
  })

  it('no page leaks', () => {
    for (const f of files) expect(findLeaks(readFileSync(f, 'utf8')), relative(ROOT, f)).toEqual([])
  })

  it('no page has a broken shell block', () => {
    for (const f of files) expect(codeBlockProblems(readFileSync(f, 'utf8')), relative(ROOT, f)).toEqual([])
  })
})
