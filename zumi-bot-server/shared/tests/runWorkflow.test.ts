import { describe, expect, it } from 'vitest'
import { NO_WORKFLOW_NAMED, afterWorkflowName, resolveRunWorkflow, runWorkflowRest, sameNameText } from '@zumibot/shared/runWorkflow'

describe('runWorkflowRest', () => {
  it('returns the trimmed text after a leading command', () => {
    expect(runWorkflowRest('/run-workflow Daily report go')).toBe('Daily report go')
    expect(runWorkflowRest('/run-workflow   Daily  ')).toBe('Daily')
    expect(runWorkflowRest('/run-workflow\nDaily')).toBe('Daily')
  })
  it('is empty when nothing follows', () => {
    expect(runWorkflowRest('/run-workflow')).toBe('')
    expect(runWorkflowRest('/run-workflow   ')).toBe('')
  })
  it('is null for another command or a command not at index 0', () => {
    expect(runWorkflowRest('/run-workflowx a')).toBeNull()
    expect(runWorkflowRest(' /run-workflow a')).toBeNull()
    expect(runWorkflowRest('hi /run-workflow a')).toBeNull()
    expect(runWorkflowRest('/run-workflo a')).toBeNull()
    expect(runWorkflowRest('')).toBeNull()
  })
})

const ws = (...names: string[]): { id: string; name: string }[] => names.map((name, i) => ({ id: `w${i}`, name }))

describe('resolveRunWorkflow', () => {
  it('picks the workflow named first and trims the input', () => {
    expect(resolveRunWorkflow('Daily report  now please ', ws('Daily report'))).toEqual({ id: 'w0', input: 'now please' })
    expect(resolveRunWorkflow('Daily report', ws('Daily report'))).toEqual({ id: 'w0', input: '' })
    expect(resolveRunWorkflow('Daily report\nline one\nline two', ws('Daily report'))).toEqual({ id: 'w0', input: 'line one\nline two' })
  })
  it('compares case-insensitively and trims workflow names', () => {
    expect(resolveRunWorkflow('DAILY REPORT go', ws('  daily Report '))).toEqual({ id: 'w0', input: 'go' })
  })
  it('takes the longest name when one is a prefix of another', () => {
    expect(resolveRunWorkflow('report weekly now', ws('Report', 'Report weekly'))).toEqual({ id: 'w1', input: 'now' })
    expect(resolveRunWorkflow('report weekly now', ws('Report weekly', 'Report'))).toEqual({ id: 'w0', input: 'now' })
    expect(resolveRunWorkflow('report monthly now', ws('Report', 'Report weekly'))).toEqual({ id: 'w0', input: 'monthly now' })
  })
  it('needs whitespace or the end after the name', () => {
    expect(resolveRunWorkflow('Reporting now', ws('Report'))).toEqual({ error: NO_WORKFLOW_NAMED })
    expect(resolveRunWorkflow('Reporting now', ws('Report', 'Reporting'))).toEqual({ id: 'w1', input: 'now' })
  })
  it('fails when no name matches, nothing is named, or no workflow exists', () => {
    expect(resolveRunWorkflow('Other thing', ws('Report'))).toEqual({ error: NO_WORKFLOW_NAMED })
    expect(resolveRunWorkflow('', ws('Report'))).toEqual({ error: NO_WORKFLOW_NAMED })
    expect(resolveRunWorkflow('Report', [])).toEqual({ error: NO_WORKFLOW_NAMED })
  })
  it('ignores a workflow with an empty name', () => {
    expect(resolveRunWorkflow('anything', ws('', '   '))).toEqual({ error: NO_WORKFLOW_NAMED })
  })
  it('refuses two workflows with the winning name, spelled as the first one is', () => {
    expect(resolveRunWorkflow('report x', ws('Report', 'report'))).toEqual({ error: sameNameText('Report') })
    expect(sameNameText('Report')).toBe('Several workflows are named "Report"')
  })
  it('a duplicate of a shorter name does not block a longer unique one', () => {
    expect(resolveRunWorkflow('report weekly x', ws('Report', 'report', 'Report weekly'))).toEqual({ id: 'w2', input: 'x' })
  })
})

describe('afterWorkflowName', () => {
  it('is the trimmed text past a leading name, compared case-insensitively', () => {
    expect(afterWorkflowName('Report go now ', 'Report')).toBe('go now')
    expect(afterWorkflowName('report\nline', 'Report')).toBe('line')
    expect(afterWorkflowName('REPORT', ' Report ')).toBe('')
  })
  it('is null when the text does not start with the whole name', () => {
    expect(afterWorkflowName('Reporting go', 'Report')).toBeNull()
    expect(afterWorkflowName('Repor', 'Report')).toBeNull()
    expect(afterWorkflowName('go Report', 'Report')).toBeNull()
    expect(afterWorkflowName('anything', '  ')).toBeNull()
  })
})
