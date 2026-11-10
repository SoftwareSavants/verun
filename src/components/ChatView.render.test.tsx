import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import { createStore, produce } from 'solid-js/store'
import { marked } from 'marked'

vi.mock('../lib/ipc', () => ({}))

import { ChatView, ToolBlockView } from './ChatView'
import type { OutputItem } from '../types'
import { setPendingApprovals } from '../store/sessions'

// The transcript keeps rendering what the store holds as it streams, as it is
// trimmed at a fixed length, and as it is replaced.

afterEach(() => cleanup())

const text = (t: string) => ({ kind: 'text', text: t }) as OutputItem
const user = (t: string) => ({ kind: 'userMessage', text: t, timestamp: 1 }) as OutputItem

function setup(initial: OutputItem[]) {
  const [store, setStore] = createStore<{ items: OutputItem[] }>({ items: initial })
  const { container } = render(() => <ChatView output={store.items} sessionId="s-render" />)
  return { container, setStore }
}

describe('ChatView transcript rendering', () => {
  test('streamed text extends the assistant block in place', async () => {
    const { container, setStore } = setup([user('hi'), text('Hello')])
    expect(container.textContent).toContain('Hello')
    setStore(produce(s => { s.items.push(text(' world')) }))
    await new Promise(r => requestAnimationFrame(() => r(null)))
    expect(container.textContent).toContain('Hello world')
    expect(container.querySelectorAll('.prose-verun').length).toBe(1)
  })

  test('keeps updating when the store trims old items at a fixed length', () => {
    const { container, setStore } = setup([user('one'), user('two'), user('three')])
    // Trim one from the front and append one: same length, new content.
    setStore(produce(s => { s.items = [...s.items.slice(1), user('four')] }))
    expect(container.textContent).toContain('four')
    expect(container.textContent).not.toContain('one')
  })

  test('a replaced output (older page prepended) rebuilds', () => {
    const { container, setStore } = setup([user('newer')])
    setStore(produce(s => { s.items = [user('older'), ...s.items] }))
    const t = container.textContent ?? ''
    expect(t.indexOf('older')).toBeGreaterThanOrEqual(0)
    expect(t.indexOf('older')).toBeLessThan(t.indexOf('newer'))
  })
})

describe('streaming markdown', () => {
  test('the streaming block re-renders at most once per frame', async () => {
    const { container, setStore } = setup([user('q'), text('a0')])
    const parse = vi.spyOn(marked, 'parse')
    for (let i = 1; i <= 5; i++) setStore(produce(s => { s.items.push(text(` a${i}`)) }))
    expect(parse.mock.calls.length).toBeLessThanOrEqual(1)
    await new Promise(r => requestAnimationFrame(() => r(null)))
    await new Promise(r => requestAnimationFrame(() => r(null)))
    expect(container.textContent).toContain('a0 a1 a2 a3 a4 a5')
    expect(parse.mock.calls.length).toBeLessThanOrEqual(2)
    parse.mockRestore()
  })

  test('a finished block shows its full text straight away', () => {
    const { container, setStore } = setup([user('q'), text('par')])
    setStore(produce(s => {
      s.items.push(text('tial'))
      s.items.push({ kind: 'turnEnd', status: 'completed' } as OutputItem)
    }))
    expect(container.textContent).toContain('partial')
  })
})

describe('subagents', () => {
  const sub = (item: object) => ({ kind: 'subagent', parentToolUseId: 'toolu_A', item }) as unknown as OutputItem
  const transcript = (): OutputItem[] => [
    user('review'),
    { kind: 'toolStart', tool: 'Agent', input: '{"description":"Review diff","subagent_type":"code-reviewer"}', id: 'toolu_A' } as unknown as OutputItem,
    { kind: 'agentProgress', taskId: 't1', toolUseId: 'toolu_A', status: 'running', toolUses: 2 } as unknown as OutputItem,
    sub({ kind: 'toolStart', tool: 'Bash', input: '{"command":"rm -rf build"}', id: 'toolu_B' }),
  ]

  test("a subagent's actions render inside its collapsed agent block", () => {
    const { container } = setup(transcript())
    const header = container.querySelector('button[aria-expanded]')!
    expect(header.textContent).toContain('code-reviewer')
    expect(header.textContent).toContain('Review diff')
    // Not flattened into the main list.
    expect(container.textContent).not.toContain('Bash')
    fireEvent.click(header)
    expect(container.textContent).toContain('Bash')
    expect(container.textContent).toContain('rm -rf build')
  })

  test('an approval pending on a subagent tool marks its block as needing input', () => {
    setPendingApprovals('s-render', [{ requestId: 'r', sessionId: 's-render', toolName: 'Bash', toolInput: {}, toolUseId: 'toolu_B' }])
    const { container } = setup(transcript())
    expect(container.querySelector('button[aria-expanded]')!.textContent).toContain('Needs input')
    setPendingApprovals('s-render', [])
  })
})

describe('ToolBlockView', () => {
  test('parses its input once across preview, expand and collapse', () => {
    const parse = vi.spyOn(JSON, 'parse')
    const { container } = render(() => (
      <ToolBlockView id="tool-parse" tool="Bash" input='{"command":"ls -la"}' result={{ text: 'ok', isError: false }} />
    ))
    expect(container.textContent).toContain('ls -la')
    const button = container.querySelector('button')!
    fireEvent.click(button)
    expect(container.textContent).toContain('$ ls -la')
    fireEvent.click(button)
    expect(parse.mock.calls.length).toBe(1)
    parse.mockRestore()
  })
})
