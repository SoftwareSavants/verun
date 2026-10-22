import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSignal } from 'solid-js'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'

// Sending empties what it sends from: the composer, the plan panel, the step
// queue. When the session's account stops the send (the store's sendMessage
// resolves false after showing its toast and taking the message out of the
// chat), the only copy of what the user wrote would be gone, so every one of
// them gives it back.
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendStep: vi.fn(),
  planText: '# Plan\n\nDo the thing',
  setup: { running: false, failed: false, queued: {} as Record<string, unknown> },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((command: string) => Promise.resolve(command === 'read_text_file' ? mocks.planText : undefined)),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))
vi.mock('../lib/ipc', () => ({
  getTrustLevel: vi.fn(() => Promise.resolve('normal')),
  setTrustLevel: vi.fn(() => Promise.resolve()),
  listWorktreeFiles: vi.fn(() => Promise.resolve([])),
  uploadAttachment: vi.fn(() => Promise.resolve({ hash: 'h-1', mime: 'image/png', size: 3 })),
  addStep: vi.fn(),
  deleteStep: vi.fn(),
}))
vi.mock('../lib/markdown', () => ({ renderMarkdown: () => '', handleMarkdownLinkClick: vi.fn(), getWorktreePath: () => '' }))
vi.mock('../store/sessions', () => ({
  sendMessage: mocks.sendMessage,
  sendStep: mocks.sendStep,
  abortMessage: vi.fn(),
  steerSession: vi.fn(),
  createSession: vi.fn(),
  clearOutputItems: vi.fn(),
  pendingApprovals: {},
  approveToolUse: vi.fn(),
  denyToolUse: vi.fn(),
  answerQuestion: vi.fn(),
  sessionCosts: {},
  sessionTokens: {},
  rateLimitFor: () => null,
  outputItems: {},
  tryDrainSteps: vi.fn(),
  sessionById: () => ({ id: 's1', taskId: 't1', agentType: 'claude', accountId: null, model: null }),
  updateSessionModel: vi.fn(),
}))
vi.mock('../store/tasks', () => ({ taskById: () => undefined }))
vi.mock('../store/projects', () => ({ projectById: () => undefined }))
vi.mock('../store/agents', () => ({ agents: [] }))
vi.mock('../store/commands', () => ({ primeSkills: vi.fn() }))
vi.mock('../store/editorView', () => ({ openFile: vi.fn(), setMainView: vi.fn() }))
vi.mock('../store/sideQuestion', () => ({ openSideQuestion: vi.fn() }))
vi.mock('../store/setup', () => ({
  isSetupRunning: () => mocks.setup.running,
  setupFailed: () => mocks.setup.failed,
  queueMessage: vi.fn(),
  queuedMessages: mocks.setup.queued,
  clearQueuedMessage: vi.fn(),
}))
vi.mock('./ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('./FileMention', () => ({ FileMention: () => null }))
vi.mock('./ImageViewer', () => ({ ImageViewer: () => null }))
vi.mock('./BlobImage', () => ({ BlobImage: () => null }))

import { MessageInput } from './MessageInput'
import { setPlanFilePathForSession, planFilePathForSession, setPlanModeForSession, planModeForSession } from '../store/sessionContext'
import { addStep, clearSteps, getSteps } from '../store/steps'
import { setSelectedTaskId } from '../store/ui'

const PLAN_PATH = '/tmp/plan.md'

/** The composer's editable element. */
const editor = (container: HTMLElement) => container.querySelector('[contenteditable="true"]') as HTMLElement

function type(el: HTMLElement, text: string) {
  el.textContent = text
  fireEvent.input(el)
}

function enter(container: HTMLElement, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(editor(container), { key: 'Enter', ...init })
}

/** Pastes a screenshot into the composer, which uploads it and keeps its ref. */
async function pasteImage(container: HTMLElement) {
  const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
  fireEvent.paste(editor(container), {
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '' },
  })
  await flush()
}

const previews = (container: HTMLElement) => container.querySelectorAll('button[title="Open image"]').length

/** The plan viewer's Approve / Send button, which sits next to its "Request changes..." field. */
const viewerButton = () => screen.getByPlaceholderText('Request changes...').parentElement!.querySelector('button') as HTMLButtonElement

/** Types in a plan field and presses Enter in it, focused as it is for a user. */
function submitField(placeholder: string, text: string) {
  const field = screen.getByPlaceholderText(placeholder) as HTMLInputElement
  field.focus()
  fireEvent.input(field, { target: { value: text } })
  fireEvent.keyDown(field, { key: 'Enter' })
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

beforeEach(() => {
  localStorage.clear()
  mocks.sendMessage.mockReset()
  mocks.sendStep.mockReset()
  mocks.planText = '# Plan\n\nDo the thing'
  mocks.setup.running = false
  mocks.setup.failed = false
  for (const key of Object.keys(mocks.setup.queued)) delete mocks.setup.queued[key]
  setSelectedTaskId(null)
  setPlanFilePathForSession('s1', null)
  setPlanModeForSession('s1', false)
  clearSteps('s1')
})

afterEach(() => cleanup())

describe('MessageInput send', () => {
  test('a sent message empties the composer', async () => {
    mocks.sendMessage.mockResolvedValue(true)
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)

    type(editor(container), 'Fix the bug')
    enter(container)
    await flush()

    expect(mocks.sendMessage).toHaveBeenCalledWith('s1', 'Fix the bug', undefined, undefined, false, true, false)
    expect(editor(container).textContent).toBe('')
  })

  test('a message the account stopped comes back to the composer', async () => {
    mocks.sendMessage.mockResolvedValue(false)
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)

    type(editor(container), 'Fix the bug')
    enter(container)
    await flush()

    expect(mocks.sendMessage).toHaveBeenCalledOnce()
    expect(editor(container).textContent).toBe('Fix the bug')
  })

  test('the attachments come back with it', async () => {
    mocks.sendMessage.mockResolvedValue(false)
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    type(editor(container), 'See this')
    await pasteImage(container)
    expect(previews(container)).toBe(1)

    enter(container)
    await flush()

    expect(mocks.sendMessage).toHaveBeenCalledWith('s1', 'See this', [{ hash: 'h-1', mimeType: 'image/png', name: 'shot.png', size: 3 }], undefined, false, true, false)
    expect(editor(container).textContent).toBe('See this')
    expect(previews(container)).toBe(1)
  })

  test('attachments sent without any text come back as well', async () => {
    mocks.sendMessage.mockResolvedValue(false)
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    await pasteImage(container)

    enter(container)
    await flush()

    expect(mocks.sendMessage).toHaveBeenCalledOnce()
    expect(previews(container)).toBe(1)
  })

  test('attachments of a message that was sent do not come back', async () => {
    mocks.sendMessage.mockResolvedValue(true)
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    type(editor(container), 'See this')
    await pasteImage(container)

    enter(container)
    await flush()

    expect(previews(container)).toBe(0)
  })

  test('what was typed while the send was out is kept, after the message that came back', async () => {
    let finish!: (sent: boolean) => void
    mocks.sendMessage.mockReturnValue(new Promise<boolean>(resolve => { finish = resolve }))
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    type(editor(container), 'Fix the bug')
    enter(container)
    expect(editor(container).textContent).toBe('')

    type(editor(container), 'and add a test')
    finish(false)
    await flush()

    expect(editor(container).textContent).toBe('Fix the bug\nand add a test')
  })

  test('the message goes back to its own session if the user moved to another one meanwhile', async () => {
    let finish!: (sent: boolean) => void
    mocks.sendMessage.mockReturnValue(new Promise<boolean>(resolve => { finish = resolve }))
    const [sessionId, setSessionId] = createSignal('s1')
    const { container } = render(() => <MessageInput sessionId={sessionId()} isRunning={false} />)
    type(editor(container), 'Fix the bug')
    enter(container)

    setSessionId('s2')
    finish(false)
    await flush()
    // The other session's composer is not given someone else's message.
    expect(editor(container).textContent).toBe('')

    setSessionId('s1')
    await flush()
    expect(editor(container).textContent).toBe('Fix the bug')
  })

  test('the plan panel the send dismissed comes back when the account stopped it', async () => {
    mocks.sendMessage.mockResolvedValue(false)
    setPlanFilePathForSession('s1', PLAN_PATH)
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    await flush()

    type(editor(container), 'Looks fine, but use sqlite')
    enter(container)
    await flush()

    expect(planFilePathForSession('s1')).toBe(PLAN_PATH)
  })

  test('a message that was sent dismisses the plan panel, as before', async () => {
    mocks.sendMessage.mockResolvedValue(true)
    setPlanFilePathForSession('s1', PLAN_PATH)
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    await flush()

    type(editor(container), 'Looks fine, but use sqlite')
    enter(container)
    await flush()

    expect(planFilePathForSession('s1')).toBeNull()
  })
})

describe('MessageInput plan viewer', () => {
  test('approving the plan keeps the plan and plan mode when the account stopped the send', async () => {
    mocks.sendMessage.mockResolvedValue(false)
    setPlanFilePathForSession('s1', PLAN_PATH)
    setPlanModeForSession('s1', true)
    render(() => <MessageInput sessionId="s1" isRunning={false} />)
    await flush()

    fireEvent.click(viewerButton())
    await flush()

    expect(mocks.sendMessage).toHaveBeenCalledWith('s1', 'The plan is approved. Please implement it now.', undefined, undefined, false)
    expect(planFilePathForSession('s1')).toBe(PLAN_PATH)
    expect(planModeForSession('s1')).toBe(true)
    // Still there to approve again.
    expect(viewerButton().disabled).toBe(false)
  })

  test('approving the plan clears it and leaves plan mode when the send went out', async () => {
    mocks.sendMessage.mockResolvedValue(true)
    setPlanFilePathForSession('s1', PLAN_PATH)
    setPlanModeForSession('s1', true)
    render(() => <MessageInput sessionId="s1" isRunning={false} />)
    await flush()

    fireEvent.click(viewerButton())
    await flush()

    expect(planFilePathForSession('s1')).toBeNull()
    expect(planModeForSession('s1')).toBe(false)
  })

  test('changes asked for come back with the plan when the account stopped the send', async () => {
    mocks.sendMessage.mockResolvedValue(false)
    setPlanFilePathForSession('s1', PLAN_PATH)
    setPlanModeForSession('s1', true)
    render(() => <MessageInput sessionId="s1" isRunning={false} />)
    await flush()

    fireEvent.input(screen.getByPlaceholderText('Request changes...'), { target: { value: 'use sqlite' } })
    fireEvent.click(viewerButton())
    await flush()

    expect(mocks.sendMessage).toHaveBeenCalledWith('s1', 'use sqlite', undefined, undefined, true)
    expect(planFilePathForSession('s1')).toBe(PLAN_PATH)
    expect((screen.getByPlaceholderText('Request changes...') as HTMLInputElement).value).toBe('use sqlite')
  })

  test('changes asked for are cleared with the plan when the send went out', async () => {
    mocks.sendMessage.mockResolvedValue(true)
    setPlanFilePathForSession('s1', PLAN_PATH)
    setPlanModeForSession('s1', true)
    render(() => <MessageInput sessionId="s1" isRunning={false} />)
    await flush()

    fireEvent.input(screen.getByPlaceholderText('Request changes...'), { target: { value: 'use sqlite' } })
    fireEvent.click(viewerButton())
    await flush()

    expect(planFilePathForSession('s1')).toBeNull()
    expect(screen.queryByPlaceholderText('Request changes...')).toBeNull()
  })
})

describe('MessageInput plan response', () => {
  // An empty plan file leaves the small "Plan ready" panel instead of the viewer.
  beforeEach(() => { mocks.planText = '' })

  test('approving keeps the panel and plan mode when the account stopped the send', async () => {
    mocks.sendMessage.mockResolvedValue(false)
    setPlanFilePathForSession('s1', PLAN_PATH)
    setPlanModeForSession('s1', true)
    render(() => <MessageInput sessionId="s1" isRunning={false} />)
    await flush()

    fireEvent.click(screen.getByRole('button', { name: /^Approve/ }))
    await flush()

    expect(mocks.sendMessage).toHaveBeenCalledOnce()
    expect(planFilePathForSession('s1')).toBe(PLAN_PATH)
    expect(planModeForSession('s1')).toBe(true)
    expect(screen.getByText('Plan ready')).toBeTruthy()
  })

  test('the changes asked for come back when the account stopped the send', async () => {
    mocks.sendMessage.mockResolvedValue(false)
    setPlanFilePathForSession('s1', PLAN_PATH)
    render(() => <MessageInput sessionId="s1" isRunning={false} />)
    await flush()

    submitField('Ask for changes...', 'use sqlite')
    await flush()

    expect(mocks.sendMessage).toHaveBeenCalledWith('s1', 'use sqlite', undefined, undefined, true)
    expect((screen.getByPlaceholderText('Ask for changes...') as HTMLInputElement).value).toBe('use sqlite')
  })

  test('the changes asked for are cleared when the send went out', async () => {
    mocks.sendMessage.mockResolvedValue(true)
    setPlanFilePathForSession('s1', PLAN_PATH)
    render(() => <MessageInput sessionId="s1" isRunning={false} />)
    await flush()

    submitField('Ask for changes...', 'use sqlite')
    await flush()

    expect(mocks.sendMessage).toHaveBeenCalledOnce()
    expect((screen.getByPlaceholderText('Ask for changes...') as HTMLInputElement).value).toBe('')
  })
})

describe('MessageInput step queue', () => {
  test('Cmd+Enter hands the first step to sendStep, which keeps it when the account stops it', async () => {
    mocks.sendStep.mockResolvedValue(false)
    addStep({ sessionId: 's1', message: 'run the tests', armed: false })
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)

    enter(container, { metaKey: true })
    await flush()

    expect(mocks.sendStep).toHaveBeenCalledOnce()
    expect(mocks.sendStep.mock.calls[0][0]).toMatchObject({ sessionId: 's1', message: 'run the tests' })
    // The mocked sendStep restores nothing; the step left the queue for the send.
    expect(getSteps('s1')).toEqual([])
  })
})

describe('MessageInput queued prompt note', () => {
  const queue = () => {
    mocks.setup.queued.t1 = { sessionId: 's1', message: 'Fix the bug' }
    setSelectedTaskId('t1')
  }

  test('says it will send when setup completes while setup runs', () => {
    queue()
    mocks.setup.running = true
    render(() => <MessageInput sessionId="s1" isRunning={false} />)

    expect(screen.getByText(/will send when setup completes/)).toBeTruthy()
  })

  test('says it was not sent once setup is over, for a prompt the account stopped', () => {
    queue()
    render(() => <MessageInput sessionId="s1" isRunning={false} />)

    expect(screen.queryByText(/will send when setup completes/)).toBeNull()
    expect(screen.getByText('Not sent. Prompt saved; once the account works, edit it to send.')).toBeTruthy()
  })

  test('keeps the setup-failed note when setup failed', () => {
    queue()
    mocks.setup.failed = true
    render(() => <MessageInput sessionId="s1" isRunning={false} />)

    expect(screen.getByText('Setup failed. Prompt saved; retry setup or edit it.')).toBeTruthy()
  })
})
