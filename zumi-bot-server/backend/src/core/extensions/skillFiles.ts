import { promises as fs, type Dirent } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import YAML from 'yaml'
import { EXT_TEXT, type SkillView } from '@zumibot/shared/extensions'
import { NAME_PATTERN, split } from '@zumibot/shared/frontmatter'
import { assertInside, writeFileAtomic } from '../fsutil'
import { assertProjectPath, stampOf } from './settingsFile'

// Skills on disk: `<root>/<folder>/SKILL.md` with `name` and `description` frontmatter and a Markdown body. A skill is found by its
// frontmatter name (the folder may differ). Only real folders and files count: a symlinked skill belongs to whoever made the link,
// and this page never writes through it. Errors are EXT_TEXT sentences or a bare error code, never a path.

const SKIP_FOLDERS = new Set(['synced', '.trash'])
const FILES_MAX = 200
const FILES_DEPTH = 4
const SKILL_MAX = 1_000_000
const NAME_MAX = 100

interface Parsed {
  text: string
  name: string
  description: string
  head: string | null
  body: string
}

const ioError = (err: unknown): Error => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? new Error(code) : err instanceof Error ? err : new Error('EIO')
}

/** A real folder holding a regular SKILL.md: a link to either belongs to whoever made it. */
async function isSkillFolder(dir: string): Promise<boolean> {
  try {
    return (await fs.lstat(dir)).isDirectory() && (await fs.lstat(join(dir, 'SKILL.md'))).isFile()
  } catch {
    return false
  }
}

/** The skill's file as text, or null when the folder is not a skill folder or the file is unreadable or too big. */
async function readSkillText(dir: string): Promise<string | null> {
  try {
    if (!(await isSkillFolder(dir)) || (await fs.stat(join(dir, 'SKILL.md'))).size > SKILL_MAX) return null
    return await fs.readFile(join(dir, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
}

/** Name, description and body; null when the frontmatter is there but not valid YAML. A file with no frontmatter takes the folder's name. */
function parseSkill(text: string, folderName: string): Parsed | null {
  const s = split(text)
  if (!s) return { text, name: folderName, description: '', head: null, body: text }
  let fm: unknown
  try {
    fm = YAML.parse(s.yaml)
  } catch {
    return null
  }
  const map = fm && typeof fm === 'object' && !Array.isArray(fm) ? (fm as Record<string, unknown>) : {}
  const name = typeof map['name'] === 'string' && map['name'] !== '' ? map['name'] : folderName
  const d = map['description']
  const description = d === undefined || d === null ? '' : String(d)
  return { text, name, description, head: s.head, body: s.body }
}

/** Frontmatter name to folder, for every real skill folder of the root. Missing root is empty; the first folder (by name) wins a repeated name. */
export async function listSkillDirs(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return map
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_FOLDERS.has(e.name)) continue
    const dir = join(root, e.name)
    const text = await readSkillText(dir)
    const parsed = text === null ? null : parseSkill(text, e.name)
    if (parsed && !map.has(parsed.name)) map.set(parsed.name, dir)
  }
  return map
}

// Relative names of the files beside SKILL.md, depth-limited and capped; links and special files are left out.
async function siblingFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (folder: string, depth: number): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (out.length >= FILES_MAX) return
      const path = join(folder, e.name)
      if (e.isDirectory()) {
        if (depth < FILES_DEPTH) await walk(path, depth + 1)
      } else if (e.isFile()) {
        const rel = relative(dir, path)
        if (rel !== 'SKILL.md') out.push(rel)
      }
    }
  }
  await walk(dir, 1)
  return out
}

/** A skill is a direct child folder of its root: the root itself, a `..` path, a nested path and a folder outside are all refused. */
function skillDirIn(root: string, dir: string): string {
  const full = resolve(dir)
  if (dirname(full) !== resolve(root)) throw new Error(EXT_TEXT.notFound)
  try {
    return assertInside(root, full)
  } catch {
    // assertInside names the root in its message; only the fixed sentence goes on.
    throw new Error(EXT_TEXT.notFound)
  }
}

export async function readSkill(root: string, skillDir: string, scope: 'user' | 'project'): Promise<SkillView> {
  const dir = skillDirIn(root, skillDir)
  const text = await readSkillText(dir)
  const parsed = text === null ? null : parseSkill(text, basename(dir))
  if (text === null || !parsed) throw new Error(EXT_TEXT.notFound)
  return {
    scope,
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    files: await siblingFiles(dir),
    stamp: stampOf(text)
  }
}

const frontmatterOf = (name: string, description: string): string => `---\n${YAML.stringify({ name, description }, { lineWidth: 0 })}---\n`

// Only `description` changes: the document is edited in place, so every other key and comment stays. Unchanged, the head is spliced back verbatim.
function rewrite(p: Parsed, name: string, description: string, body: string): string {
  if (p.head === null) return frontmatterOf(name, description) + body
  if (p.description === description) return p.head + body
  const s = split(p.text) as NonNullable<ReturnType<typeof split>>
  const doc = YAML.parseDocument(s.yaml)
  // A frontmatter that is no map (a bare scalar) has nowhere to put a key; it is left as it was.
  if (doc.contents !== null && !YAML.isMap(doc.contents)) throw new Error(EXT_TEXT.notEditable)
  doc.set('description', description)
  const eol = p.text.includes('\r\n') ? '\r\n' : '\n'
  let yaml = doc.toString({ lineWidth: 0 })
  if (!yaml.endsWith('\n')) yaml += '\n'
  if (eol === '\r\n') yaml = yaml.replace(/\n/g, '\r\n')
  return `---${eol}${yaml}---${eol}${body}`
}

/**
 * A name no skill has creates `<root>/<name>/SKILL.md`; a name that is a skill's frontmatter name edits that skill's description and
 * body only. A stamp that no longer matches the file is refused. The new name must be a lower-case folder name. With `inside` the root is
 * a project's and is refused (`notEditable`) when it, or a folder above it, leads out of that folder.
 */
export async function saveSkill(
  root: string,
  input: { name: string; description: string; body: string; stamp?: string },
  inside?: string
): Promise<void> {
  // A project root (`inside` is its chosen folder) must really lie in the folder (Ruling 25); a user root keeps following links.
  if (inside !== undefined) await assertProjectPath(inside, root)
  const existing = (await listSkillDirs(root)).get(input.name)
  if (!existing) {
    if (input.stamp !== undefined) throw new Error(EXT_TEXT.notFound)
    if (!NAME_PATTERN.test(input.name) || input.name.length > NAME_MAX) throw new Error(EXT_TEXT.badName)
    const dir = assertInside(root, join(root, input.name))
    try {
      await fs.mkdir(root, { recursive: true })
      // Not recursive: a folder that is already there is never written into.
      await fs.mkdir(dir)
    } catch (err) {
      throw (err as NodeJS.ErrnoException).code === 'EEXIST' ? new Error(EXT_TEXT.notEditable) : ioError(err)
    }
    const body = input.body === '' || input.body.endsWith('\n') ? input.body : input.body + '\n'
    try {
      await writeFileAtomic(join(dir, 'SKILL.md'), frontmatterOf(input.name, input.description) + body)
    } catch (err) {
      // Nothing of the new skill stays if its file could not be written.
      await fs.rm(dir, { recursive: true, force: true })
      throw ioError(err)
    }
    return
  }

  assertInside(root, existing)
  const text = await readSkillText(existing)
  const parsed = text === null ? null : parseSkill(text, basename(existing))
  if (text === null || !parsed) throw new Error(EXT_TEXT.notFound)
  if (input.stamp !== undefined && input.stamp !== stampOf(text)) throw new Error(EXT_TEXT.stale)
  try {
    await writeFileAtomic(join(existing, 'SKILL.md'), rewrite(parsed, parsed.name, input.description, input.body))
  } catch (err) {
    throw ioError(err)
  }
}

/** Hands the whole skill folder to `trash`, after checking it is a direct child of the root and holds a SKILL.md; a project root as `saveSkill`. */
export async function removeSkill(root: string, skillDir: string, trash: (path: string) => Promise<void>, inside?: string): Promise<void> {
  if (inside !== undefined) await assertProjectPath(inside, root)
  const dir = skillDirIn(root, skillDir)
  if (!(await isSkillFolder(dir))) throw new Error(EXT_TEXT.notFound)
  await trash(dir)
}
