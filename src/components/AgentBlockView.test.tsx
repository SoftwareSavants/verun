import { describe, test, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import { createStore } from 'solid-js/store'
import { AgentBlockView, revealAgent } from './AgentBlockView'
import type { AgentBlock } from './ChatView'

vi.mock('../lib/ipc', () => ({}))

afterEach(() => cleanup())

const base = (over: Partial<AgentBlock> = {}): AgentBlock => ({
  type: 'agent',
  id: `tool-${Math.random()}`,
  toolUseId: 'toolu_A',
  tool: 'Agent',
  input: '',
  description: 'Review diff',
  subagentType: 'code-reviewer',
  children: [],
  ...over,
})

function header(container: HTMLElement) {
  return container.querySelector('button[aria-expanded]') as HTMLButtonElement
}

describe('AgentBlockView', () => {
  test('header names the agent type, task and status in words', () => {
    const { container } = render(() => (
      <AgentBlockView block={base({ progress: { taskId: 't', status: 'running', toolUses: 12, totalTokens: 41_000, summary: 'reading types.ts' } })} />
    ))
    const text = container.textContent ?? ''
    expect(text).toContain('code-reviewer')
    expect(text).toContain('Review diff')
    expect(text).toContain('Running')
    expect(text).toContain('reading types.ts · 12 tools · 41k tokens')
  })

  test('names an untyped agent general-purpose, and says Starting before progress', () => {
    const { container } = render(() => (
      <AgentBlockView block={base({ subagentType: undefined, progress: { taskId: 't', status: 'running' } })} />
    ))
    expect(container.textContent).toContain('general-purpose')
    expect(container.textContent).toContain('Starting')
  })

  test('done shows the first line of the result; failed shows the reason', () => {
    const done = render(() => <AgentBlockView block={base({ result: { text: 'All good\nmore', isError: false } })} />)
    expect(done.container.textContent).toContain('Done')
    expect(done.container.textContent).toContain('All good')
    expect(done.container.textContent).not.toContain('more')
    cleanup()
    const failed = render(() => <AgentBlockView block={base({ progress: { taskId: 't', status: 'failed', error: 'API overloaded' } })} />)
    expect(failed.container.textContent).toContain('Failed')
    expect(failed.container.textContent).toContain('API overloaded')
  })

  test('needs input when one of its tools awaits approval', () => {
    const { container } = render(() => (
      <AgentBlockView block={base({ progress: { taskId: 't', status: 'running' } })} needsInput />
    ))
    expect(container.textContent).toContain('Needs input')
  })

  test('collapsed by default; the header button expands to the nested rows and full report', () => {
    const { container } = render(() => (
      <AgentBlockView block={base({ result: { text: 'Line one\nLine two', isError: false } })}>
        <div data-testid="child">nested row</div>
      </AgentBlockView>
    ))
    const btn = header(container)
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('nested row')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('nested row')
    expect(container.textContent).toContain('Line two')
  })

  test('collapses itself when the agent finishes, unless toggled after', () => {
    const [store, setStore] = createStore({ block: base({ id: 'tool-auto', progress: { taskId: 't', status: 'running' } }) })
    const { container } = render(() => <AgentBlockView block={store.block}><span>kids</span></AgentBlockView>)
    fireEvent.click(header(container))
    expect(container.textContent).toContain('kids')
    setStore('block', 'progress', { taskId: 't', status: 'completed' })
    expect(header(container).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(header(container))
    expect(header(container).getAttribute('aria-expanded')).toBe('true')
  })

  test('revealAgent scrolls to the block and highlights it', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const { container } = render(() => <AgentBlockView block={base({ toolUseId: 'toolu_R' })} />)
    revealAgent('toolu_R')
    expect(scroll).toHaveBeenCalled()
    expect(container.querySelector('[data-agent-id="toolu_R"]')!.getAttribute('data-highlighted')).toBe('true')
  })
})

describe('parallel agents', () => {
  test('consecutive agents join into one group instead of a stack of boxes', () => {
    const first = render(() => <AgentBlockView block={base()} joinNext />)
    const box = (c: HTMLElement) => c.querySelector('[data-agent-id]') as HTMLElement
    expect(box(first.container).className).toContain('rounded-b-none')
    cleanup()
    const middle = render(() => <AgentBlockView block={base()} joinPrev joinNext />)
    expect(box(middle.container).className).toContain('rounded-none')
    expect((middle.container.firstElementChild as HTMLElement).className).toContain('pt-0')
  })
  test('a lone agent stays a standalone block', () => {
    const { container } = render(() => <AgentBlockView block={base()} />)
    const el = container.querySelector('[data-agent-id]') as HTMLElement
    expect(el.className).toContain('rounded-md')
    expect(el.className).not.toContain('rounded-none')
  })
})
