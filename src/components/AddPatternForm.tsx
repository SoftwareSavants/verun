import { For, Show, createSignal } from 'solid-js'
import { parseBashPattern } from '../lib/ipc'
import type { BashPattern } from '../types'

export interface AddPatternSuggestion {
  id: string
  label: string
}

export interface AddPatternFormProps {
  suggestions: ReadonlyArray<AddPatternSuggestion>
  onAdd: (pattern: BashPattern) => void
  onCancel: () => void
}

function userIdFor(text: string): string {
  return 'user-' + text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

export function AddPatternForm(props: AddPatternFormProps) {
  const [text, setText] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)

  const submit = async () => {
    const t = text().trim()
    if (!t) { setError('pattern must not be empty'); return }
    try {
      await parseBashPattern(t)
      props.onAdd({ id: userIdFor(t), pattern: t })
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div class="ring-1 ring-border-subtle rounded-lg p-3 bg-surface-2">
      <label class="text-xs text-text-dim">Command pattern</label>
      <input
        class="w-full mt-1 bg-transparent ring-1 ring-border-subtle rounded-md px-2 py-1 text-sm outline-none focus:ring-accent/40"
        placeholder="e.g. npm publish"
        value={text()}
        onInput={(e) => { setText(e.currentTarget.value); setError(null) }}
      />
      <p class="mt-1 text-xs text-text-dim">
        Type the command as you would run it. The first word is the program; words starting with - are required flags.
      </p>
      <Show when={error()}>
        <p class="mt-1 text-xs text-danger">{error()}</p>
      </Show>
      <Show when={props.suggestions.length > 0}>
        <p class="mt-2 text-xs text-text-dim">Suggestions:</p>
        <div class="mt-1 flex flex-wrap gap-1">
          <For each={props.suggestions}>
            {(s) => (
              <button
                type="button"
                class="px-2 py-0.5 text-xs ring-1 ring-border-subtle rounded-md hover:bg-surface-3"
                onClick={() => props.onAdd({ id: s.id, pattern: s.label })}
              >+ {s.label}</button>
            )}
          </For>
        </div>
      </Show>
      <div class="mt-3 flex justify-end gap-2">
        <button class="px-2.5 py-1 text-xs ring-1 ring-border-subtle rounded-md" onClick={props.onCancel}>Cancel</button>
        <button class="px-2.5 py-1 text-xs ring-1 ring-accent/40 bg-accent/10 rounded-md" onClick={submit}>Add</button>
      </div>
    </div>
  )
}
