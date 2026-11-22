import { defineConfig } from 'vitest/config'
import { serialProject } from './zumi-bot-server/backend/vitest.config'

const windows = process.platform === 'win32'

export default defineConfig({
  test: {
    projects: [
      'zumi-bot-server/shared',
      'zumi-bot-server/frontend',
      'zumi-bot-server/backend',
      'zumi-bot-desktop',
      'zumi-bot-site',
      'zumi-bot-docs',
      // The backend's deadline-heavy files (real Chrome everywhere, fake CLIs on Windows), after the rest and one at a time.
      serialProject
    ],
    // Starting a process costs far more on Windows, and the fake-CLI tests start many against short deadlines: with a
    // worker per core, the slowest miss them. Half the cores keeps them on time. Likewise on macOS (seen on an Intel Mac,
    // whose load average reached 24 on 8 cores with a worker per core).
    maxWorkers: windows || process.platform === 'darwin' ? '50%' : undefined
  }
})
