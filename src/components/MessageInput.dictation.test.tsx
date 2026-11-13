import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSignal } from 'solid-js'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'
import type { DictationTarget } from '../store/voice'

// The session composer is a dictation target while it is the one on screen,
// and dictated text goes in through the same text -> DOM path as everything else.
const mocks = vi.hoisted(() => ({
  targets: [] as DictationTarget[],
  register: vi.fn(),
}))

vi.mock('../store/voice', () => ({
  registerDictationTarget: (t: DictationTarget) => {
    mocks.register(t)
    mocks.targets.push(t)
    return () => { mocks.targets = mocks.targets.filter(x => x !== t) }
  },
}))
vi.mock('./DictationControl', () => ({ DictationControl: () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ label: 'main', onDragDropEvent: () => Promise.resolve(() => {}) }) }))
vi.mock('../lib/ipc', () => ({
  getTrustLevel: vi.fn(() => Promise.resolve('normal')),
  setTrustLevel: vi.fn(() => Promise.resolve()),
  listWorktreeFiles: vi.fn(() => Promise.resolve([])),
}))
vi.mock('../lib/markdown', () => ({ renderMarkdown: () => '', handleMarkdownLinkClick: vi.fn(), getWorktreePath: () => '' }))
vi.mock('../store/sessions', () => ({
  sendMessage: vi.fn(), sendStep: vi.fn(), abortMessage: vi.fn(), steerSession: vi.fn(), clearOutputItems: vi.fn(),
  pendingApprovals: {}, approveToolUse: vi.fn(), denyToolUse: vi.fn(), answerQuestion: vi.fn(), respondToElicitation: vi.fn(),
  sessionCosts: {}, sessionTokens: {}, rateLimitFor: () => null, outputItems: {}, tryDrainSteps: vi.fn(),
  sessionById: (id: string) => ({ id, taskId: 't1', agentType: 'claude', accountId: null, model: null }),
  updateSessionModel: vi.fn(),
}))
vi.mock('../store/tasks', () => ({ taskById: () => undefined }))
vi.mock('../store/projects', () => ({ projectById: () => undefined }))
vi.mock('../store/agents', () => ({ agents: [] }))
vi.mock('../store/commands', () => ({ primeSkills: vi.fn() }))
vi.mock('../store/editorView', () => ({ openFile: vi.fn(), setMainView: vi.fn() }))
vi.mock('../store/sideQuestion', () => ({ openSideQuestion: vi.fn() }))
vi.mock('./ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('./FileMention', () => ({ FileMention: (p: { query: string }) => <div data-testid="file-mention">{p.query}</div> }))
vi.mock('./ImageViewer', () => ({ ImageViewer: () => null }))
vi.mock('./BlobImage', () => ({ BlobImage: () => null }))

import { MessageInput } from './MessageInput'
import { appendToDraft, loadDraftMessage, saveDraftMessage } from '../store/sessionDrafts'
import { setShowTaskBoard } from '../store/ui'

const ZWS = '​'
const editor = (container: HTMLElement) => container.querySelector('[contenteditable="true"]') as HTMLElement
const target = () => mocks.targets[mocks.targets.length - 1]
const badges = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-mention]')].map(b => b.dataset.mention)

/** Puts a collapsed caret at `offset` characters into `node`. */
function caret(node: Node, offset: number) {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  localStorage.clear()
  mocks.targets = []
  mocks.register.mockClear()
  setShowTaskBoard(false)
  window.getSelection()?.removeAllRanges()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MessageInput as a dictation target', () => {
  test('mounting with a session registers session:<sid>; unmounting unregisters', () => {
    const { unmount } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    expect(mocks.targets.map(t => ({ id: t.id, sessionId: t.sessionId }))).toEqual([{ id: 'session:s1', sessionId: 's1' }])
    unmount()
    expect(mocks.targets).toEqual([])
  })

  test('switching session swaps the registration', () => {
    const [sid, setSid] = createSignal<string | null>('s1')
    render(() => <MessageInput sessionId={sid()} isRunning={false} />)
    setSid('s2')
    expect(mocks.targets.map(t => t.id)).toEqual(['session:s2'])
  })

  test('a composer with no session cannot be typed in, so it is not a target', () => {
    render(() => <MessageInput sessionId={null} isRunning={false} />)
    expect(mocks.targets).toEqual([])
  })

  test('hidden behind the task board it is not a target; back in view it is again', () => {
    render(() => <MessageInput sessionId="s1" isRunning={false} />)
    setShowTaskBoard(true)
    expect(mocks.targets).toEqual([])
    setShowTaskBoard(false)
    expect(mocks.targets.map(t => t.id)).toEqual(['session:s1'])
  })

  test('insert appends to the draft with a space, does not focus the input, and saves the draft', () => {
    saveDraftMessage('s1', 'hello')
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    expect(el.textContent).toBe('hello')
    target().insert('world')
    expect(el.textContent).toBe('hello world')
    expect(document.activeElement).not.toBe(el)
    vi.advanceTimersByTime(600)
    expect(loadDraftMessage('s1')).toBe('hello world')
  })

  test('badges survive an append, in place and in order', () => {
    saveDraftMessage('s1', 'see @src/a.ts and @src/b.ts')
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    expect(badges(el)).toEqual(['src/a.ts', 'src/b.ts'])
    target().insert('please')
    expect(badges(el)).toEqual(['src/a.ts', 'src/b.ts'])
    vi.advanceTimersByTime(600)
    expect(loadDraftMessage('s1')).toBe('see @src/a.ts and @src/b.ts please')
  })

  test('focused with a caret between two badges: text goes in at the caret, both badges stay, caret after it', () => {
    saveDraftMessage('s1', '@src/a.ts fix @src/b.ts')
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    // Nodes: ZWS, badge a, ZWS, ' fix ', ZWS, badge b, ZWS. Caret after ' fix'.
    const middle = [...el.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent === ' fix ')!
    caret(middle, 4)
    target().insert('this now')
    expect(badges(el)).toEqual(['src/a.ts', 'src/b.ts'])
    vi.advanceTimersByTime(600)
    expect(loadDraftMessage('s1')).toBe('@src/a.ts fix this now @src/b.ts')
    expect(document.activeElement).toBe(el)
    // The caret sits right after the dictated text.
    const sel = window.getSelection()!
    const pre = document.createRange()
    pre.setStart(el, 0)
    pre.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset)
    expect(sel.isCollapsed).toBe(true)
    expect(pre.toString().split(ZWS).join('')).toBe('a.ts fix this now')
  })
})

/** Types `text` as the whole content of the composer, caret at the end, as the browser would. */
function typeIn(el: HTMLElement, text: string) {
  el.textContent = text
  if (el.firstChild) caret(el.firstChild, text.length)
  else caret(el, 0)
  fireEvent.input(el)
}
const saved = () => { vi.advanceTimersByTime(600); return loadDraftMessage('s1') }

describe('dictated text is plain text, inserted in place', () => {
  test('a typed email stays text: no badge appears and the take is appended', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    typeIn(el, 'ping me@x.com')
    el.blur()
    target().insert('later')
    expect(badges(el)).toEqual([])
    expect(el.textContent).toBe('ping me@x.com later')
    expect(saved()).toBe('ping me@x.com later')
  })

  test('an @ inside the take never becomes a badge', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    target().insert('ask @john about it')
    expect(badges(el)).toEqual([])
    expect(el.textContent).toBe('ask @john about it')
  })

  test('with the mention popover open on a half-typed @sr, the take updates it the way typing would', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    typeIn(el, 'fix @sr')
    expect(screen.getByTestId('file-mention').textContent).toBe('sr')
    target().insert('please')
    // Typing ' please' after '@sr' ends the mention query, so the popover closes.
    expect(screen.queryByTestId('file-mention')).toBeNull()
    expect(badges(el)).toEqual([])
    expect(saved()).toBe('fix @sr please')
  })

  test('unfocused: appends, and leaves focus and the selection where they were', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    typeIn(el, 'hello')
    const other = document.createElement('textarea')
    document.body.appendChild(other)
    other.focus()
    const outside = document.createElement('p')
    outside.textContent = 'elsewhere'
    document.body.appendChild(outside)
    caret(outside.firstChild!, 3)
    target().insert('world')
    expect(el.textContent).toBe('hello world')
    expect(document.activeElement).toBe(other)
    const sel = window.getSelection()!
    expect([sel.anchorNode, sel.anchorOffset]).toEqual([outside.firstChild, 3])
    other.remove(); outside.remove()
  })

  test('a non-collapsed selection is replaced by the take', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    typeIn(el, 'fix the bug')
    const range = document.createRange()
    range.setStart(el.firstChild!, 4)
    range.setEnd(el.firstChild!, 7)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    target().insert('a')
    expect(el.textContent).toBe('fix a bug')
    expect(saved()).toBe('fix a bug')
  })
})

describe('a take saved to the draft of a chat the composer is not showing', () => {
  test('lands in the in-memory draft too, so switching back shows it and storage agrees', () => {
    const [sid, setSid] = createSignal('s1')
    const { container } = render(() => <MessageInput sessionId={sid()} isRunning={false} />)
    typeIn(editor(container), 'a')
    setSid('s2')
    appendToDraft('s1', 'b')
    setSid('s1')
    expect(editor(container).textContent).toBe('a b')
    expect(saved()).toBe('a b')
  })

  test('same when that draft was empty in memory', () => {
    const [sid, setSid] = createSignal('s1')
    const { container } = render(() => <MessageInput sessionId={sid()} isRunning={false} />)
    typeIn(editor(container), 'a')
    typeIn(editor(container), '')
    setSid('s2')
    appendToDraft('s1', 'b')
    setSid('s1')
    expect(editor(container).textContent).toBe('b')
    expect(saved()).toBe('b')
  })

  test('a chat this composer never opened still gets the stored draft', () => {
    render(() => <MessageInput sessionId="s2" isRunning={false} />)
    saveDraftMessage('s9', 'x')
    appendToDraft('s9', 'y')
    expect(loadDraftMessage('s9')).toBe('x y')
  })
})
