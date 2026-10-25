import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Dialog } from './Dialog'
import { ConfirmDialog } from './ConfirmDialog'

afterEach(cleanup)

test('Enter confirms a select choice without submitting its dialog', () => {
  const confirm = vi.fn()
  const view = render(() => <Dialog open onClose={() => {}} onConfirm={confirm}>
    <select aria-label="Source"><option>Local</option><option>Cloud</option></select>
  </Dialog>)
  fireEvent.keyDown(view.getByLabelText('Source'), { key: 'Enter' })
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: 'Enter' })
  expect(confirm).toHaveBeenCalledOnce()
})

// Enter on a focused button of the dialog presses that button. The dialog's own
// Enter is for everything else, so a Cancel the user tabbed to is never read as
// "confirm", and a button elsewhere on the page is none of the dialog's business.
describe('Enter in a dialog that confirms', () => {
  function open() {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const view = render(() => (
      <>
        <button type="button">Open</button>
        <ConfirmDialog open title="Discard?" message="This cannot be undone." confirmLabel="Discard" onConfirm={onConfirm} onCancel={onCancel}>
          <input aria-label="Reason" />
          <button type="button">Show details</button>
        </ConfirmDialog>
      </>
    ))
    return { onConfirm, onCancel, view }
  }

  test('on Cancel is left to Cancel, so it does not confirm', () => {
    const { onConfirm, view } = open()

    const notPrevented = fireEvent.keyDown(view.getByRole('button', { name: 'Cancel' }), { key: 'Enter' })

    expect(onConfirm).not.toHaveBeenCalled()
    // Not claimed either: the browser presses the focused button.
    expect(notPrevented).toBe(true)
  })

  test('on another button is left to that button', () => {
    const { onConfirm, view } = open()

    const notPrevented = fireEvent.keyDown(view.getByRole('button', { name: 'Show details' }), { key: 'Enter' })

    expect(onConfirm).not.toHaveBeenCalled()
    expect(notPrevented).toBe(true)
  })

  test('on the confirm button confirms, once', () => {
    const { onConfirm, view } = open()

    const notPrevented = fireEvent.keyDown(view.getByRole('button', { name: 'Discard' }), { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledOnce()
    // Claimed, so the browser's press of the button is not a second confirm.
    expect(notPrevented).toBe(false)
  })

  // Some webviews focus a button when it is clicked, so the one that opened the
  // dialog is still the target of the next Enter. It is not the dialog's to press.
  test('on a button outside the dialog still confirms, and is not pressed again', () => {
    const { onConfirm, view } = open()

    const notPrevented = fireEvent.keyDown(view.getByRole('button', { name: 'Open' }), { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(notPrevented).toBe(false)
  })

  test('in a dialog that sits inside a button still confirms from its own field', () => {
    const onConfirm = vi.fn()
    const view = render(() => (
      <button type="button">
        <ConfirmDialog open title="Discard?" message="This cannot be undone." onConfirm={onConfirm} onCancel={() => {}}>
          <input aria-label="Reason" />
        </ConfirmDialog>
      </button>
    ))

    fireEvent.keyDown(view.getByLabelText('Reason'), { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledOnce()
  })

  test('anywhere else still confirms', () => {
    const { onConfirm, view } = open()

    fireEvent.keyDown(view.getByLabelText('Reason'), { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(3)
  })

  test('Cancel still cancels when pressed', () => {
    const { onCancel, onConfirm, view } = open()

    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  test('Escape still closes it', () => {
    const { onCancel, view } = open()

    fireEvent.keyDown(view.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledOnce()
  })
})
