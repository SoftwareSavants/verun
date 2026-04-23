import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@solidjs/testing-library'

const { agentsList, sessionsState, setSessionsState } = vi.hoisted(() => {
  const state = { list: [] as Array<{ agentType: string; model: string | null; startedAt: number }> }
  return {
    agentsList: [
      {
        id: 'claude',
        name: 'Claude',
        installHint: '', updateHint: '', docsUrl: '',
        installed: true,
        cliVersion: '1.0.0',
        supportsStreaming: true, supportsResume: true, supportsPlanMode: true,
        supportsModelSelection: true, supportsEffort: true, supportsSkills: true,
        supportsAttachments: true, supportsFork: true,
        models: [
          { id: 'sonnet', label: 'Sonnet', description: 'Balanced' },
          { id: 'opus', label: 'Opus', description: 'Smartest' },
          { id: 'haiku', label: 'Haiku', description: 'Fastest' },
          { id: 'sonnet-4-5', label: 'Sonnet 4.5', description: '' },
          { id: 'opus-4-5', label: 'Opus 4.5', description: '' },
        ],
      },
      {
        id: 'codex',
        name: 'Codex',
        installHint: '', updateHint: '', docsUrl: '',
        installed: true,
        cliVersion: '1.0.0',
        supportsStreaming: true, supportsResume: true, supportsPlanMode: false,
        supportsModelSelection: true, supportsEffort: false, supportsSkills: false,
        supportsAttachments: false, supportsFork: false,
        models: [{ id: 'gpt-5', label: 'GPT-5', description: '' }],
      },
      {
        id: 'cursor',
        name: 'Cursor',
        installHint: '', updateHint: '', docsUrl: '',
        installed: false,
        supportsStreaming: false, supportsResume: false, supportsPlanMode: false,
        supportsModelSelection: false, supportsEffort: false, supportsSkills: false,
        supportsAttachments: false, supportsFork: false,
        models: [],
      },
    ],
    sessionsState: state,
    setSessionsState: (s: typeof state.list) => { state.list = s },
  }
})

vi.mock('../store/agents', () => ({
  agents: agentsList,
}))

vi.mock('../store/sessions', () => ({
  get sessions() { return sessionsState.list },
}))

vi.mock('./SvgIcon', () => ({
  default: () => <span data-testid="agent-icon" />,
}))

vi.mock('../lib/agents', () => ({
  agentIcon: () => '',
  meetsVersionReq: () => true,
}))

import { ModelPicker } from './ModelPicker'

describe('<ModelPicker />', () => {
  beforeEach(() => {
    setSessionsState([])
    cleanup()
  })

  test('renders nothing when closed', () => {
    const { container } = render(() => (
      <ModelPicker open={false} onClose={() => {}} onPick={() => {}} />
    ))
    expect(container.querySelector('input')).toBeNull()
  })

  test('caps each provider to 4 visible models and surfaces a "Show N more" row for the rest', () => {
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />
    ))
    // Model rows only (filter out the expander row)
    const modelRows = baseElement.querySelectorAll('button[data-pick-row]:not([data-show-more])')
    // Claude: 5 models → top-4 visible. Codex: 1. Cursor: not installed. = 5 rows.
    expect(modelRows.length).toBe(5)
    const showMore = baseElement.querySelector('button[data-show-more]')
    expect(showMore).not.toBeNull()
    expect(showMore!.textContent).toContain('Show 1 more')
  })

  test('search matches model rows across the full (sorted) list, not just the pre-collapse window', () => {
    // Regression: previously the component sliced to top-4 before filtering,
    // so matches in the hidden tail disappeared. Now it filters first and
    // then caps the *matches* at 4 per provider.
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />
    ))
    const input = baseElement.querySelector('input') as HTMLInputElement
    // "4.5" matches "Sonnet 4.5" and "Opus 4.5" — both live in the hidden tail
    // when we're collapsed, so with the old logic zero rows would render.
    fireEvent.input(input, { target: { value: '4.5' } })
    const modelRows = baseElement.querySelectorAll('button[data-pick-row]:not([data-show-more])')
    expect(modelRows.length).toBe(2)
    const texts = Array.from(modelRows).map(r => r.textContent ?? '')
    expect(texts.some(t => t.includes('Sonnet 4.5'))).toBe(true)
    expect(texts.some(t => t.includes('Opus 4.5'))).toBe(true)
    // No "Show more" row — both matches already fit under the cap.
    expect(baseElement.querySelector('button[data-show-more]')).toBeNull()
  })

  test('when search has more than 4 matches in one provider, the top-4 by LRU are shown and the rest become "Show N more"', () => {
    // Force LRU to reorder so the top-4 matches are deterministic.
    setSessionsState([
      { agentType: 'claude', model: 'sonnet-4-5', startedAt: 5 },
      { agentType: 'claude', model: 'opus-4-5', startedAt: 4 },
      { agentType: 'claude', model: 'haiku', startedAt: 3 },
      { agentType: 'claude', model: 'opus', startedAt: 2 },
      { agentType: 'claude', model: 'sonnet', startedAt: 1 },
    ])
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />
    ))
    const input = baseElement.querySelector('input') as HTMLInputElement
    // "claude" matches every claude model (agent.name is in the haystack).
    fireEvent.input(input, { target: { value: 'claude' } })
    const modelRows = baseElement.querySelectorAll('button[data-pick-row]:not([data-show-more])')
    expect(modelRows.length).toBe(4)
    // Top-4 by LRU: sonnet-4-5, opus-4-5, haiku, opus.
    const texts = Array.from(modelRows).map(r => r.textContent ?? '')
    expect(texts[0]).toContain('Sonnet 4.5')
    expect(texts[1]).toContain('Opus 4.5')
    expect(texts[2]).toContain('Haiku')
    expect(texts[3]).toContain('Opus')
    expect(texts[3]).not.toContain('4.5')
    const showMore = baseElement.querySelector('button[data-show-more]')
    expect(showMore?.textContent).toContain('Show 1 more')
  })

  test('groups rows by agent with a sticky header per agent', () => {
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />
    ))
    // Two agents installed → two group headers (Claude + Codex)
    const headers = Array.from(baseElement.querySelectorAll('.sticky'))
    expect(headers.length).toBe(2)
    expect(headers[0].textContent).toContain('Claude')
    expect(headers[1].textContent).toContain('Codex')
  })

  test('tags the default agent group with a "current" badge', () => {
    const { baseElement } = render(() => (
      <ModelPicker open={true} defaultAgent="claude" onClose={() => {}} onPick={() => {}} />
    ))
    const headers = Array.from(baseElement.querySelectorAll('.sticky'))
    expect(headers[0].textContent?.toLowerCase()).toContain('current')
    expect(headers[1].textContent?.toLowerCase()).not.toContain('current')
  })

  test('click picks agent and model', async () => {
    const onPick = vi.fn()
    const onClose = vi.fn()
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={onClose} onPick={onPick} />
    ))
    const rows = baseElement.querySelectorAll('button[data-pick-row]:not([data-show-more])')
    fireEvent.click(rows[0])
    expect(onClose).toHaveBeenCalled()
    expect(onPick).toHaveBeenCalled()
    const [agentId, modelId] = onPick.mock.calls[0]
    // No LRU data + default=claude → claude group first, models in declaration order.
    expect(agentId).toBe('claude')
    expect(modelId).toBe('sonnet')
  })

  test('Enter picks the active row', () => {
    const onPick = vi.fn()
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={() => {}} onPick={onPick} />
    ))
    const container = baseElement.querySelector('[data-picker-root]') as HTMLElement
    fireEvent.keyDown(container, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  test('ArrowDown moves the active row', () => {
    const onPick = vi.fn()
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={() => {}} onPick={onPick} />
    ))
    const container = baseElement.querySelector('[data-picker-root]') as HTMLElement
    fireEvent.keyDown(container, { key: 'ArrowDown' })
    fireEvent.keyDown(container, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
    // Second item with default claude first sort: claude/opus (index 1)
    const [, modelId] = onPick.mock.calls[0]
    expect(modelId).toBe('opus')
  })

  test('multi-token query matches across agent name and model name', () => {
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />
    ))
    const input = baseElement.querySelector('input') as HTMLInputElement
    // "claude opus" should match Claude agent + Opus model even though
    // the two tokens aren't adjacent in any single haystack string
    fireEvent.input(input, { target: { value: 'claude opus' } })
    const modelRows = baseElement.querySelectorAll('button[data-pick-row]:not([data-show-more])')
    // Matches: "Opus" and "Opus 4.5" — both have claude in the agent haystack
    // and "opus" in their label.
    expect(modelRows.length).toBe(2)
    expect(modelRows[0].textContent).toContain('Opus')
    expect(modelRows[1].textContent).toContain('Opus 4.5')
  })

  test('pressing Enter on the "Show N more" row expands the group in place', () => {
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />
    ))
    const root = baseElement.querySelector('[data-picker-root]') as HTMLElement
    // Walk ArrowDown to reach the "more" row (claude has 4 visible + more, then codex 1 → more is idx 4).
    for (let i = 0; i < 4; i++) fireEvent.keyDown(root, { key: 'ArrowDown' })
    fireEvent.keyDown(root, { key: 'Enter' })
    const modelRows = baseElement.querySelectorAll('button[data-pick-row]:not([data-show-more])')
    // All 5 claude + 1 codex = 6
    expect(modelRows.length).toBe(6)
    expect(baseElement.querySelector('button[data-show-more]')).toBeNull()
  })

  test('after Enter on "Show N more", the cursor stays on the newly-revealed row (does not jump back to index 0)', () => {
    const onPick = vi.fn()
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={() => {}} onPick={onPick} />
    ))
    const root = baseElement.querySelector('[data-picker-root]') as HTMLElement
    // Walk down to the "more" row (claude 4 visible + more = idx 4 for more).
    for (let i = 0; i < 4; i++) fireEvent.keyDown(root, { key: 'ArrowDown' })
    // Expand the group.
    fireEvent.keyDown(root, { key: 'Enter' })
    // Pressing Enter again should pick the newly-revealed row at the same idx,
    // NOT the first row of the list.
    fireEvent.keyDown(root, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
    const [agentId, modelId] = onPick.mock.calls[0]
    expect(agentId).toBe('claude')
    // No LRU data → original declaration order: [sonnet, opus, haiku, sonnet-4-5, opus-4-5]
    // idx 4 after expansion is opus-4-5.
    expect(modelId).toBe('opus-4-5')
  })

  test('clicking the "Show N more" row expands without picking or closing', () => {
    const onPick = vi.fn()
    const onClose = vi.fn()
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={onClose} onPick={onPick} />
    ))
    const showMore = baseElement.querySelector('button[data-show-more]') as HTMLButtonElement
    fireEvent.click(showMore)
    expect(onPick).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    const modelRows = baseElement.querySelectorAll('button[data-pick-row]:not([data-show-more])')
    expect(modelRows.length).toBe(6)
  })

  test('orders models within a provider by most-recently-used sessions (global LRU)', () => {
    setSessionsState([
      { agentType: 'claude', model: 'haiku', startedAt: 3000 },
      { agentType: 'claude', model: 'opus-4-5', startedAt: 9000 },
      { agentType: 'claude', model: 'sonnet', startedAt: 1000 },
    ])
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />
    ))
    const modelRows = baseElement.querySelectorAll('button[data-pick-row]:not([data-show-more])')
    // Expected visible order for claude: opus-4-5 (9000), haiku (3000), sonnet (1000),
    // then original-order tail for un-used models: opus, sonnet-4-5 — but collapse
    // takes only top-4 → opus-4-5, haiku, sonnet, opus.
    const labels = Array.from(modelRows).slice(0, 4).map(r => r.textContent)
    expect(labels[0]).toContain('Opus 4.5')
    expect(labels[1]).toContain('Haiku')
    expect(labels[2]).toContain('Sonnet')
    expect(labels[2]).not.toContain('4.5')
    expect(labels[3]).toContain('Opus')
    expect(labels[3]).not.toContain('4.5')
  })

  test('defaultModel is pinned first regardless of LRU so it is always visible', () => {
    setSessionsState([
      { agentType: 'claude', model: 'sonnet', startedAt: 9999 },
    ])
    const { baseElement } = render(() => (
      <ModelPicker open={true} defaultAgent="claude" defaultModel="opus-4-5" onClose={() => {}} onPick={() => {}} />
    ))
    const modelRows = baseElement.querySelectorAll('button[data-pick-row]:not([data-show-more])')
    expect(modelRows[0].textContent).toContain('Opus 4.5')
    expect(modelRows[0].textContent?.toLowerCase()).toContain('current')
  })

  test('onPick is called before onClose so callers that read from a signal still see the request', () => {
    const order: string[] = []
    const onClose = vi.fn(() => { order.push('close') })
    const onPick = vi.fn(() => { order.push('pick') })
    const { baseElement } = render(() => (
      <ModelPicker open={true} onClose={onClose} onPick={onPick} />
    ))
    const rows = baseElement.querySelectorAll('button[data-pick-row]')
    fireEvent.click(rows[0])
    expect(order).toEqual(['pick', 'close'])
  })

  test('puts defaultAgent at the top of the list', () => {
    const { baseElement } = render(() => (
      <ModelPicker open={true} defaultAgent="codex" onClose={() => {}} onPick={() => {}} />
    ))
    const headers = Array.from(baseElement.querySelectorAll('.sticky'))
    // Codex group should be first now
    expect(headers[0].textContent).toContain('Codex')
  })
})
