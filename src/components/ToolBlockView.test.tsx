import { test, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'

vi.mock('../lib/ipc', () => ({}))
vi.mock('../store/editorView', async (orig) => ({ ...(await orig<object>()), openFile: vi.fn(), setPendingGoToLine: vi.fn() }))
import { ToolBlockView } from './ChatView'
import { openFile } from '../store/editorView'

afterEach(() => cleanup())
const id = () => `t-${Math.random()}`

test('an expanded tool row pins its header so it can be collapsed from anywhere in its output', () => {
  const { getByRole } = render(() => (
    <ToolBlockView id={id()} tool="Bash" input='{"command":"pnpm test"}' result={{ text: 'ok', isError: false }} />
  ))
  const button = getByRole('button', { expanded: false })
  expect(button.parentElement!.className).not.toContain('sticky')
  fireEvent.click(button)
  expect(getByRole('button', { expanded: true }).parentElement!.className).toContain('sticky')
  fireEvent.click(getByRole('button', { expanded: true }))
  expect(getByRole('button', { expanded: false }).parentElement!.className).not.toContain('sticky')
})

test('a failed tool says so while collapsed, with the first line of its error', () => {
  const { container } = render(() => (
    <ToolBlockView id={id()} tool="Bash" input='{"command":"pnpm test"}' result={{ text: '\nFAIL src/a.test.ts > renders\nAssertionError', isError: true }} />
  ))
  const text = container.textContent ?? ''
  expect(text).toContain('Failed')
  expect(text).toContain('FAIL src/a.test.ts > renders')
  expect(container.querySelector('[aria-label="Failed"]')).not.toBeNull()
})

test('a tool still running shows a spinner; a finished one stays quiet', () => {
  const running = render(() => <ToolBlockView id={id()} tool="Bash" input='{"command":"pnpm test"}' live />)
  expect(running.container.querySelector('[aria-label="Running"]')).not.toBeNull()
  cleanup()
  const done = render(() => <ToolBlockView id={id()} tool="Bash" input='{"command":"pnpm test"}' result={{ text: 'ok', isError: false }} live />)
  expect(done.container.querySelector('[aria-label="Running"]')).toBeNull()
  expect(done.container.textContent).not.toContain('Failed')
})

test("Cmd/Ctrl-click on a Read row opens its file instead of expanding it", () => {
  const { getByRole } = render(() => (
    <ToolBlockView id={id()} taskId="task-1" tool="Read" input='{"file_path":"/Users/dev/app/.verun/worktrees/x/src/a.ts"}' result={{ text: '1\tx', isError: false }} />
  ))
  fireEvent.click(getByRole('button', { expanded: false }), { metaKey: true, ctrlKey: true })
  expect(openFile).toHaveBeenCalledWith('task-1', 'src/a.ts', 'a.ts')
  expect(getByRole('button', { expanded: false })).toBeTruthy()
})

test('an expanded row with output offers to copy it', () => {
  const { getByRole } = render(() => (
    <ToolBlockView id={id()} tool="Bash" input='{"command":"pnpm test"}' result={{ text: 'all good', isError: false }} />
  ))
  fireEvent.click(getByRole('button', { expanded: false }))
  expect(getByRole('button', { name: 'Copy output' })).toBeTruthy()
})
