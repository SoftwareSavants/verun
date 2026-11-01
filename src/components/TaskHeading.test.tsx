import { cleanup, render, screen } from '@solidjs/testing-library'
import { afterEach, expect, test } from 'vitest'
import { createSignal } from 'solid-js'
import { TaskHeading } from './TaskHeading'
afterEach(cleanup)
test('shows project and task context and updates when switching tasks', () => {
  const [project, setProject] = createSignal('Mouyassir')
  render(() => <TaskHeading projectName={project()} taskName="Investigate notifications" />)
  expect(screen.getByText('Mouyassir').title).toBe('Mouyassir')
  expect(screen.getByRole('heading').textContent).toBe('Investigate notifications')
  setProject('Verun')
  expect(screen.queryByText('Mouyassir')).toBeNull()
  expect(screen.getByText('Verun')).toBeTruthy()
})
