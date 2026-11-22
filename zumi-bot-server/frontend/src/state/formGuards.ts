// The unsaved-changes guard over several open forms (Agent Studio's own-server and own-hook sub-forms beside the agent file): one
// guard the editor asks, reading the forms at call time so one opened after it was made still counts.

export interface FormGuard {
  isDirty(): boolean
  /** Saves like the form's own Save; true when nothing is left unsaved. */
  save(): Promise<boolean>
}

/** Dirty when any open form is; Save saves each dirty one in order and stops at the first that could not. */
export function joinGuards(forms: () => ReadonlyArray<FormGuard | null | undefined>): FormGuard {
  return {
    isDirty: () => forms().some((f) => f?.isDirty() === true),
    save: async () => {
      for (const f of forms()) if (f?.isDirty() && !(await f.save())) return false
      return true
    }
  }
}
