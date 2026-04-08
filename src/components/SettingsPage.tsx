import { Component, createSignal, For } from 'solid-js'
import { ChevronDown, X } from 'lucide-solid'
import { ACCENT_THEMES, getActiveTheme, setActiveTheme, type AccentTheme } from '../lib/theme'
import { setShowSettings, defaultWrapLines, setDefaultWrapLinesAndPersist, defaultHideWhitespace, setDefaultHideWhitespaceAndPersist } from '../store/ui'
import { Popover } from './Popover'
import { hasOverlayTitlebar } from '../lib/platform'
import { Toggle } from './Toggle'

export const SettingsPage: Component = () => {
  const [activeTheme, setActiveThemeSignal] = createSignal(getActiveTheme().name)
  const [dropdownOpen, setDropdownOpen] = createSignal(false)

  const current = () => ACCENT_THEMES.find(t => t.name === activeTheme()) ?? ACCENT_THEMES[0]

  const pickTheme = (t: AccentTheme) => {
    setActiveTheme(t)
    setActiveThemeSignal(t.name)
    setDropdownOpen(false)
  }

  return (
    <div class="flex-1 h-full bg-surface-0 overflow-y-auto">
      {/* Drag region (macOS overlay) */}
      {hasOverlayTitlebar && <div class="h-10 shrink-0 drag-region" />}

      <div class="max-w-lg mx-auto px-6 py-4">
        <div class="flex items-center justify-between mb-6">
          <h1 class="text-lg font-semibold text-text-primary">Settings</h1>
          <button
            class="p-1.5 rounded-lg text-text-dim hover:text-text-secondary border border-border hover:border-border-active transition-colors"
            onClick={() => setShowSettings(false)}
            title="Close (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Appearance section */}
        <div class="mb-8">
          <h2 class="section-title mb-4">Appearance</h2>

          {/* Theme / Accent color */}
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-text-primary">Accent color</div>
              <div class="text-xs text-text-dim mt-0.5">Used for buttons, links, and highlights</div>
            </div>

            {/* Dropdown */}
            <div class="relative">
              <button
                class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-2 border border-border hover:border-border-active transition-colors text-sm min-w-[140px]"
                onClick={() => setDropdownOpen(!dropdownOpen())}
              >
                <div
                  class="w-3 h-3 rounded-full shrink-0"
                  style={{ background: current().accent }}
                />
                <span class="text-text-secondary flex-1 text-left">{current().name}</span>
                <ChevronDown size={12} class="text-text-dim" />
              </button>

              <Popover open={dropdownOpen()} onClose={() => setDropdownOpen(false)} class="py-1 max-h-64 overflow-y-auto w-48 absolute right-0 top-full mt-1 bg-surface-2 border-border-active">
                <For each={ACCENT_THEMES}>
                  {(t) => (
                    <button
                      class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors hover:bg-surface-3"
                      style={{
                        color: activeTheme() === t.name ? t.accent : "#a1a1aa",
                        background: activeTheme() === t.name ? t.muted : undefined,
                      }}
                      onClick={() => pickTheme(t)}
                    >
                      <div
                        class="w-3 h-3 rounded-full shrink-0"
                        style={{ background: t.accent }}
                      />
                      <span>{t.name}</span>
                    </button>
                  )}
                </For>
              </Popover>
            </div>
          </div>
        </div>

        {/* Code Changes section */}
        <div class="mb-8">
          <h2 class="section-title mb-4">Code Changes</h2>

          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm text-text-primary">Wrap lines by default</div>
                <div class="text-xs text-text-dim mt-0.5">Wrap long lines in diff views</div>
              </div>
              <Toggle checked={defaultWrapLines()} onChange={(v) => setDefaultWrapLinesAndPersist(v)} />
            </div>

            <div class="flex items-center justify-between">
              <div>
                <div class="text-sm text-text-primary">Hide whitespace by default</div>
                <div class="text-xs text-text-dim mt-0.5">Ignore whitespace changes in diffs</div>
              </div>
              <Toggle checked={defaultHideWhitespace()} onChange={(v) => setDefaultHideWhitespaceAndPersist(v)} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
