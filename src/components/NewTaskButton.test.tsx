import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
vi.mock('../lib/ipc', () => ({ openTaskWindow: vi.fn() }))
vi.mock('../store/newTask', () => ({ openNewTask: vi.fn() }))
import { NewTaskButton } from './NewTaskButton'
import { openNewTask } from '../store/newTask'
import { setNewTaskProjectId, setSelectedTaskId, setShowArchived, setShowSettings, setShowTaskBoard } from '../store/ui'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  setNewTaskProjectId(null)
  setSelectedTaskId('t1')
  setShowSettings(false)
  setShowArchived(false)
})
const button = () => screen.getByRole('button', { name: /New task/ })

test('starts a task from either sidebar view and shows its shortcut', () => {
  render(() => <NewTaskButton />)
  expect(button().textContent).toContain('⌘N')
  fireEvent.click(button())
  expect(openNewTask).toHaveBeenCalledOnce()
})

test('reads as the current page only while the draft is on screen', () => {
  render(() => <NewTaskButton />)
  expect(button().getAttribute('aria-current')).toBeNull()
  setNewTaskProjectId('p')
  setSelectedTaskId(null)
  expect(button().getAttribute('aria-current')).toBe('page')
  setShowTaskBoard(true)
  expect(button().getAttribute('aria-current')).toBeNull()
  setShowTaskBoard(false)
  setSelectedTaskId('t1')
  expect(button().getAttribute('aria-current')).toBeNull()
})
