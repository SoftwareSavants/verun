import { Component, createSignal, For, Show } from 'solid-js'
import { ChevronDown, X } from 'lucide-solid'
import { ACCENT_THEMES, getActiveTheme, setActiveTheme, type AccentTheme } from '../lib/theme'
import { setShowSettings } from '../store/ui'

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
      {/* Drag region */}
      <div class="h-10 shrink-0 drag-region" />

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
          <h2 class="text-xs font-medium text-text-muted uppercase tracking-wider mb-4">Appearance</h2>

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

              <Show when={dropdownOpen()}>
                <div class="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
                <div
                  class="absolute right-0 top-full mt-1 z-50 rounded-lg shadow-xl py-1 max-h-64 overflow-y-auto w-48 animate-in"
                  style={{ background: "#17171c", border: "1px solid #2e2e3a" }}
                >
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
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
