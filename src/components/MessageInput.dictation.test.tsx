import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSignal } from 'solid-js'
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library'
import type { DictationTarget } from '../store/voice'

// The session composer is a dictation target while it is the one on screen,
// and dictated text goes in through the same text -> DOM path as everything else.
const mocks = vi.hoisted(() => ({
  targets: [] as DictationTarget[],
  register: vi.fn(),
  /** The session belongs to a task in a project, so the command palette can show. */
  withTask: false,
}))

vi.mock('../store/voice', () => ({
  registerDictationTarget: (t: DictationTarget) => {
    mocks.register(t)
    mocks.targets.push(t)
    return () => { mocks.targets = mocks.targets.filter(x => x !== t) }
  },
}))
vi.mock('./DictationControl', () => ({ DictationControl: (p: { available: boolean }) => <span data-testid="dictation" data-available={String(p.available)} /> }))
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
vi.mock('../store/tasks', () => ({ taskById: (id: string) => (mocks.withTask ? { id, projectId: 'p1', worktreePath: '/wt' } : undefined) }))
vi.mock('../store/projects', () => ({ projectById: () => (mocks.withTask ? { id: 'p1', repoPath: '/repo' } : undefined) }))
vi.mock('../store/agents', () => ({ agents: [] }))
vi.mock('../store/commands', () => ({ primeSkills: vi.fn() }))
vi.mock('../store/editorView', () => ({ openFile: vi.fn(), setMainView: vi.fn() }))
vi.mock('../store/sideQuestion', () => ({ openSideQuestion: vi.fn() }))
vi.mock('./ModelSelector', () => ({ ModelSelector: () => null }))
vi.mock('./CommandPalette', () => ({ CommandPalette: (p: { query: string }) => <div data-testid="command-palette">{p.query}</div> }))
vi.mock('./FileMention', () => ({ FileMention: (p: { query: string }) => <div data-testid="file-mention">{p.query}</div> }))
vi.mock('./ImageViewer', () => ({ ImageViewer: () => null }))
vi.mock('./BlobImage', () => ({ BlobImage: () => null }))

import { MessageInput } from './MessageInput'
import { appendToDraft, loadDraftMessage, saveDraftMessage } from '../store/sessionDrafts'
import { setShowTaskBoard } from '../store/ui'
import { outputItems } from '../store/sessions'

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

/** jsdom has no execCommand: `insertText` as WebKit does it (replaces the selection, caret after, input event). */
const execCommand = vi.fn((command: string, _ui?: boolean, text?: string): boolean => {
  const sel = window.getSelection()
  if (command !== 'insertText' || text === undefined || !sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  node.parentElement?.closest('[contenteditable="true"]')?.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})
Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true })

beforeEach(() => {
  execCommand.mockClear()
  mocks.withTask = false
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
    expect(mocks.targets.map(t => ({ id: t.id, draftId: t.draftId }))).toEqual([{ id: 'session:s1', draftId: 's1' }])
    unmount()
    expect(mocks.targets).toEqual([])
  })

  test('switching session swaps the registration', () => {
    const [sid, setSid] = createSignal<string | null>('s1')
    render(() => <MessageInput sessionId={sid()} isRunning={false} />)
    setSid('s2')
    expect(mocks.targets.map(t => t.id)).toEqual(['session:s2'])
  })

  test('a composer with no session cannot be typed in, so it is not a target and its mic is unavailable', () => {
    render(() => <MessageInput sessionId={null} isRunning={false} />)
    expect(mocks.targets).toEqual([])
    expect(screen.getByTestId('dictation').dataset.available).toBe('false')
  })

  test('with a session its mic is available', () => {
    render(() => <MessageInput sessionId="s1" isRunning={false} />)
    expect(screen.getByTestId('dictation').dataset.available).toBe('true')
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

/** Sets the composer's DOM to `html` and puts the caret at `offset` into `node(el)`, as the browser would after typing. */
function typeHtml(el: HTMLElement, html: string, node: (el: HTMLElement) => Node, offset: number) {
  el.innerHTML = html
  caret(node(el), offset)
  fireEvent.input(el)
}

describe('the caret offset the composer reads', () => {
  test('one line: a half-typed @mention before the caret opens the popover with its query', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    typeHtml(el, 'see @src/ma', e => e.firstChild!, 11)
    expect(screen.getByTestId('file-mention').textContent).toBe('src/ma')
    // Caret moved back before the @: no mention query.
    caret(el.firstChild!, 3)
    fireEvent.input(el)
    expect(screen.queryByTestId('file-mention')).toBeNull()
  })

  test('several lines: the query is read at the caret on the last line', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    typeHtml(el, '<div>first</div><div>fix @sr</div>', e => e.lastChild!.firstChild!, 7)
    expect(screen.getByTestId('file-mention').textContent).toBe('sr')
  })

  test('several lines: a caret on an earlier line reads that line', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    typeHtml(el, '<div>a @x</div><div>b</div><div>c</div>', e => e.firstChild!.firstChild!, 4)
    expect(screen.getByTestId('file-mention').textContent).toBe('x')
  })

  test('ArrowUp in an empty composer, caret at the start, edits the last unsent message', () => {
    const items = outputItems as Record<string, unknown[]>
    items.s1 = [{ kind: 'userMessage', text: 'previous ask' }]
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    caret(el, 0)
    fireEvent.keyDown(el, { key: 'ArrowUp' })
    expect(el.textContent).toBe('previous ask')
    delete items.s1
  })

  test('ArrowUp with text in the composer does not', () => {
    const items = outputItems as Record<string, unknown[]>
    items.s1 = [{ kind: 'userMessage', text: 'previous ask' }]
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    typeIn(el, 'draft')
    caret(el.firstChild!, 0)
    fireEvent.keyDown(el, { key: 'ArrowUp' })
    expect(el.textContent).toBe('draft')
    delete items.s1
  })
})

describe('focused insert next to a badge', () => {
  const badge = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-mention]')!

  test('a caret inside a badge puts the take just after the badge, not into it', () => {
    saveDraftMessage('s1', 'see @src/a.ts')
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    caret(badge(el).firstChild!, 2)
    target().insert('now')
    expect(badge(el).textContent).toBe('a.ts')
    expect(badges(el)).toEqual(['src/a.ts'])
    expect(saved()).toBe('see @src/a.ts now')
    expect(badge(el).nextSibling?.textContent).toBe(' now')
  })

  test('a selection ending inside a badge ends after it', () => {
    saveDraftMessage('s1', 'fix @src/a.ts please')
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    const range = document.createRange()
    range.setStart(el.firstChild!, 0)
    range.setEnd(badge(el).firstChild!, 1)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    target().insert('check')
    expect(badges(el)).toEqual([])
    expect(saved()).toBe('check please')
  })

  test('a selection starting inside a badge starts after it', () => {
    saveDraftMessage('s1', 'fix @src/a.ts please')
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    const text = [...el.childNodes].find(n => n.textContent === ' please')!
    const range = document.createRange()
    range.setStart(badge(el).firstChild!, 2)
    range.setEnd(text, 7)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    target().insert('now')
    expect(badges(el)).toEqual(['src/a.ts'])
    expect(badge(el).textContent).toBe('a.ts')
    expect(saved()).toBe('fix @src/a.ts now')
  })
})

describe('unfocused insert lands at the end of what is shown', () => {
  const blurred = (el: HTMLElement) => { el.blur(); window.getSelection()?.removeAllRanges() }

  test('after a last line in its own block, the take joins that line', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    typeHtml(el, 'line1<div>line2</div>', e => e.lastChild!.firstChild!, 5)
    blurred(el)
    target().insert('take')
    const last = el.lastChild as HTMLElement
    expect(last.tagName).toBe('DIV')
    expect(last.textContent).toBe('line2 take')
    expect(saved()).toBe('line1\nline2 take')
  })

  test('nested blocks: the deepest last one', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    typeHtml(el, '<div>a<div>b</div></div>', e => e.firstChild!.lastChild!.firstChild!, 1)
    blurred(el)
    target().insert('c')
    expect((el.firstChild!.lastChild as HTMLElement).textContent).toBe('b c')
    expect(saved()).toBe('a\nb c')
  })

  test('an empty last line (placeholder <br> in a block): the take fills that line', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    typeHtml(el, 'line1<div><br></div>', e => e.lastChild!, 0)
    blurred(el)
    target().insert('take')
    const last = el.lastChild as HTMLElement
    expect(last.firstChild?.textContent).toBe('take')
    expect((last.lastChild as HTMLElement).tagName).toBe('BR')
    // As typing on that line would: no space after the line break.
    expect(saved()).toBe('line1\ntake\n')
  })

  test('hello<br><br>: the take goes on the empty last line, before its placeholder <br>', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    typeHtml(el, 'hello<br><br>', e => e, 2)
    blurred(el)
    target().insert('take')
    const nodes = [...el.childNodes].map(n => n.nodeName === 'BR' ? 'BR' : n.textContent)
    expect(nodes).toEqual(['hello', 'BR', 'take', 'BR'])
    expect(saved()).toBe('hello\ntake\n')
  })

  test('a trailing badge: the take follows it with a space', () => {
    saveDraftMessage('s1', 'see @src/a.ts')
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    target().insert('now')
    expect(badges(el)).toEqual(['src/a.ts'])
    expect(saved()).toBe('see @src/a.ts now')
  })

  test('a trailing zero-width space: the take follows it', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    typeHtml(el, `hi ${ZWS}`, e => e.firstChild!, 4)
    blurred(el)
    target().insert('there')
    expect(saved()).toBe('hi there')
    expect(el.textContent!.split(ZWS).join('')).toBe('hi there')
  })
})

describe('a focused take is one undo step, like a paste', () => {
  test('it goes in through insertText, the path the browser records for Cmd+Z', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    typeIn(el, 'fix')
    target().insert('it')
    expect(execCommand).toHaveBeenCalledWith('insertText', false, ' it')
    expect(el.textContent).toBe('fix it')
    expect(saved()).toBe('fix it')
  })

  test('an empty composer: the take replaces the placeholder <br> and goes in through insertText', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    typeHtml(el, '<br>', e => e, 0)
    target().insert('hello')
    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'hello')
    expect([...el.childNodes].map(n => n.nodeName)).toEqual(['#text'])
    expect(saved()).toBe('hello')
  })

  test('unfocused it is not typed: that would need focus, which a take must not steal', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    typeIn(el, 'fix')
    el.blur()
    target().insert('it')
    expect(execCommand).not.toHaveBeenCalled()
    expect(saved()).toBe('fix it')
  })
})

describe('a take never opens the mention or command popover', () => {
  beforeEach(() => { mocks.withTask = true })

  test('typing / does open the command palette these tests watch', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    typeIn(el, '/pl')
    expect(screen.getByTestId('command-palette')).toBeTruthy()
  })

  test('a focused take that starts with / opens no command palette', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    caret(el, 0)
    target().insert('/review')
    expect(screen.queryByTestId('command-palette')).toBeNull()
    expect(saved()).toBe('/review')
  })

  test('a focused take ending in an @word opens no mention popover', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    caret(el, 0)
    target().insert('ask @john')
    expect(screen.queryByTestId('file-mention')).toBeNull()
    expect(saved()).toBe('ask @john')
  })

  test('a take closes a mention popover the user had open', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    typeIn(el, 'fix @sr')
    expect(screen.getByTestId('file-mention')).toBeTruthy()
    target().insert('@john')
    expect(screen.queryByTestId('file-mention')).toBeNull()
    expect(saved()).toBe('fix @sr @john')
  })

  test('a take that makes the input /plan + space is text, not the plan-mode shortcut', () => {
    const { container } = render(() => <MessageInput sessionId="s1" isRunning={false} />)
    const el = editor(container)
    el.focus()
    typeIn(el, ' ')
    caret(el.firstChild!, 0)
    target().insert('/plan')
    // Typed, /plan + space toggles plan mode and empties the input.
    expect(el.textContent).toBe('/plan ')
    expect(saved()).toBe('/plan ')
  })
})
