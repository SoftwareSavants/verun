import { afterEach, expect, test } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import { FileDragGhost } from './FileDragGhost'
import { beginFileDrag, __resetFileDragForTests } from '../store/fileDrag'

afterEach(() => { cleanup(); __resetFileDragForTests() })
const move = (x: number, y: number) => window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }))

test('names the dragged file beside the pointer, and only while dragging', () => {
  render(() => <FileDragGhost />)
  expect(document.body.textContent).not.toContain('a.ts')
  beginFileDrag({ button: 0, clientX: 0, clientY: 0 }, ['/w/src/lib/a.ts'])
  move(100, 50)
  const ghost = document.querySelector('[data-file-drag-ghost]') as HTMLElement
  expect(ghost.textContent).toContain('a.ts')
  expect(ghost.style.transform).toBe('translate(112px, 62px)')
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: 100, clientY: 50 }))
  expect(document.querySelector('[data-file-drag-ghost]')).toBeNull()
})
