import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'

// A file dropped anywhere on the chat lands in the composer as a mention (an
// image attaches), whether it comes from Finder (a native Tauri drop with
// paths) or from Verun's file tree (a pointer drag).
const drops = vi.hoisted(() => ({} as Record<string, Array<(e: { payload: unknown }) => void>>))
const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendStep: vi.fn(),
  createSession: vi.fn(),
  setMainView: vi.fn(),
  /** What the store has for the composer's session `s1`; `undefined` when it has none. */
  session: undefined as { id: string; taskId: string; agentType: string; accountId: string | null; model: string | null } | undefined,
  planText: '# Plan\n\nDo the thing',
  setup: { running: false, failed: false, queued: {} as Record<string, unknown> },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((command: string) => Promise.resolve(command === 'read_text_file' ? mocks.planText : undefined)),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    ;(drops[event] ??= []).push(handler)
    return Promise.resolve(() => { drops[event] = drops[event].filter(h => h !== handler) })
  }),
  emit: vi.fn(),
}))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ label: 'main' }) }))
vi.mock('../lib/ipc', () => ({
  voiceSetTarget: vi.fn(() => Promise.resolve()),
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
  createSession: mocks.createSession,
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
  sessionById: () => mocks.session,
  updateSessionModel: vi.fn(),
}))
vi.mock('../store/tasks', () => ({ taskById: () => undefined }))
vi.mock('../store/projects', () => ({ projectById: () => undefined }))
vi.mock('../store/agents', () => ({ agents: [] }))
vi.mock('../store/commands', () => ({ primeSkills: vi.fn() }))
vi.mock('../store/editorView', () => ({ openFile: vi.fn(), setMainView: mocks.setMainView }))
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
import { beginFileDrag, __resetFileDragForTests } from '../store/fileDrag'

const rect = (left: number, top: number, right: number, bottom: number) =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON() {} }) as DOMRect

/** A chat view 0-800 x 0-600 with the composer in its bottom 100px. */
function renderChat() {
  const view = render(() => <div data-chat-drop-zone><MessageInput sessionId="s1" isRunning={false} /></div>)
  const zone = view.container.querySelector('[data-chat-drop-zone]') as HTMLElement
  zone.getBoundingClientRect = () => rect(0, 0, 800, 600)
  zone.getClientRects = () => [rect(0, 0, 800, 600)] as unknown as DOMRectList
  return view
}
const editor = (c: HTMLElement) => c.querySelector('[contenteditable="true"]') as HTMLElement
const pointer = (type: string, x: number, y: number) =>
  window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0 }))
async function flush() {
  await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
}

beforeEach(() => { localStorage.clear(); mocks.session = { id: 's1', taskId: 't1', agentType: 'claude', accountId: null, model: null } })
afterEach(() => { cleanup(); __resetFileDragForTests() })

describe('dropping files on the chat', () => {
  test('a Finder drop on the transcript, above the composer, adds a mention', async () => {
    const { container } = renderChat()
    await flush()
    for (const h of drops['tauri://drag-drop'] ?? []) h({ payload: { paths: ['/Users/me/spec.pdf'], position: { x: 100, y: 100 } } })
    await flush()
    expect(editor(container).textContent).toContain('spec.pdf')
  })

  test('a Finder drop outside the chat is ignored', async () => {
    const { container } = renderChat()
    await flush()
    for (const h of drops['tauri://drag-drop'] ?? []) h({ payload: { paths: ['/Users/me/spec.pdf'], position: { x: 900, y: 100 } } })
    await flush()
    expect(editor(container).textContent).not.toContain('spec.pdf')
  })

  test('a file dragged from the file tree and released on the chat adds a mention', async () => {
    const { container } = renderChat()
    await flush()
    beginFileDrag({ button: 0, clientX: 1000, clientY: 100 }, ['/w/src/lib/a.ts'])
    pointer('pointermove', 400, 200)
    pointer('pointerup', 400, 200)
    await flush()
    expect(editor(container).textContent).toContain('a.ts')
  })

  test('a file tree drag released outside the chat adds nothing', async () => {
    const { container } = renderChat()
    await flush()
    beginFileDrag({ button: 0, clientX: 1000, clientY: 100 }, ['/w/src/lib/a.ts'])
    pointer('pointermove', 950, 200)
    pointer('pointerup', 950, 200)
    await flush()
    expect(editor(container).textContent).not.toContain('a.ts')
  })

  test('the composer invites the drop while a file tree drag is over the chat', async () => {
    const { container } = renderChat()
    await flush()
    beginFileDrag({ button: 0, clientX: 1000, clientY: 100 }, ['/w/src/lib/a.ts'])
    pointer('pointermove', 400, 200)
    await flush()
    expect(container.textContent).toContain('Drop files here...')
    pointer('pointermove', 950, 200)
    await flush()
    expect(container.textContent).not.toContain('Drop files here...')
  })
})
