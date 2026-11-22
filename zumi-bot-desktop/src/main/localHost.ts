export class LaunchAborted extends Error {
  constructor() {
    super('The local server launch was cancelled')
  }
}

/** One local server at a time: concurrent ensure() calls share a launch, and stop() also cancels a launch still in flight. */
export function createLocalHost<T extends { stop(): Promise<void> }>(start: () => Promise<T>) {
  let cur: T | null = null
  let launching: Promise<T> | null = null
  let generation = 0
  return {
    current: (): T | null => cur,
    ensure(): Promise<T> {
      if (cur) return Promise.resolve(cur)
      if (launching) return launching
      const mine = generation
      const p: Promise<T> = start().then(
        async (s) => {
          if (mine !== generation) {
            await s.stop() // stopped while it was starting: it must not outlive that
            throw new LaunchAborted()
          }
          cur = s
          return s
        },
        (err) => {
          throw mine !== generation ? new LaunchAborted() : err
        }
      )
      launching = p
      const clear = (): void => {
        if (launching === p) launching = null
      }
      p.then(clear, clear)
      return p
    },
    /** A server that died on its own. */
    forget(s: T): void {
      if (cur === s) cur = null
    },
    async stop(): Promise<void> {
      generation++
      const s = cur
      const pending = launching
      cur = null
      launching = null
      if (s) await s.stop()
      if (pending) await pending.catch(() => {}) // the launch stops its own server once it sees the new generation
    }
  }
}
