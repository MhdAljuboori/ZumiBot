import type { StepKind } from './workflows'

// The fields a new step starts with. Shared so the canvas and the server (Zumi Bot's workflow tools) fill a step the same way.
export function stepDefaults(kind: Exclude<StepKind, 'trigger'>): Record<string, unknown> {
  switch (kind) {
    case 'llm':
      return { model: 'haiku', effort: 'low', prompt: '' }
    case 'condition':
      return { model: 'haiku', question: '' }
    case 'approval':
      return { question: 'Approve?', editable: true }
    case 'wait':
      return { minutes: 5 }
    case 'notify':
      return { title: '' }
    case 'http':
      return { method: 'GET', url: '', headers: [], bodyType: 'json' }
    case 'transform':
      return { fields: [], format: 'json' }
    case 'workflow':
      return { workflow: '', input: '{{input}}' }
    case 'chat':
      return { chat: '', prompt: '{{input}}' }
    case 'room':
      return { room: '', prompt: '{{input}}' }
    case 'agent':
    case 'foreach':
      return { agent: '', prompt: '', cwd: '' }
  }
}
