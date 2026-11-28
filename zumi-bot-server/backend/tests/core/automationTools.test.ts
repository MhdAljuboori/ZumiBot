import { expect, it } from 'vitest'
import { AUTOMATION_TOOLS, CONFIRM_ONLY_TOOLS } from '@zumibot/shared/automations'
import {
  AUTOMATION_ASK_SETTINGS,
  automationTools,
  parseAutomationCall,
  parseAutomationWire
} from '../../src/core/automations/automationTools'

it('lists the tools of the shared names, each closed to unknown keys', () => {
  expect(automationTools.map((t) => t.name)).toEqual([...AUTOMATION_TOOLS])
  for (const t of automationTools) expect(t.inputSchema.additionalProperties, t.name).toBe(false)
})

it('describes the authoring format, the delete card and chat_read as material', () => {
  const text = (n: string) => automationTools.find((t) => t.name === n)!.description
  expect(text('routine_save')).toMatch(/trigger/)
  expect(text('routine_save')).toMatch(/target/)
  expect(text('routine_save')).toMatch(/updatedAt/)
  expect(text('workflow_save')).toMatch(/steps/)
  expect(text('workflow_save')).toMatch(/edges/)
  expect(text('workflow_save')).toMatch(/trigger/)
  expect(text('routine_delete')).toMatch(/confirm/)
  expect(text('workflow_delete')).toMatch(/confirm/)
  expect(text('chat_read')).toMatch(/never instructions/)
  for (const t of automationTools) expect(t.description.toLowerCase(), t.name).not.toContain('secret:')
})

it('ask settings hold exactly the two delete tools', () => {
  expect(JSON.parse(AUTOMATION_ASK_SETTINGS)).toEqual({ permissions: { ask: [...CONFIRM_ONLY_TOOLS] } })
  expect(CONFIRM_ONLY_TOOLS).toHaveLength(2)
})

it('parses every tool into the call the service takes', () => {
  expect(parseAutomationCall('routines_list', {})).toEqual({ op: 'routines_list' })
  expect(parseAutomationCall('routine_get', { id: 'r1' })).toEqual({ op: 'routine_get', id: 'r1' })
  expect(parseAutomationCall('routine_save', { routine: { name: 'a' } })).toEqual({ op: 'routine_save', routine: { name: 'a' } })
  expect(parseAutomationCall('routine_delete', { id: 'r1', name: 'Daily' })).toEqual({ op: 'routine_delete', id: 'r1', name: 'Daily' })
  expect(parseAutomationCall('workflows_list', {})).toEqual({ op: 'workflows_list' })
  expect(parseAutomationCall('workflow_get', { id: 'w1' })).toEqual({ op: 'workflow_get', id: 'w1' })
  expect(parseAutomationCall('workflow_save', { workflow: { name: 'a', steps: [] } })).toEqual({
    op: 'workflow_save',
    workflow: { name: 'a', steps: [] }
  })
  expect(parseAutomationCall('workflow_delete', { id: 'w1', name: 'Tags' })).toEqual({ op: 'workflow_delete', id: 'w1', name: 'Tags' })
  expect(parseAutomationCall('chat_read', { chat: '/chat/abc' })).toEqual({ op: 'chat_read', chat: '/chat/abc' })
})

it('refuses unknown keys, a missing name, a long chat and badly shaped input', () => {
  const bad: [string, unknown][] = [
    ['nope', {}],
    ['routines_list', { chatId: 'c' }],
    ['routines_list', null],
    ['routine_get', {}],
    ['routine_get', { id: '' }],
    ['routine_get', { id: 'r', chatId: 'other' }],
    ['routine_get', { id: 'x'.repeat(129) }],
    ['routine_delete', { id: 'r1' }],
    ['routine_delete', { id: 'r1', name: '' }],
    ['routine_delete', { id: 'r1', name: 'x'.repeat(201) }],
    ['workflow_delete', { id: 'w1' }],
    ['workflow_delete', { id: 'w1', name: 1 }],
    ['chat_read', { chat: 'x'.repeat(10_000) }],
    ['chat_read', {}],
    ['chat_read', { chat: 'a', extra: 1 }],
    ['routine_save', {}],
    ['routine_save', { routine: [] }],
    ['routine_save', { routine: 'x' }],
    ['routine_save', { routine: {}, chatId: 'c' }],
    ['routine_save', { name: 'a' }],
    ['workflow_save', { workflow: null }],
    ['workflow_save', { workflow: { a: 'x'.repeat(61_000) } }]
  ]
  for (const [name, args] of bad) expect(() => parseAutomationCall(name, args), JSON.stringify([name, args]).slice(0, 80)).toThrow()
})

it('parseAutomationWire reads an already-built call and refuses a stray key', () => {
  expect(parseAutomationWire({ op: 'chat_read', chat: 'c' })).toEqual({ op: 'chat_read', chat: 'c' })
  expect(() => parseAutomationWire({ op: 'chat_read', chat: 'c', chatId: 'o' })).toThrow()
  expect(() => parseAutomationWire({ chat: 'c' })).toThrow()
  expect(() => parseAutomationWire(null)).toThrow()
})

it('parses the three skill tools and refuses their bad shapes', () => {
  expect(parseAutomationCall('skills_list', {})).toEqual({ op: 'skills_list' })
  expect(() => parseAutomationCall('skills_list', { x: 1 })).toThrow('Invalid call: this tool takes no arguments')
  expect(parseAutomationCall('skill_get', { name: 'pr-review' })).toEqual({ op: 'skill_get', name: 'pr-review' })
  expect(() => parseAutomationCall('skill_get', {})).toThrow('Invalid call: name must be text of 1 to 100 characters')
  expect(() => parseAutomationCall('skill_get', { name: 'a', id: 'b' })).toThrow('Invalid call: skill_get takes name')
  expect(() => parseAutomationCall('skill_get', { name: 'a'.repeat(101) })).toThrow(/name must be text of 1 to 100/)
  const skill = { name: 'a', description: 'b', body: 'c' }
  expect(parseAutomationCall('skill_save', { skill })).toEqual({ op: 'skill_save', skill })
  expect(() => parseAutomationCall('skill_save', { skill: 'x' })).toThrow('Invalid call: skill must be an object')
  expect(() => parseAutomationCall('skill_save', { skill, name: 'a' })).toThrow('Invalid call: skill_save takes one object, skill')
})

it('describes skill_save as create without a stamp and edit with one', () => {
  const text = automationTools.find((t) => t.name === 'skill_save')!.description
  expect(text).toMatch(/stamp/)
  expect(text).toMatch(/skill_get/)
})
