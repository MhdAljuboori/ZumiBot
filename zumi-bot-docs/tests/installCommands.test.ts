import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXAMPLE_ORIGIN, installSteps } from '../../zumi-bot-site/src/serverInstall.ts'

const PAGE = join(import.meta.dirname, '../src/content/docs/get-started/install-server.mdx')

describe('server install page', () => {
  it("install page shows the site's commands", () => {
    const page = readFileSync(PAGE, 'utf8')
    const commands = installSteps(EXAMPLE_ORIGIN).flatMap((s) => s.commands)
    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) expect(page, command).toContain(command)
  })

  it('uses the example origin', () => {
    expect(readFileSync(PAGE, 'utf8')).toContain('zumibot.example.com')
  })
})
