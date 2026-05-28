import { describe, it, expect, vi } from 'vitest'
import { buildTaskMenuItems } from './taskMenu'

const baseHandlers = () => ({
  onOpenInNewWindow: vi.fn(),
  onRename: vi.fn(),
  onOpenInFinder: vi.fn(),
  onStartApp: vi.fn(),
  onStopApp: vi.fn(),
  onSetupStartCommand: vi.fn(),
  onArchive: vi.fn(),
})

const baseState = {
  isRunning: false,
  isSetupRunning: false,
  hasStartCommand: true,
}

function labels(items: ReturnType<typeof buildTaskMenuItems>): string[] {
  return items
    .filter((it): it is Extract<typeof it, { label: string }> => 'label' in it)
    .map((it) => it.label)
}

function findItem(items: ReturnType<typeof buildTaskMenuItems>, label: string) {
  const found = items.find(
    (it): it is Extract<typeof it, { label: string }> => 'label' in it && it.label === label,
  )
  if (!found) throw new Error(`item ${label} not found`)
  return found
}

describe('buildTaskMenuItems', () => {
  it('shows Start App when start command is configured and not running', () => {
    const items = buildTaskMenuItems(baseHandlers(), baseState)
    expect(labels(items)).toContain('Start App')
    expect(labels(items)).not.toContain('Stop App')
    expect(labels(items)).not.toContain('Set Up Start Command...')
  })

  it('shows Stop App when start command is running', () => {
    const items = buildTaskMenuItems(baseHandlers(), { ...baseState, isRunning: true })
    expect(labels(items)).toContain('Stop App')
    expect(labels(items)).not.toContain('Start App')
  })

  it('shows Set Up Start Command when project has no start command configured', () => {
    const items = buildTaskMenuItems(baseHandlers(), { ...baseState, hasStartCommand: false })
    expect(labels(items)).toContain('Set Up Start Command...')
    expect(labels(items)).not.toContain('Start App')
    expect(labels(items)).not.toContain('Stop App')
  })

  it('Start App fires onStartApp', () => {
    const h = baseHandlers()
    const items = buildTaskMenuItems(h, baseState)
    findItem(items, 'Start App').action()
    expect(h.onStartApp).toHaveBeenCalledTimes(1)
    expect(h.onStopApp).not.toHaveBeenCalled()
    expect(h.onSetupStartCommand).not.toHaveBeenCalled()
  })

  it('Stop App fires onStopApp', () => {
    const h = baseHandlers()
    const items = buildTaskMenuItems(h, { ...baseState, isRunning: true })
    findItem(items, 'Stop App').action()
    expect(h.onStopApp).toHaveBeenCalledTimes(1)
    expect(h.onStartApp).not.toHaveBeenCalled()
  })

  it('Set Up Start Command fires onSetupStartCommand', () => {
    const h = baseHandlers()
    const items = buildTaskMenuItems(h, { ...baseState, hasStartCommand: false })
    findItem(items, 'Set Up Start Command...').action()
    expect(h.onSetupStartCommand).toHaveBeenCalledTimes(1)
    expect(h.onStartApp).not.toHaveBeenCalled()
    expect(h.onStopApp).not.toHaveBeenCalled()
  })

  it('Start App is disabled while setup hook is running', () => {
    const items = buildTaskMenuItems(baseHandlers(), { ...baseState, isSetupRunning: true })
    expect(findItem(items, 'Start App').disabled).toBe(true)
  })

  it('Stop App is enabled even while setup hook is running', () => {
    const items = buildTaskMenuItems(baseHandlers(), { ...baseState, isRunning: true, isSetupRunning: true })
    expect(findItem(items, 'Stop App').disabled).toBeFalsy()
  })

  it('start/stop/setup item sits between Open in Finder and the separator', () => {
    const items = buildTaskMenuItems(baseHandlers(), baseState)
    const order = items.map((it) => ('separator' in it ? '---' : it.label))
    const finderIdx = order.indexOf('Open in Finder')
    const startIdx = order.indexOf('Start App')
    const sepIdx = order.indexOf('---')
    expect(startIdx).toBe(finderIdx + 1)
    expect(sepIdx).toBe(startIdx + 1)
  })

  it('preserves the existing entries (Open in New Window, Rename, Open in Finder, Archive Task)', () => {
    const items = buildTaskMenuItems(baseHandlers(), baseState)
    expect(labels(items)).toEqual([
      'Open in New Window',
      'Rename',
      'Open in Finder',
      'Start App',
      'Archive Task',
    ])
  })
})
