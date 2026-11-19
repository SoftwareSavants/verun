import { afterEach, describe, expect, test, vi } from 'vitest'
import { beginFileDrag, fileDrag, onFileDrop, __resetFileDragForTests } from './fileDrag'

const at = (type: string, x: number, y: number, target: EventTarget = window) =>
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }))
const press = (x: number, y: number) => beginFileDrag({ button: 0, clientX: x, clientY: y }, ['/w/src/a.ts'])

afterEach(() => __resetFileDragForTests())

describe('file drag', () => {
  test('a press that barely moves is a click, not a drag', () => {
    const drop = vi.fn(() => true)
    onFileDrop(drop)
    press(10, 10)
    at('pointermove', 12, 11)
    expect(fileDrag()).toBeNull()
    at('pointerup', 12, 11)
    expect(drop).not.toHaveBeenCalled()
  })

  test('a drag follows the pointer and drops where it is released', () => {
    const drop = vi.fn(() => true)
    onFileDrop(drop)
    press(10, 10)
    at('pointermove', 40, 50)
    expect(fileDrag()).toEqual({ paths: ['/w/src/a.ts'], x: 40, y: 50 })
    at('pointerup', 300, 200)
    expect(drop).toHaveBeenCalledWith(['/w/src/a.ts'], 300, 200)
    expect(fileDrag()).toBeNull()
  })

  test('the newest drop target that takes the drop gets it, alone', () => {
    const older = vi.fn(() => true)
    const declines = vi.fn(() => false)
    onFileDrop(older)
    onFileDrop(declines)
    press(0, 0)
    at('pointermove', 50, 50)
    at('pointerup', 50, 50)
    expect(declines).toHaveBeenCalled()
    expect(older).toHaveBeenCalledOnce()
  })

  test('releasing a drag is not also a click', () => {
    const click = vi.fn()
    document.body.addEventListener('click', click)
    press(0, 0)
    at('pointermove', 50, 50)
    at('pointerup', 50, 50)
    at('click', 50, 50, document.body)
    expect(click).not.toHaveBeenCalled()
    document.body.removeEventListener('click', click)
  })

  test('Escape cancels a drag without dropping', () => {
    const drop = vi.fn(() => true)
    onFileDrop(drop)
    press(0, 0)
    at('pointermove', 50, 50)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(fileDrag()).toBeNull()
    at('pointerup', 50, 50)
    expect(drop).not.toHaveBeenCalled()
  })

  test('only the primary button drags', () => {
    beginFileDrag({ button: 2, clientX: 0, clientY: 0 }, ['/x'])
    at('pointermove', 50, 50)
    expect(fileDrag()).toBeNull()
  })
})
