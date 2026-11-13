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
  const { container, getByRole } = render(() => <ChatView output={store.items} sessionId="s-render" />)
  return { container, getByRole, setStore }
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

  test("a running subagent's latest steps show inside its block, and its whole log opens there", () => {
    const { container, getByRole } = setup(transcript())
    const block = container.querySelector('[data-agent-id="toolu_A"]')!
    const header = block.querySelector('button[aria-expanded]')!
    expect(header.textContent).toContain('code-reviewer')
    expect(header.textContent).toContain('Review diff')
    // Not flattened into the main list: its step shows inside the block.
    expect(block.textContent).toContain('rm -rf build')
    expect(container.querySelectorAll('[data-agent-id] ~ *').length).toBe(0)
    fireEvent.click(header)
    expect(getByRole('log').textContent).toContain('rm -rf build')
  })

  test('an approval pending on a subagent tool marks its block as needing input', () => {
    setPendingApprovals('s-render', [{ requestId: 'r', sessionId: 's-render', toolName: 'Bash', toolInput: {}, toolUseId: 'toolu_B' }])
    const { container } = setup(transcript())
    expect(container.querySelector('button[aria-expanded]')!.textContent).toContain('Needs input')
    setPendingApprovals('s-render', [])
  })
})

describe('work log', () => {
  const step = (id: string, tool: string, input: object, result = 'ok'): OutputItem[] => [
    { kind: 'toolStart', tool, input: JSON.stringify(input), id } as OutputItem,
    { kind: 'toolResult', text: result, isError: false, toolUseId: id } as OutputItem,
  ]
  const finished: OutputItem[] = [
    { kind: 'userMessage', text: 'fix it', timestamp: 1_000 } as OutputItem,
    text('Looking at the parser.'),
    ...step('t1', 'Read', { file_path: '/r/.verun/worktrees/w/src/parse.ts' }),
    ...step('t2', 'Bash', { command: 'pnpm test', description: 'Run the tests' }),
    text('Fixed the parser; all tests pass.'),
    { kind: 'turnEnd', status: 'completed', timestamp: 126_000 } as OutputItem,
  ]

  test('a finished turn folds its work into one row above the final reply', () => {
    const { container, getByRole } = setup(finished)
    const row = getByRole('button', { name: /Worked for 2m 5s/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.textContent).toContain('2 steps')
    const t = container.textContent ?? ''
    expect(t).toContain('Fixed the parser; all tests pass.')
    expect(t).not.toContain('Looking at the parser.')
    expect(t).not.toContain('Run the tests')
    fireEvent.click(row)
    expect(container.textContent).toContain('Looking at the parser.')
    expect(container.textContent).toContain('Run the tests')
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

describe('catching up', () => {
  const turn = (prompt: string, at: number, endedAt: number): OutputItem[] => [
    { kind: 'userMessage', text: prompt, timestamp: at } as OutputItem,
    text(`answer to ${prompt}`),
    { kind: 'turnEnd', status: 'completed', timestamp: endedAt } as OutputItem,
  ]
  const items = [...turn('first', 100, 200), ...turn('second', 300, 400), ...turn('third', 500, 600)]

  test('marks where the turns finished since the last look begin', () => {
    localStorage.setItem('verun:chatSeen', JSON.stringify({ 's-catch': 250 }))
    const { container } = render(() => <ChatView output={items} sessionId="s-catch" />)
    const divider = container.querySelector('[data-unseen-divider]')
    expect(divider?.textContent).toContain('2 turns since')
    const t = container.textContent ?? ''
    expect(t.indexOf('answer to first')).toBeLessThan(t.indexOf('2 turns since'))
    expect(t.indexOf('2 turns since')).toBeLessThan(t.indexOf('second'))
  })

  test('no divider when everything was seen', () => {
    localStorage.setItem('verun:chatSeen', JSON.stringify({ 's-catch2': 900 }))
    const { container } = render(() => <ChatView output={items} sessionId="s-catch2" />)
    expect(container.querySelector('[data-unseen-divider]')).toBeNull()
  })

  test('long sessions get a turn outline to jump between prompts', () => {
    const { getByRole } = render(() => <ChatView output={items} sessionId="s-catch3" />)
    expect(getByRole('navigation', { name: 'Turns' })).toBeTruthy()
    expect(getByRole('button', { name: /Turn 2: second/ })).toBeTruthy()
  })
})
