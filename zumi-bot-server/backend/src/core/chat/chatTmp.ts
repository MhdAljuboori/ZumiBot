import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

// The CLI's own temp folder per chat (CLAUDE_CODE_TMPDIR), kept under the data dir so an agent's working files outlive a reboot.
// Named by a short hash of the chat id, so its paths are shorter than the id would make them. A unix socket the CLI puts
// under it can still pass the ~104-byte limit on a long data dir; CLI 2.1.317 copes (see docs/architecture/data.md).
export class ChatTmp {
  // The pause flag lives outside the temp folder: the agent can write there (sandbox and container alike), so a flag in it
  // could be swapped for a symlink that makes the server's write land on any file the user owns, or deleted to dodge a pause.
  constructor(
    private readonly root: string,
    private readonly pauseRoot: string = join(dirname(root), 'pause-flags')
  ) {}

  private static hashOf(chatId: string): string {
    return createHash('sha256').update(chatId).digest('hex').slice(0, 16)
  }

  dirOf(chatId: string): string {
    return join(this.root, ChatTmp.hashOf(chatId))
  }

  /** The folder holding the chat's pause flag: server-written only, mounted read-only into a container. */
  pauseDirOf(chatId: string): string {
    return join(this.pauseRoot, ChatTmp.hashOf(chatId))
  }

  async ensure(chatId: string): Promise<string> {
    const dir = this.dirOf(chatId)
    // The agent may leave anything in here (a .env copy, say), so no one else reads it.
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.mkdir(this.pauseRoot, { recursive: true, mode: 0o700 })
    await fs.mkdir(this.pauseDirOf(chatId), { recursive: true, mode: 0o700 })
    return dir
  }

  pauseFlagOf(chatId: string): string {
    return join(this.pauseDirOf(chatId), 'paused')
  }

  async remove(chatId: string): Promise<void> {
    await fs.rm(this.dirOf(chatId), { recursive: true, force: true })
    await fs.rm(this.pauseDirOf(chatId), { recursive: true, force: true })
  }

  // Folders of deleted chats (or of a data dir copied in) would otherwise stay forever. A stray file is not ours to remove.
  // With no live ids it removes nothing: the cost is a little orphan disk after the user deletes their last chat.
  async sweep(liveIds: Iterable<string>): Promise<number> {
    const keep = new Set([...liveIds].map((id) => ChatTmp.hashOf(id)))
    // A missing or corrupt chat index reads as no chats: sweeping then would delete every agent's working files.
    if (keep.size === 0) return 0
    // Only the temp folders count: an orphan pause flag is a few bytes and goes with no message.
    await this.sweepRoot(this.pauseRoot, keep)
    return this.sweepRoot(this.root, keep)
  }

  private async sweepRoot(root: string, keep: ReadonlySet<string>): Promise<number> {
    let entries
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return 0
      throw err
    }
    let removed = 0
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = join(root, e.name)
      if (keep.has(e.name)) continue
      // One folder an agent left unremovable (read-only, say) must not keep the rest; it is tried again next start.
      try {
        await fs.rm(dir, { recursive: true, force: true })
        removed++
      } catch (err) {
        // Only the code: the path names the data folder.
        const code = (err as { code?: unknown } | null)?.code
        console.error('chat temp folder not swept:', typeof code === 'string' ? code : 'error')
      }
    }
    return removed
  }
}
