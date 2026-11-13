import { Show, For, createSignal } from 'solid-js'
import { Mic, Loader2, Check, Plus } from 'lucide-solid'
import { clsx } from 'clsx'
import { voiceStatus, voiceState, voiceLevel, toggleDictation, openDictationSetup } from '../store/voice'
import { holdKeyName } from '../lib/holdKeyName'
import { LANGUAGE_NAMES } from '../lib/voiceLanguages'
import * as ipc from '../lib/ipc'
import type { Language } from '../types/voice'
import { Popover } from './Popover'

// Each bar follows the level with its own gain, so speech reads as movement.
const BAR_GAINS = [0.6, 1, 0.75]

/** Mic button, recording/transcribing state and quick language switcher, shared by both composers. */
export function DictationControl() {
  const [menuOpen, setMenuOpen] = createSignal(false)
  const supported = () => {
    const s = voiceStatus()
    return s?.supported ? s : null
  }
  const stateLabel = () => {
    const state = voiceState()
    return state === 'recording' ? 'Recording' : state === 'transcribing' ? 'Transcribing' : undefined
  }
  const choose = (code: Language) => {
    setMenuOpen(false)
    ipc.voiceSetLanguage(code).catch(e => console.error('voice set language:', e))
  }
  const addLanguage = () => {
    setMenuOpen(false)
    openDictationSetup()
  }

  return (
    <Show when={supported()}>
      {status => (
        <div class="flex items-center gap-0.5 shrink-0">
          <Show when={status().enabled}>
            <div class="relative">
              <button
                type="button"
                class="h-7 px-1.5 flex items-center justify-center rounded-lg text-[11px] font-medium text-text-dim hover:text-text-muted hover:bg-surface-2 transition-colors"
                aria-label={`Dictation language: ${LANGUAGE_NAMES[status().language]}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen()}
                title="Dictation language"
                onMouseDown={e => e.preventDefault()}
                onClick={() => setMenuOpen(!menuOpen())}
              >
                {status().language.toUpperCase()}
              </button>
              <Popover open={menuOpen()} onClose={() => setMenuOpen(false)} class="py-1 w-48 absolute bottom-full right-0 mb-1">
                <div role="menu" aria-label="Dictation language">
                  <For each={status().languages.filter(l => l.installed)}>
                    {lang => {
                      const selected = () => status().language === lang.code
                      return (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected()}
                          class={clsx(
                            'w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 transition-colors',
                            selected() ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary',
                          )}
                          onClick={() => choose(lang.code)}
                        >
                          <span class="flex-1 min-w-0 truncate">{LANGUAGE_NAMES[lang.code]}</span>
                          <Show when={selected()}><Check size={13} class="text-accent-hover flex-shrink-0" aria-hidden="true" /></Show>
                        </button>
                      )
                    }}
                  </For>
                  <div class="my-1 h-px bg-outline/8" aria-hidden="true" />
                  <button
                    type="button"
                    role="menuitem"
                    class="w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
                    onClick={addLanguage}
                  >
                    <Plus size={13} class="flex-shrink-0" aria-hidden="true" />
                    <span>Add language...</span>
                  </button>
                </div>
              </Popover>
            </div>
          </Show>
          <button
            type="button"
            class={clsx(
              'w-7 h-7 flex items-center justify-center rounded-lg transition-colors shrink-0',
              voiceState() === 'recording' ? 'text-accent bg-accent/10 hover:bg-accent/20' : 'text-text-dim hover:text-text-muted hover:bg-surface-2',
            )}
            aria-label="Dictate"
            aria-pressed={voiceState() === 'recording'}
            title={status().enabled ? `Dictate (hold ${holdKeyName(status().holdKey)})` : 'Set up dictation'}
            onMouseDown={e => e.preventDefault()}
            onClick={() => toggleDictation()}
          >
            <Show when={voiceState() === 'recording'} fallback={
              <Show when={voiceState() === 'transcribing'} fallback={<Mic size={15} aria-hidden="true" />}>
                <Loader2 size={15} class="animate-spin" aria-hidden="true" />
              </Show>
            }>
              <span class="flex items-center gap-0.5 h-3.5" aria-hidden="true">
                <For each={BAR_GAINS}>
                  {gain => (
                    <span
                      data-level-bar
                      class="w-0.75 h-full rounded-full bg-accent origin-center transition-transform duration-75"
                      style={{ transform: `scaleY(${Math.max(0.2, Math.min(1, voiceLevel() * gain * 1.6))})` }}
                    />
                  )}
                </For>
              </span>
            </Show>
          </button>
          {/* Always mounted so screen readers announce each change of state. */}
          <span role="status" class="sr-only" aria-label={stateLabel()}>{stateLabel() ?? ''}</span>
        </div>
      )}
    </Show>
  )
}
