import type { Attachment } from './types'

/** One hunk of a unified diff; lines carry a ' ', '-' or '+' prefix. Starts are 1-based, 0 when that side has no lines. */
export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** Why a before/after snapshot is missing when the file was not simply created; `deleted` is the after side of a removed file. */
export type SnapshotMiss = 'too-big' | 'binary' | 'not-sent' | 'unrebuilt' | 'unreadable' | 'deleted'

/** A file edit recorded on a tool item. */
export interface FileChange {
  id: string
  ts: number
  path: string
  op: 'create' | 'update'
  patch: PatchHunk[] | null
  before: string | null
  after: string | null
  why?: { before?: SnapshotMiss; after?: SnapshotMiss } // set when before/after is null for a reason other than create
  snippet?: { old: string; new: string }
  subagent?: string
}

/** One edit of a file as the panel shows it; `unknown` and `legacy` cover tool items saved before changes were recorded. */
export interface ChangeStep {
  itemId: string
  id: string
  ts: number
  agent?: string
  subagent?: string
  op: 'create' | 'update' | 'unknown'
  patch: PatchHunk[] | null
  before: string | null
  after: string | null
  why?: FileChange['why']
  snippet?: FileChange['snippet']
  legacy?: { oldString: string; newString: string } | { content: string }
}

export interface ChangedFile {
  path: string
  shown: string
  created: boolean
  changes: ChangeStep[]
} // changes oldest first

export interface AttachedFile {
  itemId: string
  ts: number
  attachment: Attachment
}

export interface ChatFileList {
  changed: ChangedFile[]
  attached: AttachedFile[]
}
