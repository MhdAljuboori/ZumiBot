import { MATERIAL_RULE } from '@zumibot/shared/workflowTemplate'

// Same text for a workflow's every step, so the prompt cache holds; the name is user text, so it stays one line and cannot close its quotes.
export function workflowSystem(name: string): string {
  const clean = name.replace(/\s+/g, ' ').replace(/"/g, "'").trim() || 'Workflow'
  return `This turn is a step of the workflow "${clean}". ${MATERIAL_RULE}`
}
