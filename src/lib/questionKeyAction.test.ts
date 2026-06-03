import { describe, test, expect } from 'vitest'
import { decideQuestionKeyAction, QUESTION_SKIP_MESSAGE } from './questionKeyAction'

const opts = [{ label: 'a' }, { label: 'b' }, { label: 'c' }]

describe('decideQuestionKeyAction', () => {
  test('number key with input focused → noop (let the custom answer field receive the keystroke)', () => {
    // Regression: typing "1" in the custom-answer field used to select
    // option 1 instead of inserting "1" into the input, because the global
    // keydown shortcut fired e.preventDefault() before the input received
    // its keystroke.
    const action = decideQuestionKeyAction({
      key: '1',
      shiftKey: false,
      isInputFocused: true,
      options: opts,
      hasMoreQuestions: false,
    })
    expect(action).toEqual({ kind: 'noop' })
  })

  test('number key without input focused → selectOption by 1-based index', () => {
    const action = decideQuestionKeyAction({
      key: '2',
      shiftKey: false,
      isInputFocused: false,
      options: opts,
      hasMoreQuestions: false,
    })
    expect(action).toEqual({ kind: 'selectOption', label: 'b' })
  })

  test('key past the option count → focus the custom answer input', () => {
    const action = decideQuestionKeyAction({
      key: '4',
      shiftKey: false,
      isInputFocused: false,
      options: opts,
      hasMoreQuestions: false,
    })
    expect(action).toEqual({ kind: 'focusCustom' })
  })

  test('Escape always denies with a skip message, even while typing in the custom input', () => {
    // Without a message, the backend defaults to "User denied this action",
    // which Claude renders as a tool denial in the chat. For AskUserQuestion
    // the user is actually skipping the question, not rejecting a tool —
    // forward a dismissal message so the agent gets that signal instead.
    const focused = decideQuestionKeyAction({
      key: 'Escape',
      shiftKey: false,
      isInputFocused: true,
      options: opts,
      hasMoreQuestions: false,
    })
    const unfocused = decideQuestionKeyAction({
      key: 'Escape',
      shiftKey: false,
      isInputFocused: false,
      options: opts,
      hasMoreQuestions: false,
    })
    expect(focused).toEqual({ kind: 'deny', message: QUESTION_SKIP_MESSAGE })
    expect(unfocused).toEqual({ kind: 'deny', message: QUESTION_SKIP_MESSAGE })
  })

  test('QUESTION_SKIP_MESSAGE does not phrase the action as a denial', () => {
    // The exact wording can move, but it must not look like the user
    // rejected the agent's request. Guarding the regression at the constant
    // level keeps the X button and Esc handler honest.
    expect(QUESTION_SKIP_MESSAGE.toLowerCase()).not.toContain('denied')
    expect(QUESTION_SKIP_MESSAGE.toLowerCase()).not.toContain('rejected')
  })

  test('Enter without focused input advances to next question when more remain', () => {
    const action = decideQuestionKeyAction({
      key: 'Enter',
      shiftKey: false,
      isInputFocused: false,
      options: opts,
      hasMoreQuestions: true,
    })
    expect(action).toEqual({ kind: 'next' })
  })

  test('Enter without focused input submits when on the last question', () => {
    const action = decideQuestionKeyAction({
      key: 'Enter',
      shiftKey: false,
      isInputFocused: false,
      options: opts,
      hasMoreQuestions: false,
    })
    expect(action).toEqual({ kind: 'submit' })
  })

  test('Enter while typing in the custom input → noop (input has its own Enter handler)', () => {
    const action = decideQuestionKeyAction({
      key: 'Enter',
      shiftKey: false,
      isInputFocused: true,
      options: opts,
      hasMoreQuestions: false,
    })
    expect(action).toEqual({ kind: 'noop' })
  })

  test('Shift+Enter without focused input → noop (reserved for multiline input)', () => {
    const action = decideQuestionKeyAction({
      key: 'Enter',
      shiftKey: true,
      isInputFocused: false,
      options: opts,
      hasMoreQuestions: false,
    })
    expect(action).toEqual({ kind: 'noop' })
  })

  test('letter key (no input focused) → noop', () => {
    const action = decideQuestionKeyAction({
      key: 'a',
      shiftKey: false,
      isInputFocused: false,
      options: opts,
      hasMoreQuestions: false,
    })
    expect(action).toEqual({ kind: 'noop' })
  })

  test('letter key while typing in the custom input → noop', () => {
    const action = decideQuestionKeyAction({
      key: 'a',
      shiftKey: false,
      isInputFocused: true,
      options: opts,
      hasMoreQuestions: false,
    })
    expect(action).toEqual({ kind: 'noop' })
  })
})
