// Pure: the frontend imports this file too, so no `node:` modules. A Windows server's home (`C:\Users\x`) gets
// backslashes; the checks below take either separator.

/** Where a chat started without a picked folder runs: `<home>/zumibot/cache/<one folder per chat>`. */
export const SCRATCH_DIR = 'zumibot/cache'

const sepOf = (home: string): string => (/^[A-Za-z]:[\\/]/.test(home) || home.startsWith('\\\\') ? '\\' : '/')

export const scratchRoot = (home: string): string => {
  const sep = sepOf(home)
  return `${home.replace(/[\\/]+$/, '')}${sep}${SCRATCH_DIR.split('/').join(sep)}`
}

/** A chat's own folder under the scratch root, with the root's separator. */
export const scratchChild = (home: string, name: string): string => `${scratchRoot(home)}${sepOf(home)}${name}`

/** `<yyyy-mm-dd>-<hex>`: sorts by day in a file manager, and the hex keeps two chats in one second apart. */
export const scratchName = (now: Date, hex: string): string => `${now.toISOString().slice(0, 10)}-${hex}`

const ROOT_RE = /[\\/]zumibot[\\/]cache[\\/]?$/
const CHILD_RE = /[\\/]zumibot[\\/]cache[\\/][^\\/]+[\\/]?$/

export const isScratchRoot = (cwd: string): boolean => ROOT_RE.test(cwd)

/** A chat's own scratch folder: the sidebar files these under the root, not one group each. */
export const isScratchFolder = (cwd: string): boolean => CHILD_RE.test(cwd)

/** The scratch root a scratch folder sits in. */
export const scratchParent = (cwd: string): string => cwd.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '')

/** Shown wherever a folder name would be: the scratch path means nothing to the user. */
export const NO_FOLDER_LABEL = 'No folder'
