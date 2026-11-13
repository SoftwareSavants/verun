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

  test('an interrupted agent reads as stopped, not as an error; a failure does', () => {
    const stopped = render(() => (
      <AgentBlockView block={base({ progress: { taskId: 't', status: 'stopped', summary: "didn't finish before the previous session ended" } })} />
    ))
    expect(stopped.container.textContent).toContain('Stopped')
    expect(stopped.container.querySelector('[class*="text-status-error"]')).toBeNull()
    cleanup()
    const failed = render(() => (
      <AgentBlockView block={base({ progress: { taskId: 't', status: 'failed', error: 'Rate limited' } })} />
    ))
    expect(failed.container.querySelector('[class*="text-status-error"]')).not.toBeNull()
    // The status word itself reads as a failure, not just its icon.
    const word = [...failed.container.querySelectorAll('span')].filter(s => s.textContent === 'Failed' && !s.querySelector('span')).pop()
    expect(word?.className).toContain('text-status-error')
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

  test('the task leads the header; the agent type follows it', () => {
    const { container } = render(() => <AgentBlockView block={base({ progress: { taskId: 't', status: 'running' } })} />)
    const text = header(container).textContent ?? ''
    expect(text.indexOf('Review diff')).toBeLessThan(text.indexOf('code-reviewer'))
  })

  test('while it runs, its last three steps show under the header', () => {
    const read = (n: number) => ({ type: 'tool' as const, id: `c${n}`, tool: 'Read', input: JSON.stringify({ file_path: `/r/.verun/worktrees/w/src/file${n}.ts` }), result: { text: 'ok', isError: false } })
    const { container } = render(() => (
      <AgentBlockView block={base({ progress: { taskId: 't', status: 'running' }, children: [read(1), read(2), read(3), read(4), read(5)] })} />
    ))
    const text = container.textContent ?? ''
    for (const n of [3, 4, 5]) expect(text).toContain(`src/file${n}.ts`)
    for (const n of [1, 2]) expect(text).not.toContain(`src/file${n}.ts`)
    // A preview of a longer log says so.
    expect(text).toContain('2 earlier steps')
    cleanup()
    // Done, it folds back to its result.
    const done = render(() => <AgentBlockView block={base({ result: { text: 'All good', isError: false }, children: [read(1)] })} />)
    expect(done.container.textContent).not.toContain('src/file1.ts')
  })

  test('its preview rows are the same step rows as its log, and the earlier-steps line opens the log', () => {
    const kids = [1, 2, 3, 4, 5].map(n => ({ type: 'tool' as const, id: `c${n}`, tool: 'Read', input: '{}', result: { text: 'ok', isError: false } }))
    const { container, getByRole } = render(() => (
      <AgentBlockView
        block={base({ progress: { taskId: 't', status: 'running' }, children: kids })}
        renderChild={c => <div data-row>{(c as { id: string }).id}</div>}
      />
    ))
    expect([...container.querySelectorAll('[data-row]')].map(e => e.textContent)).toEqual(['c3', 'c4', 'c5'])
    fireEvent.click(getByRole('button', { name: '2 earlier steps' }))
    expect(header(container).getAttribute('aria-expanded')).toBe('true')
    expect([...getByRole('log').querySelectorAll('[data-row]')].map(e => e.textContent)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
  })

  test('opened, its whole log scrolls in a pane of its own, above the report', () => {
    const { container, getByRole } = render(() => (
      <AgentBlockView block={base({ result: { text: 'Report body', isError: false } })}>
        <div>step row</div>
      </AgentBlockView>
    ))
    fireEvent.click(header(container))
    const log = getByRole('log')
    expect(log.textContent).toContain('step row')
    expect(log.className).toMatch(/max-h-/)
    expect(log.className).toContain('overflow-y-auto')
    expect(log.textContent).not.toContain('Report body')
    expect(container.textContent).toContain('Report body')
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
