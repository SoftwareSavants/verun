import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@solidjs/testing-library'
import type { OutputItem } from '../types'

vi.mock('../lib/markdown', () => ({
  renderMarkdown: (text: string) => text,
  handleMarkdownLinkClick: vi.fn(),
  getWorktreePath: vi.fn(() => '/tmp/worktree'),
}))

vi.mock('../lib/mentions', () => ({
  parseMentions: (text: string) => [{ type: 'text', value: text }],
}))

vi.mock('../lib/format', () => ({
  formatCost: vi.fn(() => '$0.00'),
  formatTokens: vi.fn((n: number) => String(n)),
}))

vi.mock('../lib/ipc', () => ({}))

vi.mock('../store/sideQuestion', () => ({
  dismissSideQuestionUnread: vi.fn(),
  openSideQuestion: vi.fn(),
  sideQuestionPanel: vi.fn(() => null),
  sideQuestionState: vi.fn(() => ({ loading: false, unread: false })),
}))

vi.mock('../store/ui', () => ({
  addToast: vi.fn(),
  setSelectedTaskId: vi.fn(),
  setSelectedSessionIdForTask: vi.fn(),
}))

vi.mock('../store/tasks', () => ({
  setTasks: vi.fn(),
}))

vi.mock('../store/editorView', () => ({
  setMainView: vi.fn(),
}))

vi.mock('../store/sessionContext', () => ({
  planModeForSession: vi.fn(() => false),
  thinkingModeForSession: vi.fn(() => false),
  fastModeForSession: vi.fn(() => false),
}))

const loadOlderOutputLines = vi.fn(async () => 0)
let hasMore = false

vi.mock('../store/sessions', () => ({
  setSessions: vi.fn(),
  loadOutputLines: vi.fn(),
  loadOlderOutputLines: (...args: unknown[]) => loadOlderOutputLines(...args),
  hasMoreOutputLines: vi.fn(() => hasMore),
  sendMessage: vi.fn(),
  createSession: vi.fn(),
}))

vi.mock('./FileMentionBadge', () => ({
  FileMentionBadge: (props: { filePath: string }) => <span>{props.filePath}</span>,
}))

vi.mock('./ImageViewer', () => ({
  ImageViewer: () => null,
}))

vi.mock('./BlobImage', () => ({
  BlobImage: () => null,
}))

vi.mock('./Popover', () => ({
  Popover: (props: { children: unknown }) => props.children,
}))

import { ChatView } from './ChatView'

function item(text: string, timestamp: number): OutputItem {
  return { kind: 'userMessage', text, timestamp } as OutputItem
}

describe('ChatView older-history pagination', () => {
  beforeEach(() => {
    cleanup()
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0))
    hasMore = false
    loadOlderOutputLines.mockReset()
  })

  test('auto-loads older pages when the initial render does not overflow the viewport', async () => {
    hasMore = true
    loadOlderOutputLines.mockImplementation(async () => {
      hasMore = false
      return 5
    })

    const { container } = render(() => (
      <div style={{ height: '800px' }}>
        <ChatView
          output={[
            item('one', 1),
            item('two', 2),
            item('three', 3),
            item('four', 4),
            item('five', 5),
          ]}
          sessionId="s-codex"
          agentType="codex"
          sessionStatus="idle"
        />
      </div>
    ))

    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    expect(scroller).toBeTruthy()

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 900 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 300 })
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 0 })

    await vi.runAllTimersAsync()

    expect(loadOlderOutputLines).toHaveBeenCalledWith('s-codex')
    expect(loadOlderOutputLines).toHaveBeenCalledTimes(1)
  })

  test('keeps auto-loading older pages until the viewport becomes scrollable', async () => {
    hasMore = true
    let callCount = 0
    loadOlderOutputLines.mockImplementation(async () => {
      callCount += 1
      if (callCount >= 2) hasMore = false
      return 5
    })

    const { container } = render(() => (
      <div style={{ height: '800px' }}>
        <ChatView
          output={[item('one', 1), item('two', 2), item('three', 3)]}
          sessionId="s-codex"
          agentType="codex"
          sessionStatus="idle"
        />
      </div>
    ))

    const scroller = container.querySelector('.overflow-y-auto') as HTMLDivElement
    expect(scroller).toBeTruthy()

    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 900 })
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 0 })
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => (callCount >= 2 ? 1400 : 300),
    })

    await vi.runAllTimersAsync()

    expect(loadOlderOutputLines).toHaveBeenCalledTimes(2)
  })
})
