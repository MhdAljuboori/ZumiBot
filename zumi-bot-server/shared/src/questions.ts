import { displayName } from './frontmatter'
import type { QuestionAnswers } from './types'

/** The CLI's tool name; its can_use_tool request carries these questions as `input`. */
export const QUESTION_TOOL = 'AskUserQuestion'

/** Per answer, and for all answers of one call. Matches the card's text box cap. */
export const ANSWER_MAX_CHARS = 8192
export const ANSWERS_MAX_CHARS = 32768

export interface QuestionOption {
  label: string
  description: string | null
  preview: string | null
}

export interface Question {
  text: string
  header: string
  kind: 'choice' | 'text' | 'number'
  multiSelect: boolean
  options: QuestionOption[]
  description: string | null
  placeholder: string | null
  min: number | null
  max: number | null
  step: number | null
  defaultValue: number | null
  unit: string | null
}

const KINDS = ['choice', 'text', 'number'] as const
type Kind = (typeof KINDS)[number]

type Obj = Record<string, unknown>

// Rejects arrays, Dates and class instances: the input comes straight from JSON.
function isPlainObject(v: unknown): v is Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const isKind = (v: unknown): v is Kind => (KINDS as readonly unknown[]).includes(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
// A blank label or question would render an empty row the user could not meaningfully answer.
const isBlank = (s: string): boolean => s.trim() === ''

function parseOption(v: unknown): QuestionOption | null {
  if (!isPlainObject(v) || typeof v.label !== 'string' || isBlank(v.label)) return null
  return { label: v.label, description: str(v.description), preview: str(v.preview) }
}

function parseQuestion(v: unknown): Question | null {
  if (!isPlainObject(v) || typeof v.question !== 'string' || isBlank(v.question)) return null
  const kind: unknown = v.kind ?? 'choice'
  if (!isKind(kind)) return null
  const rawOptions = v.options ?? []
  if (!Array.isArray(rawOptions)) return null
  const options: QuestionOption[] = []
  for (const raw of rawOptions) {
    const opt = parseOption(raw)
    if (!opt) return null
    options.push(opt)
  }
  return {
    text: v.question,
    header: str(v.header) ?? '',
    kind,
    // Text and number answers are always one string, even if the CLI sets multiSelect on them.
    multiSelect: kind === 'choice' && v.multiSelect === true,
    options,
    description: str(v.description),
    placeholder: str(v.placeholder),
    min: num(v.min),
    max: num(v.max),
    step: num(v.step),
    defaultValue: num(v.defaultValue),
    unit: str(v.unit)
  }
}

/** Returns null for anything the card cannot show. Callers then fall back to a plain approval. */
export function parseQuestions(input: unknown): { title: string | null; questions: Question[] } | null {
  if (!isPlainObject(input) || !Array.isArray(input.questions) || input.questions.length === 0) return null
  const questions: Question[] = []
  const texts = new Set<string>()
  for (const raw of input.questions) {
    const q = parseQuestion(raw)
    // Answers are keyed by question text, so two questions with one text cannot be told apart.
    if (!q || texts.has(q.text)) return null
    texts.add(q.text)
    questions.push(q)
  }
  const title = str(input.title)
  return { title: title !== null && !isBlank(title) ? title : null, questions }
}

/**
 * The card's heading: the input's own `title`, else one naming the agent and the question count (also the group
 * tray row's text for a pending question card). `agent` is null for a single chat's card.
 */
export function questionHeading(title: string | null, questionCount: number, agent: string | null): string {
  if (title) return title
  if (agent) return `${displayName(agent)} asked ${questionCount} question${questionCount === 1 ? '' : 's'}`
  return questionCount === 1 ? 'A question for you' : `${questionCount} questions for you`
}

function checkValue(v: unknown, text: string): string {
  if (typeof v !== 'string' || isBlank(v) || v.length > ANSWER_MAX_CHARS) {
    throw new TypeError(`answer for "${text}" must be a non-blank string of at most ${ANSWER_MAX_CHARS} chars`)
  }
  return v
}

/**
 * Validates a user's answers against the questions the agent asked. Throws TypeError on any mismatch;
 * the answers are then sent back to the CLI unchanged.
 */
export function checkAnswers(input: unknown, answers: unknown): QuestionAnswers {
  const parsed = parseQuestions(input)
  if (!parsed) throw new TypeError('AskUserQuestion input is malformed')
  // The server adds its own `answers` to the input it sends back. Input that already has one is not ours to trust.
  if (Object.hasOwn(input as object, 'answers')) throw new TypeError('AskUserQuestion input already carries answers')
  if (!isPlainObject(answers)) throw new TypeError('answers must be an object keyed by question text')

  const keys = Object.keys(answers)
  if (keys.length !== parsed.questions.length) throw new TypeError('answers must have exactly one entry per question')

  let total = 0
  for (const q of parsed.questions) {
    if (!Object.hasOwn(answers, q.text)) throw new TypeError(`no answer for "${q.text}"`)
    const v = answers[q.text]
    if (q.multiSelect) {
      if (!Array.isArray(v) || v.length < 1 || v.length > q.options.length + 1) {
        // One extra slot is the "Other" free-text choice.
        throw new TypeError(`answer for "${q.text}" must list 1 to ${q.options.length + 1} choices`)
      }
      for (const item of v) total += checkValue(item, q.text).length
    } else {
      total += checkValue(v, q.text).length
    }
    if (total > ANSWERS_MAX_CHARS) throw new TypeError(`answers exceed ${ANSWERS_MAX_CHARS} chars in total`)
  }
  return answers as QuestionAnswers
}
