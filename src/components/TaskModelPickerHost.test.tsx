import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'

// The host is what the main window and the detached task windows both mount:
// it shows the picker for whatever asked for one (`openModelPicker`) and hands
// the pick back to it, with the account of the row it was made in.
const picker = vi.hoisted(() => ({ props: null as null | {
  open: boolean
  title?: string
  placeholder?: string
  projectId?: string
  defaultAgent?: string
  defaultModel?: string
  onClose: () => void
  onPick: (agentType: string, model?: string, account?: unknown) => unknown
} }))
vi.mock('./ModelPicker', () => ({
  ModelPicker: (props: NonNullable<typeof picker.props>) => {
    picker.props = props
    return null
  },
}))

import { TaskModelPickerHost } from './TaskModelPickerHost'
import { closeModelPicker, modelPickerRequest, openModelPicker } from '../store/modelPicker'

beforeEach(() => {
  picker.props = null
  closeModelPicker()
})
afterEach(() => {
  cleanup()
  closeModelPicker()
})

describe('<TaskModelPickerHost />', () => {
  test('is closed until something asks for the picker', () => {
    render(() => <TaskModelPickerHost />)

    expect(picker.props!.open).toBe(false)
  })

  test('shows the picker the way it was asked for, for the project of the request', () => {
    render(() => <TaskModelPickerHost />)

    openModelPicker({
      title: 'New session',
      placeholder: 'Select agent and model for new session...',
      projectId: 'p1',
      defaultAgent: 'codex',
      defaultModel: 'gpt-5',
      onPick: () => {},
    })

    expect(picker.props).toMatchObject({
      open: true,
      title: 'New session',
      placeholder: 'Select agent and model for new session...',
      projectId: 'p1',
      defaultAgent: 'codex',
      defaultModel: 'gpt-5',
    })
  })

  test('gives the pick, with its account, back to whoever asked', async () => {
    const onPick = vi.fn().mockResolvedValue(undefined)
    render(() => <TaskModelPickerHost />)
    openModelPicker({ projectId: 'p1', onPick })

    await picker.props!.onPick('claude', 'opus', { kind: 'account', id: 'a1' })

    expect(onPick).toHaveBeenCalledOnce()
    expect(onPick).toHaveBeenCalledWith('claude', 'opus', { kind: 'account', id: 'a1' })
  })

  test('a pick from a harness without accounts has none', async () => {
    const onPick = vi.fn()
    render(() => <TaskModelPickerHost />)
    openModelPicker({ onPick })

    await picker.props!.onPick('codex', 'gpt-5')

    expect(onPick).toHaveBeenCalledWith('codex', 'gpt-5', undefined)
  })

  test('closing the picker ends the request', () => {
    render(() => <TaskModelPickerHost />)
    openModelPicker({ onPick: () => {} })
    expect(modelPickerRequest()).not.toBeNull()

    picker.props!.onClose()

    expect(modelPickerRequest()).toBeNull()
    expect(picker.props!.open).toBe(false)
  })
})
