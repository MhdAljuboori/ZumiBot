import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_PREFIX,
  AUTOMATION_TOOLS,
  AUTOMATIONS_SERVER,
  CHAT_READ_MAX,
  CONFIRM_ONLY_TOOLS,
  STALE_REFUSED,
  WRITE_REFUSED,
  automationSummary,
  automationTool,
  confirmOnly
} from '@zumibot/shared/automations'
import { archivedFromPath, chatIdFromPath, routinesPath, todosFromPath, workflowsPath } from '@zumibot/shared/appPaths'

describe('names', () => {
  it('builds the full tool names from the server name', () => {
    expect(AUTOMATION_PREFIX).toBe(`mcp__${AUTOMATIONS_SERVER}__`)
    expect(AUTOMATION_TOOLS).toHaveLength(12)
    expect(AUTOMATION_TOOLS.slice(-3)).toEqual(['skills_list', 'skill_get', 'skill_save'])
    expect(CHAT_READ_MAX).toBe(150_000)
    expect(WRITE_REFUSED).toBe('Routines, workflows and skills can only be changed from a message the user sends.')
    expect(STALE_REFUSED).toBe('It changed since you read it: read it again.')
  })
  it('automationTool matches only this server', () => {
    expect(automationTool('mcp__zumibot_automations__routine_save')).toBe(true)
    expect(automationTool('mcp__zumibot_todos__add')).toBe(false)
    expect(automationTool('Bash')).toBe(false)
  })
})

describe('confirmOnly', () => {
  it('is only the two deletes', () => {
    expect(confirmOnly('mcp__zumibot_automations__routine_delete')).toBe(true)
    expect(confirmOnly('mcp__zumibot_automations__workflow_delete')).toBe(true)
    expect(confirmOnly('mcp__zumibot_automations__routine_save')).toBe(false)
    expect(confirmOnly('mcp__other__routine_delete')).toBe(false)
    expect(CONFIRM_ONLY_TOOLS).toHaveLength(2)
  })
})

describe('automationSummary', () => {
  it('names the target', () => {
    expect(automationSummary('mcp__zumibot_automations__routine_delete', { id: 'a', name: 'Daily tech' })).toBe(
      'Delete routine “Daily tech”'
    )
    expect(automationSummary('mcp__zumibot_automations__workflow_delete', { id: 'a', name: 'W' })).toBe('Delete workflow “W”')
    expect(automationSummary('mcp__zumibot_automations__routine_delete', { id: 'a' })).toBeNull()
    expect(automationSummary('mcp__zumibot_automations__routine_delete', null)).toBeNull()
    expect(automationSummary('mcp__zumibot_automations__routine_save', { name: 'x' })).toBeNull()
    expect(automationSummary('Bash', { name: 'x' })).toBeNull()
  })
})

describe('app paths', () => {
  it('builds and parses the routine and workflow addresses', () => {
    expect(routinesPath(null)).toBe('/routines')
    expect(routinesPath({ id: null })).toBe('/routines/new')
    expect(routinesPath({ id: 'a b' })).toBe('/routines/a%20b')
    expect(workflowsPath(null)).toBe('/workflows')
    expect(workflowsPath('w', 'r', true)).toBe('/workflows/w/runs/r/audit')
    expect(workflowsPath(null, 'r')).toBe('/workflows')
  })
  it('parses chat, archived and todos addresses', () => {
    expect(chatIdFromPath('/chat/abc')).toBe('abc')
    expect(chatIdFromPath('/chat/a/b')).toBeNull()
    expect(archivedFromPath('/archived/x')).toEqual({ chatId: 'x' })
    expect(todosFromPath('/todos')).toEqual({ taskId: null })
  })
})
