import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, expect, test, vi } from 'vitest'
import { Dialog } from './Dialog'

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
