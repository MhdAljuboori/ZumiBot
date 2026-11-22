// Runs before every build and dev start (npm prebuild/dev). Writes src/content/docs/server/changelog.md from the root
// CHANGELOG.md, so the site never keeps a second copy by hand. The file is git-ignored.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicChangelog } from '../src/lib/changelog.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, '..', 'CHANGELOG.md')
const out = join(root, 'src', 'content', 'docs', 'server', 'changelog.md')

const frontmatter = [
  '---',
  'title: Changelog',
  'description: What changed in each ZumiBot release.',
  'sidebar:',
  '  order: 99',
  '---',
  '',
  ''
].join('\n')

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, frontmatter + publicChangelog(readFileSync(source, 'utf8')))
