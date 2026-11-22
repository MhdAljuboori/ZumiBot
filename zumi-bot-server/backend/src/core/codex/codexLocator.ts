import { defaultLocateDeps, locateBin, loginShellWhich, type LocateDeps } from '../chat/claudeLocator'

/** The same search as `locateClaude`, for the `codex` binary. */
export const locateCodex = (d: LocateDeps): Promise<string | null> => locateBin('codex', d)

/**
 * `ZUMIBOT_CODEX_BIN` is the override unless one is given; it is a user setting, so production reads it too.
 * `pathEnv` is the interactive shell's PATH: codex is usually an npm global under nvm, which only .bashrc (.zshrc on a Mac) puts on PATH,
 * so a desktop-launched server's own PATH (and `bash -lc`) never sees it.
 */
export function defaultCodexLocateDeps(override: string | null, pathEnv?: string): LocateDeps {
  return {
    ...defaultLocateDeps(override ?? (process.env.ZUMIBOT_CODEX_BIN?.trim() || null)),
    ...(pathEnv !== undefined ? { pathEnv } : {}),
    loginShellWhich: () => loginShellWhich('codex')
  }
}
