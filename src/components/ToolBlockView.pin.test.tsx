import { test, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'

vi.mock('../lib/ipc', () => ({}))
import { ToolBlockView } from './ChatView'

afterEach(() => cleanup())

test("an expanded tool row pins its header so it can be collapsed from anywhere in its output", () => {
  const { getByRole } = render(() => (
    <ToolBlockView id={`t-${Math.random()}`} tool="Bash" input='{"command":"pnpm test"}' result={{ text: 'ok', isError: false }} />
  ))
  const button = getByRole('button', { expanded: false })
  expect(button.parentElement!.className).not.toContain('sticky')
  fireEvent.click(button)
  expect(getByRole('button', { expanded: true }).parentElement!.className).toContain('sticky')
  fireEvent.click(getByRole('button', { expanded: true }))
  expect(getByRole('button', { expanded: false }).parentElement!.className).not.toContain('sticky')
})
