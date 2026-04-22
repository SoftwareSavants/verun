import { describe, expect, test, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const { MERGE_OVERRIDE_SPEC } = await import('./DiffEditor')

// Regression: removing `{ dark: true }` from verunTheme means CodeMirror no
// longer adds `.cm-dark` to the editor root, so @codemirror/merge's default
// `&dark .cm-collapsedLines` rule never matches and the light-mode `#f3f3f3`
// gradient bled into dark mode. Override it with theme-aware CSS vars so it
// flips with `[data-theme]` instead of depending on `.cm-dark`.
describe('MERGE_OVERRIDE_SPEC', () => {
  test('overrides .cm-collapsedLines with theme-aware CSS vars', () => {
    const rule = MERGE_OVERRIDE_SPEC['.cm-collapsedLines'] as Record<string, string> | undefined
    expect(rule, 'collapsedLines override is missing').toBeDefined()
    expect(rule!.background).toMatch(/var\(--surface-/)
    expect(rule!.color).toMatch(/var\(--text-/)
  })
})
