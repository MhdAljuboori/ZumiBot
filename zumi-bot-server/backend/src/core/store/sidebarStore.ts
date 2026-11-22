import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  emptyLayout,
  forgetChatInLayout,
  parseLayout,
  placeFirstInSection,
  renameAgentInLayout,
  type SidebarLayout
} from '@zumibot/shared/sidebarLayout'
import { writeFileAtomic } from '../fsutil'

/** The sidebar's sections and order (sidebar.json). Every change resolves to the layout now stored. */
export class SidebarStore {
  private readonly file: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'sidebar.json')
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<SidebarLayout> {
    try {
      return parseLayout(JSON.parse(await fs.readFile(this.file, 'utf8'))) ?? emptyLayout()
    } catch {
      return emptyLayout()
    }
  }

  private async write(l: SidebarLayout): Promise<SidebarLayout> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await writeFileAtomic(this.file, JSON.stringify(l, null, 2))
    return l
  }

  // A change that leaves the layout as it was writes nothing and resolves to null, so nobody is told about it.
  private change(fn: (l: SidebarLayout) => SidebarLayout): Promise<SidebarLayout | null> {
    return this.run(async () => {
      const cur = await this.read()
      // Parsed again: a rename onto a name already placed would list it twice.
      const next = parseLayout(fn(cur)) ?? cur
      return JSON.stringify(next) === JSON.stringify(cur) ? null : this.write(next)
    })
  }

  get(): Promise<SidebarLayout> {
    return this.run(() => this.read())
  }

  /** `layout` must already be parsed (parseLayout). */
  save(layout: SidebarLayout): Promise<SidebarLayout> {
    return this.run(() => this.write(layout))
  }

  renameAgent(from: string, to: string): Promise<SidebarLayout | null> {
    return this.change((l) => renameAgentInLayout(l, from, to))
  }

  forgetChat(chatId: string): Promise<SidebarLayout | null> {
    return this.change((l) => forgetChatInLayout(l, chatId))
  }

  /** A routine's new room, at the top of its section. Null when the section is gone: the room stays outside them. */
  placeFirst(sectionId: string, key: string): Promise<SidebarLayout | null> {
    return this.change((l) => placeFirstInSection(l, sectionId, key))
  }

  /** The id of the section holding `key` (a groupKey), or null when it is in none. */
  async sectionOf(key: string): Promise<string | null> {
    const l = await this.get()
    return l.sections.find((s) => s.items.includes(key))?.id ?? null
  }
}
