import { expect, test } from 'vitest'
import { toolSummary } from '@zumibot/shared/toolSummary'

test.each([
  ['Bash', { command: 'gh pr merge 412\necho done' }, 'Bash(gh pr merge 412)'],
  ['Read', { file_path: 'src/app/routes.ts' }, 'Read src/app/routes.ts'],
  ['Grep', { pattern: 'TODO' }, 'Grep TODO'],
  ['mcp__workiom__get_record', { id: 'r1' }, 'mcp__workiom__get_record r1'],
  ['Weird', {}, 'Weird'],
  ['mcp__zumibot_vault__vault_items', {}, 'Checked the vault'],
  ['mcp__zumibot_browser__browser_fill_from_vault', { item: 'Work Visa', field: 'number' }, 'Filled from vault · Work Visa · card number'],
  ['mcp__zumibot_browser__browser_fill_from_vault', { item: 'Mail', field: 'code' }, 'Filled from vault · Mail · 2FA code'],
  ['mcp__zumibot_browser__browser_fill_from_vault', {}, 'Filled from vault · unknown item · unknown field'],
  ['mcp__zumibot_automations__workflow_delete', { id: 'x', name: 'Hashtags' }, 'Delete workflow “Hashtags”'],
  ['mcp__zumibot_automations__routine_delete', { id: 'x', name: 'Morning' }, 'Delete routine “Morning”'],
  ['mcp__zumibot_automations__routine_delete', { id: 'x' }, 'mcp__zumibot_automations__routine_delete x'],
  ['ApplyPatch', { changes: [{ path: '/a/b.ts', kind: 'update' }] }, 'ApplyPatch b.ts'],
  [
    'ApplyPatch',
    {
      changes: [
        { path: '/a/b.ts', kind: 'update' },
        { path: '/a/c.ts', kind: 'add' }
      ]
    },
    'ApplyPatch b.ts +1 more'
  ],
  ['ApplyPatch', {}, 'ApplyPatch']
])('%s', (n, i, s) => expect(toolSummary(n, i)).toBe(s))

test('truncates at 80', () => expect(toolSummary('Bash', { command: 'x'.repeat(200) })).toHaveLength(80))
