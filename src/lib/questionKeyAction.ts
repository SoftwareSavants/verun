// What we tell the agent when the user dismisses the question without
// answering. The default backend deny message is "User denied this action",
// which mis-frames a skip as a rejection - the agent then narrates "the user
// denied this action" in chat. This phrasing makes it clear the user simply
// moved on without picking an option.
export const QUESTION_SKIP_MESSAGE = 'User dismissed this question without answering.'

export type QuestionKeyAction =
  | { kind: 'noop' }
  | { kind: 'deny'; message: string }
  | { kind: 'selectOption'; label: string }
  | { kind: 'focusCustom' }
  | { kind: 'next' }
  | { kind: 'submit' }

export interface QuestionKeyInput {
  key: string
  shiftKey: boolean
  isInputFocused: boolean
  options: { label: string }[]
  hasMoreQuestions: boolean
}

// Pure dispatcher for the AskUserQuestion overlay's global keyboard shortcuts.
// When any input/textarea is focused (e.g. the "Or type a custom answer..."
// field), printable keys must NOT be intercepted — otherwise typing "1" in
// the custom input selects option 1 instead of inserting the digit. Escape
// is the only shortcut that fires regardless of focus.
export function decideQuestionKeyAction(input: QuestionKeyInput): QuestionKeyAction {
  if (input.key === 'Escape') return { kind: 'deny', message: QUESTION_SKIP_MESSAGE }
  if (input.isInputFocused) return { kind: 'noop' }

  const num = parseInt(input.key, 10)
  const optCount = input.options.length
  if (Number.isFinite(num) && num >= 1 && num <= optCount) {
    return { kind: 'selectOption', label: input.options[num - 1].label }
  }
  if (Number.isFinite(num) && num === optCount + 1) {
    return { kind: 'focusCustom' }
  }
  if (input.key === 'Enter' && !input.shiftKey) {
    return input.hasMoreQuestions ? { kind: 'next' } : { kind: 'submit' }
  }
  return { kind: 'noop' }
}
