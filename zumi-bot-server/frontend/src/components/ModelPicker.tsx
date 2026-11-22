import type { ModelPicker as PickerView } from '../state/commandModel'
import type { ChoiceView } from '../state/runPickers'
import { ChoicePicker } from './ChoicePicker'

/** The model picker's view as a plain choice list, and the note under its options (also the phone's one chip, `RunPicker`). */
export const modelChoice = (view: PickerView): ChoiceView => ({
  label: view.label,
  title: view.title,
  current: view.current,
  options: view.options.map((o) => ({ value: o.model, label: o.label }))
})
export const modelNote = (view: PickerView): string | undefined =>
  view.reloads ? 'Another model reloads this conversation once.' : undefined

/** The model a single chat (or the new-chat screen) runs on, and the menu that picks one by hand. */
export function ModelPicker({
  view,
  disabled = false,
  testId,
  onPick
}: {
  view: PickerView
  disabled?: boolean
  testId: string
  onPick: (model: string | null) => void
}) {
  return (
    <ChoicePicker
      view={modelChoice(view)}
      note={modelNote(view)}
      disabled={disabled}
      className="model-picker"
      testId={testId}
      menuTestId="chat-model-menu"
      optionTestId="chat-model-option"
      optionAttr="data-model"
      onPick={onPick}
    />
  )
}
