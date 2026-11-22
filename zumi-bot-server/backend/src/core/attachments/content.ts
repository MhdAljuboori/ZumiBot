import { readFile } from 'node:fs/promises'
import type { ImageBlock, UserContent } from '../chat/controlProtocol'
import type { Attachment, ChatItem } from '@zumibot/shared/types'

export type PathOf = (a: Attachment) => string
export interface FileRef {
  id?: string
  name: string
  path: string
  mime: string
  image: boolean
}

export function refsOf(atts: readonly Attachment[] | undefined, pathOf: PathOf): FileRef[] {
  return (atts ?? []).map((a) => ({ id: a.id, name: a.name, path: pathOf(a), mime: a.mime, image: a.kind === 'image' }))
}

export function withNote(text: string, refs: readonly FileRef[]): string {
  if (refs.length === 0) return text
  const lines = refs.map(
    (r) => (r.image ? `- ${r.name} (image, attached below): ${r.path}` : `- ${r.name}: ${r.path}`) + (r.id ? ` [file ID: ${r.id}]` : '')
  )
  const note = `<attachments>\n${lines.join('\n')}\n</attachments>`
  return text === '' ? note : `${text}\n\n${note}`
}

export function withNotes(items: readonly ChatItem[], pathOf: PathOf): ChatItem[] {
  return items.map((it) =>
    it.type === 'user' && it.attachments?.length ? { ...it, text: withNote(it.text, refsOf(it.attachments, pathOf)) } : it
  )
}

export async function imageBlocks(
  refs: readonly FileRef[],
  read: (p: string) => Promise<Buffer> = (p) => readFile(p)
): Promise<ImageBlock[]> {
  const out: ImageBlock[] = []
  for (const r of refs) {
    if (!r.image) continue
    try {
      const buf = await read(r.path)
      out.push({ type: 'image', source: { type: 'base64', media_type: r.mime, data: buf.toString('base64') } })
    } catch {
      // unreadable: the path note still tells the agent about the file
    }
  }
  return out
}

export function withImages(text: string, blocks: readonly ImageBlock[]): UserContent {
  return blocks.length === 0 ? text : [{ type: 'text', text }, ...blocks]
}

export function addDirArgs(items: readonly ChatItem[], dir: string): string[] {
  return items.some((it) => it.type === 'user' && it.attachments?.length) ? ['--add-dir', dir] : []
}
