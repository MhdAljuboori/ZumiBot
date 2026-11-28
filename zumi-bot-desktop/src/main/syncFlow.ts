export interface SyncFlowDeps {
  prepare(chats: boolean): Promise<boolean>
  isDirty(): boolean
  askUnsaved(): Promise<'save' | 'discard' | 'cancel'>
  save(): Promise<boolean>
  busy(): Promise<number>
  pause(): Promise<void>
  execute(chats: boolean): Promise<number>
  restore(): Promise<void>
  log(line: string): void
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Owns the whole operation, including dialogs, so duplicate requests cannot race server shutdown. */
export function createSyncFlow(d: SyncFlowDeps) {
  let active = false
  return {
    active: () => active,
    /** chats: the full sync. Without it only the Claude setup syncs, which touches no ZumiBot data, so nothing is paused. */
    async run(chats = false): Promise<void> {
      if (active) return
      active = true
      let paused = false
      let result = 'Sync cancelled.'
      try {
        if (!(await d.prepare(chats))) return
        // An agent open in the editor is an agent file, so both modes save it first.
        if (d.isDirty()) {
          const answer = await d.askUnsaved()
          if (answer === 'cancel' || (answer === 'save' && !(await d.save()))) return
        }
        if (!chats) {
          result = (await d.execute(false)) === 0 ? 'Sync complete.' : 'Sync failed: see the log above.'
          return
        }
        const count = await d.busy()
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Could not check local running replies.')
        if (count > 0) throw new Error(`${count} replies running on this PC. Wait for them to finish, then retry.`)
        paused = true // a partially failed stop still needs recovery
        await d.pause()
        result = (await d.execute(true)) === 0 ? 'Sync complete.' : 'Sync failed: see the log above.'
      } catch (err) {
        result = `Sync failed: ${message(err)}`
      } finally {
        if (paused) {
          try {
            await d.restore()
          } catch (err) {
            d.log(`Could not reconnect: ${message(err)}`)
            if (result === 'Sync complete.') result = 'Sync finished, but reconnecting failed. Close this window and retry the connection.'
          }
        }
        d.log(result)
        active = false
      }
    }
  }
}
