import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@solidjs/testing-library'

// Stub the terminals store: TerminalPanel reads from it but for this test we
// only care about the chrome around the empty state, so an empty list suffices.
const terminalsMocks = vi.hoisted(() => ({
  terminalsForTask: vi.fn(() => []),
  activeTerminalId: vi.fn(() => undefined),
  setActiveTerminalForTask: vi.fn(),
  spawnTerminal: vi.fn(() => Promise.resolve()),
  closeTerminal: vi.fn(() => Promise.resolve()),
  focusActiveTerminal: vi.fn(),
  terminalExitCodes: vi.fn(() => ({})),
  isTerminalStopped: vi.fn(() => false),
  spawnStartCommand: vi.fn(() => Promise.resolve()),
  // Treat the task as hydrated but with no terminals so the createEffect that
  // would auto-spawn one is gated by the empty terminals + spawning guard.
  isTaskHydrated: vi.fn(() => false),
}))
vi.mock('../store/terminals', () => terminalsMocks)

vi.mock('../store/setup', () => ({ isSetupRunning: vi.fn(() => false) }))

vi.mock('../lib/ipc', () => ({
  stopHook: vi.fn(() => Promise.resolve()),
  runHook: vi.fn(() => Promise.resolve()),
  ptyClose: vi.fn(() => Promise.resolve()),
}))

// xterm needs a real DOM and WebGL — neither of which jsdom supplies. Stub the
// terminal so the panel can mount and we can inspect its outer chrome.
vi.mock('./ShellTerminal', () => ({
  ShellTerminal: () => {
    const el = document.createElement('div')
    el.setAttribute('data-testid', 'shell-terminal')
    return el
  },
}))

import { TerminalPanel } from './TerminalPanel'

beforeEach(() => {
  cleanup()
})

describe('TerminalPanel chrome adapts to the theme', () => {
  // Regression: the panel container baked in `bg-[#0a0a0a]`, leaving the empty
  // state and any gaps around the xterm canvas stuck on a black background
  // even after the user switched to light mode. Surface tokens flip with the
  // theme; raw hex does not.
  test('outer container uses a surface token, not a hardcoded dark hex', () => {
    const { container } = render(() => <TerminalPanel taskId="t-1" />)
    const outer = container.firstElementChild as HTMLElement
    expect(outer).toBeTruthy()
    const cls = outer.className
    expect(cls).not.toMatch(/bg-\[#0a0a0a\]/)
    expect(cls).toMatch(/bg-surface-0\b/)
  })
})
