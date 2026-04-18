import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@solidjs/testing-library'

vi.mock('../lib/ipc', () => ({
  listSteps: vi.fn().mockResolvedValue([]),
  addStep: vi.fn().mockResolvedValue(undefined),
  updateStep: vi.fn().mockResolvedValue(undefined),
  deleteStep: vi.fn().mockResolvedValue(undefined),
  reorderSteps: vi.fn().mockResolvedValue(undefined),
  disarmAllSteps: vi.fn().mockResolvedValue(undefined),
}))

const sendMessageMock = vi.fn()
vi.mock('../store/sessions', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  sessionById: () => ({ id: 's-001', agentType: 'claude' }),
}))

vi.mock('../store/agents', () => ({
  agents: [{
    id: 'claude',
    name: 'Claude',
    models: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }],
    supportsPlanMode: true,
    supportsEffort: true,
  }],
}))

// Mock ModelSelector to avoid pulling in Tauri-coupled dialogs; expose onChange hook.
const modelChangeMock = vi.fn()
vi.mock('./ModelSelector', () => ({
  ModelSelector: (props: { model: string | null | undefined; onChange: (m: string) => void }) => {
    return (
      <button
        data-testid="model-selector"
        onClick={() => {
          modelChangeMock()
          props.onChange('opus')
        }}
      >
        {props.model ?? 'none'}
      </button>
    )
  },
}))

import { StepList } from './StepList'
import { addStep, clearSteps, getSteps } from '../store/steps'
import * as ipc from '../lib/ipc'

const SID = 's-001'

function seedStep(overrides: Partial<Parameters<typeof addStep>[0]> = {}) {
  addStep({
    sessionId: SID,
    message: 'Original message',
    armed: false,
    ...overrides,
  })
  return getSteps(SID)[getSteps(SID).length - 1]
}

describe('<StepList />', () => {
  beforeEach(() => {
    clearSteps(SID)
    clearSteps('s-002')
    sendMessageMock.mockReset()
    modelChangeMock.mockReset()
    vi.mocked(ipc.updateStep).mockClear()
    vi.mocked(ipc.deleteStep).mockClear()
  })

  test('renders nothing when there are no steps', () => {
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    expect(container.textContent).toBe('')
  })

  test('renders the step message in view mode and does not show a pencil / edit button', () => {
    seedStep({ message: 'do the thing' })
    const { container, queryByTitle } = render(() => <StepList sessionId={SID} isRunning={false} />)
    expect(container.textContent).toContain('do the thing')
    // No pencil/edit affordance — editing is click-to-edit on the message itself.
    expect(queryByTitle('Edit')).toBeNull()
  })

  test('clicking the message enters edit mode (textarea + mode toggles)', async () => {
    seedStep({ message: 'click me' })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const msg = container.querySelector('.cursor-text') as HTMLElement
    expect(msg).toBeTruthy()
    fireEvent.click(msg)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea).toBeTruthy()
    expect(textarea.value).toBe('click me')
    // Mode buttons visible in edit mode
    expect(container.textContent).toContain('Plan')
    expect(container.textContent).toContain('Think')
    expect(container.textContent).toContain('Fast')
    // Model selector present (mocked)
    expect(container.querySelector('[data-testid="model-selector"]')).toBeTruthy()
  })

  test('mode buttons and model selector are hidden in view mode', () => {
    seedStep({ message: 'view only' })
    const { container, queryByTitle } = render(() => <StepList sessionId={SID} isRunning={false} />)
    // Plan/Think/Fast buttons only render in edit mode
    expect(queryByTitle('Plan mode')).toBeNull()
    expect(queryByTitle('Thinking mode')).toBeNull()
    expect(queryByTitle('Fast mode')).toBeNull()
    expect(container.querySelector('[data-testid="model-selector"]')).toBeNull()
  })

  test('Enter saves edits and exits edit mode', () => {
    const step = seedStep({ message: 'before' })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.input(textarea, { target: { value: 'after' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(getSteps(SID)[0].message).toBe('after')
    expect(container.querySelector('textarea')).toBeNull()
    expect(ipc.updateStep).toHaveBeenCalledWith(step.id, 'after', false, null, null, null, null, null)
  })

  test('Shift+Enter does not save — handled as native newline', () => {
    seedStep({ message: 'keep editing' })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    // Still in edit mode
    expect(container.querySelector('textarea')).toBeTruthy()
    // Message unchanged in store
    expect(getSteps(SID)[0].message).toBe('keep editing')
  })

  test('Escape cancels without saving', () => {
    seedStep({ message: 'unchanged' })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.input(textarea, { target: { value: 'should-be-discarded' } })
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(getSteps(SID)[0].message).toBe('unchanged')
    expect(container.querySelector('textarea')).toBeNull()
  })

  test('empty-string Enter does not update the message (guard against losing content)', () => {
    seedStep({ message: 'has content' })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.input(textarea, { target: { value: '   ' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(getSteps(SID)[0].message).toBe('has content')
  })

  test('blur outside the editing row saves', () => {
    seedStep({ message: 'start' })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.input(textarea, { target: { value: 'via-blur' } })
    // blur with no relatedTarget simulates click outside
    fireEvent.blur(textarea, { relatedTarget: null })

    expect(getSteps(SID)[0].message).toBe('via-blur')
    expect(container.querySelector('textarea')).toBeNull()
  })

  test('blur to a sibling inside the row (e.g. mode toggle) does NOT save', () => {
    seedStep({ message: 'keep-editing' })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.input(textarea, { target: { value: 'draft' } })

    const planBtn = container.querySelector('button[title="Plan mode"]') as HTMLElement
    expect(planBtn).toBeTruthy()
    fireEvent.blur(textarea, { relatedTarget: planBtn })

    // Still in edit mode
    expect(container.querySelector('textarea')).toBeTruthy()
  })

  test('clicking Plan/Think/Fast toggles update the step immediately (inline)', () => {
    const step = seedStep({ message: 'm', planMode: false, thinkingMode: false, fastMode: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)

    fireEvent.click(container.querySelector('button[title="Plan mode"]')!)
    fireEvent.click(container.querySelector('button[title="Thinking mode"]')!)
    fireEvent.click(container.querySelector('button[title="Fast mode"]')!)

    const after = getSteps(SID).find(s => s.id === step.id)!
    expect(after.planMode).toBe(true)
    expect(after.thinkingMode).toBe(true)
    expect(after.fastMode).toBe(true)
  })

  test('clicking the model selector updates the step model', () => {
    const step = seedStep({ message: 'm', model: 'sonnet' })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)
    fireEvent.click(container.querySelector('[data-testid="model-selector"]')!)

    expect(modelChangeMock).toHaveBeenCalled()
    expect(getSteps(SID).find(s => s.id === step.id)!.model).toBe('opus')
  })

  test('armed step uses a non-layout-shifting accent indicator (inset shadow, not a border)', () => {
    seedStep({ message: 'armed', armed: true })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const row = container.querySelector('[data-step-id]') as HTMLElement
    // No border class that would add layout width and push content right
    expect(row.className).not.toContain('border-l-2')
    expect(row.className).not.toContain('border-l-accent')
    // Inset box-shadow draws the accent bar without affecting layout
    expect(row.className).toMatch(/shadow-\[inset/)
  })

  test('disarmed step gets no accent indicator', () => {
    seedStep({ message: 'paused', armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const row = container.querySelector('[data-step-id]') as HTMLElement
    expect(row.className).not.toMatch(/shadow-\[inset/)
    expect(row.className).not.toContain('border-l-accent')
  })

  test('editing row does not render the armed indicator even when the step is armed', () => {
    seedStep({ message: 'armed and editing', armed: true })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)
    const row = container.querySelector('[data-step-id]') as HTMLElement
    // When editing, we use ring styling, not the armed shadow
    expect(row.className).not.toMatch(/shadow-\[inset/)
    expect(row.className).toContain('ring-accent/40')
  })

  test('arm/pause toggle button flips the armed state without entering edit mode', () => {
    seedStep({ message: 'first', armed: false })
    const step = seedStep({ message: 'toggle me', armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const armBtn = container.querySelector('button[title^="Arm"]') as HTMLElement
    expect(armBtn).toBeTruthy()
    fireEvent.click(armBtn)
    expect(getSteps(SID).find(s => s.id === step.id)!.armed).toBe(true)
    // Should not have opened the editor
    expect(container.querySelector('textarea')).toBeNull()
  })

  test('delete button removes the step', () => {
    const step = seedStep({ message: 'bye', armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('button[title="Remove"]')!)
    expect(getSteps(SID).find(s => s.id === step.id)).toBeUndefined()
    expect(ipc.deleteStep).toHaveBeenCalledWith(step.id)
  })

  test('remove button uses the X icon (dismiss from queue, not permanent delete)', () => {
    seedStep({ message: 'bye', armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const btn = container.querySelector('button[title="Remove"]') as HTMLElement
    expect(btn.querySelector('.lucide-x')).toBeTruthy()
    expect(btn.querySelector('.lucide-trash-2')).toBeNull()
  })

  test('fire button sends the first step when idle', async () => {
    const step = seedStep({
      message: 'fire me',
      armed: false,
      model: 'opus',
      planMode: true,
      thinkingMode: false,
      fastMode: true,
    })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('button[title="Send now"]')!)

    expect(sendMessageMock).toHaveBeenCalledWith(SID, 'fire me', undefined, 'opus', true, false, true)
    // Fire extracts the step, so it should be gone from the store
    expect(getSteps(SID).find(s => s.id === step.id)).toBeUndefined()
  })

  test('fire button is not rendered when running', () => {
    seedStep({ message: 'no fire', armed: false })
    const { queryByTitle } = render(() => <StepList sessionId={SID} isRunning={true} />)
    expect(queryByTitle('Send now')).toBeNull()
  })

  test('fire button is only shown on the first step', () => {
    seedStep({ message: 'first', armed: false })
    seedStep({ message: 'second', armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const fireButtons = container.querySelectorAll('button[title="Send now"]')
    expect(fireButtons.length).toBe(1)
  })

  // ─── UI regression suite for the reported issues ────────────────────

  test('view-mode row vertically centers contents (items-center)', () => {
    seedStep({ message: 'x' })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const row = container.querySelector('[data-step-id]') as HTMLElement
    expect(row.className).toContain('items-center')
    expect(row.className).not.toContain('items-start')
  })

  test('armed step shows Pause icon (state-indicator semantics: armed means "playing", so pause to act)', () => {
    seedStep({ message: 'first', armed: false })
    seedStep({ armed: true })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const btn = container.querySelector('button[title^="Disarm"]') as HTMLElement
    expect(btn).toBeTruthy()
    expect(btn.querySelector('.lucide-pause')).toBeTruthy()
    expect(btn.querySelector('.lucide-play')).toBeNull()
  })

  test('armed pause button is not accent-colored (accent is reserved for primary actions)', () => {
    seedStep({ message: 'first', armed: false })
    seedStep({ armed: true })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const btn = container.querySelector('button[title^="Disarm"]') as HTMLElement
    expect(btn).toBeTruthy()
    expect(btn.className).not.toMatch(/(?:^|\s)text-accent(?:\s|$|\/)/)
  })

  test('disarmed step shows Play icon', () => {
    seedStep({ message: 'first', armed: false })
    seedStep({ armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const btn = container.querySelector('button[title^="Arm"]') as HTMLElement
    expect(btn).toBeTruthy()
    expect(btn.querySelector('.lucide-play')).toBeTruthy()
    expect(btn.querySelector('.lucide-pause')).toBeNull()
  })

  test('arm toggle button is revealed only on row hover for non-first step (lives inside group-hover element)', () => {
    seedStep({ message: 'first', armed: false })
    seedStep({ armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const btn = container.querySelector('button[title^="Arm"]') as HTMLElement
    expect(btn).toBeTruthy()
    // Walk up to find a group-hover:opacity-100 wrapper
    let el: HTMLElement | null = btn
    let found = false
    while (el && el.getAttribute('data-step-id') === null) {
      if ((el.className || '').includes('group-hover:opacity-100')) { found = true; break }
      el = el.parentElement
    }
    expect(found).toBe(true)
  })

  test('first idle step hides the arm/play button (redundant with the send button)', () => {
    seedStep({ message: 'first', armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    expect(container.querySelector('button[title^="Arm"]')).toBeNull()
    expect(container.querySelector('button[title^="Disarm"]')).toBeNull()
  })

  test('first running step still shows the arm/play button (no send button during run)', () => {
    seedStep({ message: 'first', armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={true} />)
    expect(container.querySelector('button[title^="Arm"]')).toBeTruthy()
  })

  test('first idle step action cluster is always visible (not hover-gated)', () => {
    seedStep({ message: 'first', armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const fireBtn = container.querySelector('button[title="Send now"]') as HTMLElement
    expect(fireBtn).toBeTruthy()
    // Walk up: from the fire button to the row boundary, nothing should be hover-gated.
    let el: HTMLElement | null = fireBtn
    while (el && el.getAttribute('data-step-id') === null) {
      const cls = el.className || ''
      expect(cls).not.toContain('opacity-0')
      expect(cls).not.toContain('group-hover:opacity-100')
      el = el.parentElement
    }
  })

  test('non-first idle step action cluster remains hover-gated', () => {
    seedStep({ message: 'first', armed: false })
    seedStep({ message: 'second', armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const rows = container.querySelectorAll('[data-step-id]')
    const secondRow = rows[1] as HTMLElement
    const delBtn = secondRow.querySelector('button[title="Remove"]') as HTMLElement
    expect(delBtn).toBeTruthy()
    let el: HTMLElement | null = delBtn
    let found = false
    while (el && el.getAttribute('data-step-id') === null) {
      if ((el.className || '').includes('group-hover:opacity-100')) { found = true; break }
      el = el.parentElement
    }
    expect(found).toBe(true)
  })

  test('fire button renders AFTER the message (so it does not push the message text right)', () => {
    seedStep({ message: 'first', armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const row = container.querySelector('[data-step-id]') as HTMLElement
    const fireBtn = row.querySelector('button[title="Send now"]') as HTMLElement
    const messageArea = row.querySelector('.cursor-text') as HTMLElement
    expect(fireBtn).toBeTruthy()
    expect(messageArea).toBeTruthy()
    // messageArea should precede fireBtn in DOM order
    expect(messageArea.compareDocumentPosition(fireBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('fire button is the leftmost icon in the right-hand action cluster (before delete)', () => {
    seedStep({ message: 'first', armed: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const row = container.querySelector('[data-step-id]') as HTMLElement
    const fireBtn = row.querySelector('button[title="Send now"]') as HTMLElement
    const delBtn = row.querySelector('button[title="Remove"]') as HTMLElement
    expect(fireBtn.compareDocumentPosition(delBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('mousedown on a mode toggle in edit mode is preventDefault-ed (keeps textarea focus so click does not blur-save)', () => {
    seedStep({ message: 'keep focus', planMode: false })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)

    const planBtn = container.querySelector('button[title="Plan mode"]') as HTMLElement
    expect(planBtn).toBeTruthy()
    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    planBtn.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
  })

  test('mousedown on model selector in edit mode is preventDefault-ed', () => {
    seedStep({ message: 'keep focus 2' })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)

    const model = container.querySelector('[data-testid="model-selector"]') as HTMLElement
    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    model.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
  })

  test('mousedown on the textarea itself is NOT preventDefault-ed (so the caret moves)', () => {
    seedStep({ message: 'caret' })
    const { container } = render(() => <StepList sessionId={SID} isRunning={false} />)
    fireEvent.click(container.querySelector('.cursor-text')!)

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    textarea.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(false)
  })

  test('"Next Steps" header stays above the scroll container (header is outside the scrollable list)', () => {
    seedStep({ message: 'x' })
    const { container, getByText } = render(() => <StepList sessionId={SID} isRunning={false} />)
    const header = getByText('Next Steps').parentElement as HTMLElement
    const row = container.querySelector('[data-step-id]') as HTMLElement
    const scroller = row.parentElement as HTMLElement
    // The scroll container is the rows' direct parent and owns overflow-y-auto
    expect(scroller.className).toContain('overflow-y-auto')
    // The header must NOT live inside the scroll container, otherwise it scrolls away
    expect(scroller.contains(header)).toBe(false)
  })
})
