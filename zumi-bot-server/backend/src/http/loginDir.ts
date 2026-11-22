import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the sign-in and setup pages live. They ship next to the bundle (dist/login); from source they sit beside
 * the auth routes. Resolved once, from this file's own location, so both servers read the same folder.
 */
export function loginDir(here = dirname(fileURLToPath(import.meta.url))): string {
  return [join(here, 'login'), join(here, 'http', 'login')].find((d) => existsSync(join(d, 'login.html'))) ?? join(here, 'login')
}
