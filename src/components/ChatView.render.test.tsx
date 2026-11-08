import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'
import { createStore, produce } from 'solid-js/store'

vi.mock('../lib/ipc', () => ({}))

import { ChatView } from './ChatView'
import type { OutputItem } from '../types'

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
  test('streamed text extends the assistant block in place', () => {
    const { container, setStore } = setup([user('hi'), text('Hello')])
    expect(container.textContent).toContain('Hello')
    setStore(produce(s => { s.items.push(text(' world')) }))
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
