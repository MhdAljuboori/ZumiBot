import { promises as fs } from 'node:fs'
import { userInfo } from 'node:os'
import { claudeConfigFile, parseProfile, type Profile } from './claudeAccount'
import { defaultLocateDeps, locateClaude } from './chat/claudeLocator'

/** What the setup wizard's last step reports: is the CLI there, and can it talk to Anthropic. */
export interface ClaudeStatus {
  found: string | null
  /** Signed in, or carrying a key in the environment. */
  ready: boolean
  /** How: the account's email for a login, or the name of the variable holding the key. Never a key's value. */
  how: string | null
  message: string
  /** Commands to run, in order, as `user`. Empty once it is ready. */
  fix: string[]
  user: string
}

/** Credentials Claude Code takes from the environment, in the order it prefers them (authentication docs). */
const KEY_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const

export function keyVarInUse(env: NodeJS.ProcessEnv): string | null {
  return KEY_VARS.find((name) => (env[name] ?? '') !== '') ?? null
}

/**
 * Pure: turns what was found on disk into what to show. A missing oauth account is not proof of a missing login
 * (a key in the environment counts, and Claude Code keeps a macOS login in the Keychain), so the wording never
 * claims more than was checked.
 */
export function describeClaude(d: { path: string | null; profile: Profile | null; keyVar: string | null; user: string }): ClaudeStatus {
  const base = { found: d.path, user: d.user }
  if (!d.path) {
    return {
      ...base,
      ready: false,
      how: null,
      message: 'The claude CLI was not found. ZumiBot runs it for every reply, so install it and sign in as this server’s own user.',
      fix: ['npm i -g @anthropic-ai/claude-code', 'claude']
    }
  }
  if (d.profile) {
    const plan = d.profile.plan ? ` on ${d.profile.plan}` : ''
    return { ...base, ready: true, how: d.profile.email, message: `Found and signed in as ${d.profile.email}${plan}.`, fix: [] }
  }
  if (d.keyVar) {
    return { ...base, ready: true, how: d.keyVar, message: `Found, and authenticating with the key in ${d.keyVar}.`, fix: [] }
  }
  return {
    ...base,
    ready: false,
    message:
      'Found, but no Claude login was found for this user. Run claude once to sign in, then check again. If it signs in through a key or the macOS Keychain instead, this check cannot see it and replies will still work.',
    how: null,
    fix: ['claude']
  }
}

/** Reads the disk and answers; never throws, so a broken config file only reads as "not signed in". */
export async function probeClaude(o: { claudePath: string | null; env?: NodeJS.ProcessEnv }): Promise<ClaudeStatus> {
  const env = o.env ?? process.env
  const path = await locateClaude(defaultLocateDeps(o.claudePath)).catch(() => null)
  let profile: Profile | null = null
  try {
    profile = parseProfile(JSON.parse(await fs.readFile(claudeConfigFile(env), 'utf8')))
  } catch {
    /* no config yet, or not readable: not signed in as far as this check goes */
  }
  let user = 'the server’s user'
  try {
    user = userInfo().username
  } catch {
    /* no passwd entry (a bare container): the generic wording stays */
  }
  return describeClaude({ path, profile, keyVar: keyVarInUse(env), user })
}
