import { ATTACH_MAX_FILES, pastedName, stageErrors } from '@zumibot/shared/attachments'
import type { Attachment, StageResult } from '@zumibot/shared/types'

export type DraftFile =
  { key: string; name: string; status: 'staging' } | { key: string; name: string; status: 'ready'; attachment: Attachment }

export interface DraftFiles {
  files: DraftFile[]
  error: string | null
}

export const emptyDraftFiles: DraftFiles = { files: [], error: null }

/** Adds staging entries up to the per-message limit; `accepted` lists the keys taken, the rest are refused with the count error. */
export function addStaging(d: DraftFiles, incoming: { key: string; name: string }[]): { draft: DraftFiles; accepted: string[] } {
  const room = Math.max(0, ATTACH_MAX_FILES - d.files.length)
  const taken = incoming.slice(0, room)
  const added: DraftFile[] = taken.map((f) => ({ key: f.key, name: f.name, status: 'staging' }))
  return {
    draft: { files: [...d.files, ...added], error: taken.length < incoming.length ? stageErrors.TOO_MANY : null },
    accepted: taken.map((f) => f.key)
  }
}

/** A staged file becomes ready, or is dropped with the error. A key removed meanwhile leaves the draft as it was. */
export function settle(d: DraftFiles, key: string, r: StageResult): DraftFiles {
  if (!d.files.some((f) => f.key === key)) return d
  if (!r.ok) return { files: d.files.filter((f) => f.key !== key), error: r.error }
  return {
    ...d,
    files: d.files.map((f): DraftFile => (f.key === key ? { key, name: f.name, status: 'ready', attachment: r.attachment } : f))
  }
}

export function removeFile(d: DraftFiles, key: string): DraftFiles {
  return { files: d.files.filter((f) => f.key !== key), error: null }
}

export const readyIds = (d: DraftFiles): string[] => d.files.flatMap((f) => (f.status === 'ready' ? [f.attachment.id] : []))

export const isStaging = (d: DraftFiles): boolean => d.files.some((f) => f.status === 'staging')

export type FileOrigin = 'paste' | 'drop' | 'pick'

/** A pasted image has no real name (the browser calls it image.png), so it gets a timestamped one; dropped and picked files keep theirs. */
export function draftFileName(file: { name: string; type: string }, origin: FileOrigin, now: Date): string {
  return origin === 'paste' ? pastedName(now, file.type) : file.name
}
