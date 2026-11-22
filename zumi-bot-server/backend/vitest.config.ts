import { readFileSync } from 'node:fs'
import { configDefaults, defineConfig } from 'vitest/config'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// Whole files that drive a feature the app offers only on Linux (docs/architecture/install.md, "Windows: native"), so they
// run only there. Files that merely touch such a feature gate single tests instead.
const LINUX_ONLY = [
  // The agent browser: a real Chromium owned through /proc.
  'tests/core/chromiumAdapter.test.ts',
  'tests/core/workerAdapter.test.ts',
  // Computer use: Xvnc, cua-driver and the desktop socket.
  'tests/core/desktop/desktopProcess.test.ts',
  'tests/core/desktop/desktopApplication.test.ts',
  'tests/core/desktop/desktopRuntime.test.ts',
  'tests/http/desktopSocket.test.ts',
  // The sandbox (bwrap) and container isolation (rootless podman).
  'tests/core/isolation/isolation.test.ts',
  'tests/core/isolation/container.test.ts',
  'tests/core/isolation/podmanCalls.test.ts'
]

// Windows: files that run many fake-CLI turns against wall-clock deadlines. Starting a process costs far more there, so
// beside the rest of the suite they starve one another and miss them; the root config runs them afterwards, one at a time
// (project `backend-serial`).
export const WINDOWS_SERIAL = [
  'tests/*Probe.test.ts',
  'tests/core/extensions/extensionsService.test.ts',
  'tests/core/extensions/probe.test.ts',
  'tests/core/extensions/claudeCli.test.ts'
]

// Every platform: files that start a real Chrome, each command against a wall-clock deadline. Beside a full parallel run
// a command can miss it on any machine (seen in WSL with 10 workers as on a 2-core CI runner), so they too run afterwards.
export const REAL_BROWSER = ['tests/core/chromiumAdapter.test.ts', 'tests/core/workerAdapter.test.ts', 'tests/browserPackaging.test.ts']

const windows = process.platform === 'win32'
// macOS: the fake-CLI and installer tests spawn many node processes, and an Intel Mac running the suite takes longer than
// the 5 s default for some (seen up to ~10 s). Their own deadlines are untouched; only vitest's cap on a whole test grows.
export const DARWIN_TIMEOUTS = process.platform === 'darwin' ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}
const SERIAL = [...REAL_BROWSER, ...(windows ? WINDOWS_SERIAL : [])]
const define = { __SERVER_VERSION__: JSON.stringify(version) }
const exclude = [...configDefaults.exclude, ...(process.platform === 'linux' ? [] : LINUX_ONLY)]

/** The serial project, run by the root config after the others, one file at a time. */
export const serialProject = {
  root: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  define,
  test: {
    name: 'backend-serial',
    environment: 'node' as const,
    include: SERIAL,
    exclude,
    ...DARWIN_TIMEOUTS,
    fileParallelism: false,
    sequence: { groupOrder: 1 }
  }
}

export default defineConfig({
  // Same define as vite.config.ts, for tests that start the whole server.
  define,
  test: {
    name: 'backend',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [...exclude, ...SERIAL],
    ...DARWIN_TIMEOUTS
  }
})
