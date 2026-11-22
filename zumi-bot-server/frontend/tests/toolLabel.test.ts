import { describe, expect, it } from 'vitest'
import { AGUI_TEXT, AGUI_TOOL } from '@zumibot/shared/agui'
import { toolLabel } from '../src/state/toolLabel'

describe('toolLabel', () => {
  it('Bash: its description, the whole command on one line under it', () => {
    expect(toolLabel('Bash', { command: "python3 -c '\nimport json\nprint(1)'", description: 'Count the open cards' })).toEqual({
      title: 'Count the open cards',
      detail: "python3 -c ' import json print(1)'"
    })
  })
  it('Bash without a description: the command is the detail', () => {
    expect(toolLabel('Bash', { command: 'ls -la' })).toEqual({ title: 'Bash', detail: 'ls -la' })
  })
  it('caps a long command', () => {
    const d = toolLabel('Bash', { command: 'x'.repeat(500), description: 'd' }).detail ?? ''
    expect(d).toHaveLength(300)
    expect(d.endsWith('…')).toBe(true)
  })
  it('file tools: the file name, with the line range of a partial Read, and the path under it', () => {
    expect(toolLabel('Read', { file_path: '/tmp/wk/SKILL.md' })).toEqual({ title: 'Read SKILL.md', detail: '/tmp/wk/SKILL.md' })
    expect(toolLabel('Read', { file_path: '/a/b.ts', offset: 40, limit: 80 }).title).toBe('Read b.ts (lines 40–119)')
    expect(toolLabel('Read', { file_path: '/a/b.ts', limit: 50 }).title).toBe('Read b.ts (lines 1–50)')
    expect(toolLabel('Read', { file_path: '/a/b.ts', offset: 7 }).title).toBe('Read b.ts (from line 7)')
    expect(toolLabel('Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' })).toEqual({ title: 'Edit b.ts', detail: '/a/b.ts' })
    expect(toolLabel('NotebookEdit', { notebook_path: '/n/x.ipynb' }).title).toBe('Edit x.ipynb')
    expect(toolLabel('Write', {})).toEqual({ title: 'Write', detail: null })
  })
  it('searches and the web', () => {
    expect(toolLabel('Grep', { pattern: 'isOpen', path: 'src', glob: '*.ts' })).toEqual({
      title: 'Search for isOpen',
      detail: 'src · *.ts'
    })
    expect(toolLabel('Glob', { pattern: '**/*.md' })).toEqual({ title: 'Find files **/*.md', detail: null })
    expect(toolLabel('WebFetch', { url: 'https://docs.example.com/a?b=1', prompt: 'p' })).toEqual({
      title: 'Fetch docs.example.com',
      detail: 'https://docs.example.com/a?b=1'
    })
    expect(toolLabel('WebSearch', { query: 'angular 22' })).toEqual({ title: 'Search the web: angular 22', detail: null })
  })
  it('Agent: its description, the subagent type under it', () => {
    expect(toolLabel('Agent', { description: 'Find callers', subagent_type: 'Explore', prompt: 'p' })).toEqual({
      title: 'Agent: Find callers',
      detail: 'Explore'
    })
    expect(toolLabel('Task', { prompt: 'p' })).toEqual({ title: 'Agent', detail: null })
  })
  it('MCP tools: the tool in words, its server and first text argument under it', () => {
    expect(toolLabel('mcp__workiom__get_record', { listId: 'L1', id: 7 })).toEqual({ title: 'get record', detail: 'workiom · L1' })
    expect(toolLabel('mcp__workiom__list_lists', {})).toEqual({ title: 'list lists', detail: 'workiom' })
  })
  it('desktop actions use their summary; other tools the plain summary', () => {
    expect(toolLabel('mcp__zumibot_desktop__desktop_click', { x: 412, y: 300 }).title).toMatch(/412, 300/)
    expect(toolLabel('Skill', { skill: 'workiom' })).toEqual({ title: 'Skill workiom', detail: null })
  })
  it('a routine or workflow delete: the exact target as the head, its server under it', () => {
    expect(toolLabel('mcp__zumibot_automations__workflow_delete', { id: 'x', name: 'Hashtags' })).toEqual({
      title: 'Delete workflow “Hashtags”',
      detail: 'zumibot_automations · x'
    })
    expect(toolLabel('mcp__zumibot_automations__routine_delete', { id: 'x', name: 'Morning' }).title).toBe('Delete routine “Morning”')
    expect(toolLabel('mcp__zumibot_automations__routine_delete', { id: 'x' }).title).toBe('routine delete')
  })
  it('Codex ApplyPatch: the first file name, and how many more', () => {
    expect(toolLabel('ApplyPatch', { changes: [{ path: '/a/b.ts', kind: 'update' }] })).toEqual({ title: 'Apply patch', detail: 'b.ts' })
    expect(
      toolLabel('ApplyPatch', {
        changes: [
          { path: '/a/b.ts', kind: 'update' },
          { path: '/a/c.ts', kind: 'add' },
          { path: '/d.ts', kind: 'delete' }
        ]
      })
    ).toEqual({ title: 'Apply patch', detail: 'b.ts +2 more' })
    expect(toolLabel('ApplyPatch', {})).toEqual({ title: 'Apply patch', detail: null })
  })
  it('Codex SandboxPermissions: a plain title', () => {
    expect(toolLabel('SandboxPermissions', { permissions: {} })).toEqual({ title: 'Sandbox permissions', detail: null })
  })
  it('Codex Subagents (a wait or another call on its subagents): what it did, the subagents it named under it', () => {
    expect(toolLabel('Subagents', { tool: 'wait' })).toEqual({ title: 'Wait for subagents', detail: null })
    expect(toolLabel('Subagents', { tool: 'sendInput', agents: ['helper'], prompt: 'Also check b.txt' })).toEqual({
      title: 'Message a subagent',
      detail: 'helper'
    })
    expect(toolLabel('Subagents', { tool: 'closeAgent', agents: ['helper', 'grand'] })).toEqual({
      title: 'Close a subagent',
      detail: 'helper, grand'
    })
    expect(toolLabel('Subagents', { tool: 'resumeAgent', agents: ['helper'] })).toEqual({ title: 'Resume a subagent', detail: 'helper' })
    expect(toolLabel('Subagents', { tool: 'frobnicate' })).toEqual({ title: 'Subagents: frobnicate', detail: null })
    expect(toolLabel('Subagents', {})).toEqual({ title: 'Subagents', detail: null })
    expect(toolLabel('Subagents', { tool: 'toString' }).title).toBe('Subagents: toString')
    // The names are the agent's text: hidden characters show as escapes.
    expect(toolLabel('Subagents', { tool: 'wait', agents: ['a‮b'] }).detail).toBe('a\\u{202e}b')
  })
  it("a remote agent's tool: its name, saying it ran on the remote server, and its arguments under it", () => {
    expect(AGUI_TOOL).toBe('AguiTool')
    expect(toolLabel(AGUI_TOOL, { tool: 'search', args: { q: 'docs' } })).toEqual({
      title: 'search (ran on the remote server)',
      detail: '{"q":"docs"}'
    })
    expect(toolLabel(AGUI_TOOL, { tool: 'fetch', args: null, argsText: 'not json\n at all' })).toEqual({
      title: 'fetch (ran on the remote server)',
      detail: 'not json at all'
    })
    expect(toolLabel(AGUI_TOOL, { tool: 'ping', args: {} }).title).toBe(AGUI_TEXT.remoteTool('ping'))
    expect(toolLabel(AGUI_TOOL, {})).toEqual({ title: AGUI_TEXT.remoteTool(null), detail: null })
    expect(toolLabel(AGUI_TOOL, { tool: 'noop', args: null }).detail).toBeNull()
    // The server names the tool: hidden characters show as escapes, and a long name is cut.
    expect(toolLabel(AGUI_TOOL, { tool: 'a‮b', args: {} }).title).toBe('a\\u{202e}b (ran on the remote server)')
    expect(toolLabel(AGUI_TOOL, { tool: 'x'.repeat(500), args: {} }).title.length).toBeLessThan(260)
  })
  it('shows hidden characters an agent wrote as escapes', () => {
    expect(toolLabel('Bash', { command: 'ls', description: 'safe‮txt.exe' }).title).toBe('safe\\u{202e}txt.exe')
  })
})
