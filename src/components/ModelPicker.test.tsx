import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
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
import { applySnapshot } from '../store/accounts'
import { makeAccount, makeIdentity, makeSnapshot } from '../test/accountFixtures'

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

// A harness with added accounts lists each one as its own group under its name,
// and picking a model in it says which account the session is for. A harness
// without accounts is the same list as above, picked without an account.
describe('<ModelPicker /> with accounts', () => {
  const acme = makeAccount()
  const beta = makeAccount({ id: 'a2', label: 'Beta', color: '#16a34a' })
  const work = makeAccount({ id: 'c1', agentType: 'codex', label: 'Work', color: '#ea580c' })

  beforeEach(() => {
    setSessionsState([])
    cleanup()
  })
  afterEach(() => applySnapshot(makeSnapshot()))

  const modelRows = (base: HTMLElement) => Array.from(base.querySelectorAll('button[data-pick-row]:not([data-show-more])'))
  const headers = (base: HTMLElement) => Array.from(base.querySelectorAll('.sticky')).map((h) => h.textContent ?? '')
  const root = (base: HTMLElement) => base.querySelector('[data-picker-root]') as HTMLElement

  test('account rows appear and pick passes the selection', () => {
    applySnapshot(makeSnapshot({ accounts: [acme] }))
    const onPick = vi.fn()
    const { baseElement } = render(() => <ModelPicker open={true} onClose={() => {}} onPick={onPick} />)

    const names = headers(baseElement)
    expect(names).toHaveLength(3)
    expect(names[0]).toContain('Claude · Default')
    expect(names[1]).toContain('Claude · Acme')
    expect(names[2]).toContain('Codex')
    expect(names[2]).not.toContain('·')

    // Default shows 4 models, then Acme's 4: the first of them is Acme's Sonnet.
    fireEvent.click(modelRows(baseElement)[4])

    expect(onPick).toHaveBeenCalledOnce()
    expect(onPick).toHaveBeenCalledWith('claude', 'sonnet', { kind: 'account', id: 'a1' })
  })

  test('the Default row picks Default, whatever the project uses', () => {
    applySnapshot(makeSnapshot({ accounts: [acme], projectAccounts: [{ projectId: 'p1', agentType: 'claude', accountId: 'a1' }] }))
    const onPick = vi.fn()
    const { baseElement } = render(() => <ModelPicker open={true} projectId="p1" onClose={() => {}} onPick={onPick} />)

    // Acme leads (the project uses it), then Default.
    fireEvent.click(modelRows(baseElement)[4])

    expect(onPick).toHaveBeenCalledWith('claude', 'sonnet', { kind: 'default' })
  })

  test('a harness without accounts picks without one', () => {
    applySnapshot(makeSnapshot({ accounts: [acme] }))
    const onPick = vi.fn()
    const { baseElement } = render(() => <ModelPicker open={true} onClose={() => {}} onPick={onPick} />)

    const rows = modelRows(baseElement)
    fireEvent.click(rows[rows.length - 1])

    expect(onPick).toHaveBeenCalledWith('codex', 'gpt-5', undefined)
  })

  test('accounts of one harness leave the others alone', () => {
    applySnapshot(makeSnapshot({ accounts: [work] }))
    const { baseElement } = render(() => <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />)

    const names = headers(baseElement)
    expect(names).toHaveLength(3)
    expect(names[0]).toContain('Claude')
    expect(names[0]).not.toContain('·')
    expect(names[1]).toContain('Codex · Default')
    expect(names[2]).toContain('Codex · Work')
  })

  test('the project account leads and is the first row, so Enter picks it', () => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [{ projectId: 'p1', agentType: 'claude', accountId: 'a2' }] }))
    const onPick = vi.fn()
    const { baseElement } = render(() => <ModelPicker open={true} projectId="p1" defaultAgent="claude" onClose={() => {}} onPick={onPick} />)

    const names = headers(baseElement)
    expect(names.map((n) => n.replace(/(Current)?\d+$/, ''))).toEqual(['Claude · Beta', 'Claude · Default', 'Claude · Acme', 'Codex'])

    fireEvent.keyDown(root(baseElement), { key: 'Enter' })

    expect(onPick).toHaveBeenCalledWith('claude', 'sonnet', { kind: 'account', id: 'a2' })
  })

  test('without a project Default leads', () => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta], projectAccounts: [{ projectId: 'p1', agentType: 'claude', accountId: 'a2' }] }))
    const onPick = vi.fn()
    const { baseElement } = render(() => <ModelPicker open={true} onClose={() => {}} onPick={onPick} />)

    fireEvent.keyDown(root(baseElement), { key: 'Enter' })

    expect(onPick).toHaveBeenCalledWith('claude', 'sonnet', { kind: 'default' })
  })

  // "Current" marks where the picker was opened from: the harness of the session
  // and, once the harness has accounts, its account (`defaultAccountId`: an
  // account's id, or null for Default), so only that group says so.
  describe('the current tag', () => {
    beforeEach(() => applySnapshot(makeSnapshot({ accounts: [acme, beta] })))

    // Groups, for a project that uses no account: Claude · Default, Claude · Acme, Claude · Beta, Codex.
    const taggedGroups = (base: HTMLElement) => headers(base).map((h) => h.toLowerCase().includes('current'))
    const open = (props: { defaultAccountId?: string | null; defaultModel?: string; defaultAgent?: 'claude' | 'codex' } = {}) =>
      render(() => <ModelPicker open={true} defaultAgent="claude" onClose={() => {}} onPick={() => {}} {...props} />).baseElement

    test('goes to the group of the account the current session runs on', () => {
      expect(taggedGroups(open({ defaultAccountId: 'a1' }))).toEqual([false, true, false, false])
    })

    test('goes to the Default group for a session on Default', () => {
      expect(taggedGroups(open({ defaultAccountId: null }))).toEqual([true, false, false, false])
    })

    test('goes to every group of the harness when the caller does not say which account', () => {
      expect(taggedGroups(open())).toEqual([true, true, true, false])
    })

    test('goes to no group of the harness when the account of the session is not offered any more', () => {
      expect(taggedGroups(open({ defaultAccountId: 'gone' }))).toEqual([false, false, false, false])
    })

    test('goes to the harness as before when it has no accounts, whatever account is named', () => {
      applySnapshot(makeSnapshot({ accounts: [work] }))

      // Claude is one group; Codex has Default and Work.
      expect(taggedGroups(open({ defaultAccountId: null }))).toEqual([true, false, false])
      cleanup()
      expect(taggedGroups(open({ defaultAccountId: 'c1' }))).toEqual([true, false, false])
    })

    test('does not follow the account to another harness', () => {
      // A Codex session on Work: the Codex Work group is the one, nothing of Claude.
      applySnapshot(makeSnapshot({ accounts: [acme, work] }))

      expect(taggedGroups(open({ defaultAgent: 'codex', defaultAccountId: 'c1' }))).toEqual([false, true, false, false])
    })

    test('marks the current model in the group of the current account only', () => {
      const base = open({ defaultModel: 'opus', defaultAccountId: 'a2' })

      const tagged = modelRows(base).filter((r) => r.textContent?.toLowerCase().includes('current'))
      expect(tagged).toHaveLength(1)
      expect(tagged[0].textContent).toContain('Opus')
      // The header is the first child of the group that holds the row.
      expect(tagged[0].parentElement!.firstElementChild!.textContent).toContain('Claude · Beta')
    })

    test('does not reach the Default group of another harness that has a model of the same id', () => {
      // Harnesses can offer a model by the same id (Cursor and Gemini both have "auto"), and
      // each has a Default group, which is the same key but for the harness.
      const codexModels = agentsList[1].models as Array<{ id: string; label: string; description: string }>
      codexModels.push({ id: 'opus', label: 'Opus on Codex', description: '' })
      try {
        applySnapshot(makeSnapshot({ accounts: [acme, work] }))

        const tagged = modelRows(open({ defaultAccountId: null, defaultModel: 'opus' })).filter((r) => r.textContent?.toLowerCase().includes('current'))

        expect(tagged.map((r) => r.parentElement!.firstElementChild!.textContent)).toEqual([expect.stringContaining('Claude · Default')])
      } finally {
        codexModels.pop()
      }
    })

    test('marks the current model in every group of the harness when the caller does not say which account', () => {
      const base = open({ defaultModel: 'opus' })

      const tagged = modelRows(base).filter((r) => r.textContent?.toLowerCase().includes('current'))
      expect(tagged.map((r) => r.parentElement!.firstElementChild!.textContent)).toEqual([
        expect.stringContaining('Claude · Default'),
        expect.stringContaining('Claude · Acme'),
        expect.stringContaining('Claude · Beta'),
      ])
    })
  })

  test('each account group collapses on its own', () => {
    applySnapshot(makeSnapshot({ accounts: [acme] }))
    const { baseElement } = render(() => <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />)
    // Claude has 5 models: 4 show per group, one hidden behind "Show 1 more".
    expect(modelRows(baseElement)).toHaveLength(4 + 4 + 1)
    expect(baseElement.querySelectorAll('button[data-show-more]')).toHaveLength(2)

    fireEvent.click(baseElement.querySelectorAll('button[data-show-more]')[0])

    expect(modelRows(baseElement)).toHaveLength(5 + 4 + 1)
    expect(baseElement.querySelectorAll('button[data-show-more]')).toHaveLength(1)
  })

  test('Enter on "Show N more" expands the group it is in', () => {
    applySnapshot(makeSnapshot({ accounts: [acme] }))
    const onPick = vi.fn()
    const { baseElement } = render(() => <ModelPicker open={true} onClose={() => {}} onPick={onPick} />)

    // Down to Acme's "Show 1 more" (4 Default models, its own row, then Acme's 4 models).
    for (let i = 0; i < 9; i++) fireEvent.keyDown(root(baseElement), { key: 'ArrowDown' })
    fireEvent.keyDown(root(baseElement), { key: 'Enter' })
    expect(modelRows(baseElement)).toHaveLength(4 + 5 + 1)

    // The cursor stays where it was: now on Acme's fifth model.
    fireEvent.keyDown(root(baseElement), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('claude', 'opus-4-5', { kind: 'account', id: 'a1' })
  })

  test('search finds an account by its label', () => {
    applySnapshot(makeSnapshot({ accounts: [acme, beta] }))
    const { baseElement } = render(() => <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />)

    fireEvent.input(baseElement.querySelector('input') as HTMLInputElement, { target: { value: 'beta' } })

    const names = headers(baseElement)
    expect(names).toHaveLength(1)
    expect(names[0]).toContain('Claude · Beta')
  })

  test('an account shows its color, Default does not', () => {
    applySnapshot(makeSnapshot({ accounts: [acme] }))
    const { baseElement } = render(() => <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />)

    const [defaultHeader, acmeHeader] = Array.from(baseElement.querySelectorAll('.sticky'))
    expect(defaultHeader.querySelector('[data-testid="account-color"]')).toBeNull()
    expect((acmeHeader.querySelector('[data-testid="account-color"]') as HTMLElement).style.backgroundColor).toBe('rgb(124, 58, 237)')
  })

  test('the Default row says who the harness is signed in as', () => {
    applySnapshot(makeSnapshot({
      accounts: [acme],
      defaults: [{ agentType: 'claude', identity: makeIdentity({ status: 'signedIn', email: 'me@home.dev' }) }],
    }))
    const { baseElement } = render(() => <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />)

    const [defaultHeader, acmeHeader] = Array.from(baseElement.querySelectorAll('.sticky'))
    expect(defaultHeader.textContent).toContain('me@home.dev')
    expect(acmeHeader.textContent).not.toContain('me@home.dev')
  })

  test('follows the accounts store while open', () => {
    const { baseElement } = render(() => <ModelPicker open={true} onClose={() => {}} onPick={() => {}} />)
    expect(headers(baseElement)).toHaveLength(2)

    applySnapshot(makeSnapshot({ accounts: [acme] }))

    expect(headers(baseElement)).toHaveLength(3)
  })
})
