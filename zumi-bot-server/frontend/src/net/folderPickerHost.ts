// Lets api.pickFolder (plain code) ask the UI to show the folder picker, and gets the answer back.
export interface PickerRequest {
  start: string
  resolve: (path: string | null) => void
}

let current: PickerRequest | null = null
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())

export const pickerHost = {
  /** Opens the picker at `start`; resolves with the folder chosen, or null when cancelled. A second ask cancels the first. */
  open(start: string): Promise<string | null> {
    current?.resolve(null)
    return new Promise((resolve) => {
      const req: PickerRequest = {
        start,
        resolve: (path) => {
          if (current === req) current = null
          notify()
          resolve(path)
        }
      }
      current = req
      notify()
    })
  },
  get: (): PickerRequest | null => current,
  subscribe(l: () => void): () => void {
    listeners.add(l)
    return () => void listeners.delete(l)
  }
}
