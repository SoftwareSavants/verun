import { For, Show, createSignal } from 'solid-js'
import { Lock } from 'lucide-solid'
import type { BashPattern } from '../types'
import { HARD_BLOCK_PATTERNS } from '../types'
import { AddPatternForm, type AddPatternSuggestion } from './AddPatternForm'

type HardBlocks = ReadonlyArray<{ id: string, label: string }>

export type BashPatternListProps =
  | {
      mode: 'global'
      patterns: BashPattern[]
      hardBlocks?: HardBlocks
      onChange: (next: BashPattern[]) => void
      builtinSuggestions?: ReadonlyArray<AddPatternSuggestion>
    }
  | {
      mode: 'project'
      global: BashPattern[]
      projectBash: { disabledGlobal: string[], extra: BashPattern[] }
      hardBlocks?: HardBlocks
      onProjectBashChange: (next: { disabledGlobal: string[], extra: BashPattern[] }) => void
      builtinSuggestions?: ReadonlyArray<AddPatternSuggestion>
    }

function LockedRow(props: { label: string }) {
  return (
    <div class="flex items-center gap-2 py-1 text-sm" data-locked="true">
      <Lock size={12} class="text-text-dim" />
      <span class="text-text-primary">{props.label}</span>
      <span class="ml-auto text-xs text-text-dim">Worktree protection</span>
    </div>
  )
}

export function BashPatternList(props: BashPatternListProps) {
  const [adding, setAdding] = createSignal(false)
  const hardBlocks = () => props.hardBlocks ?? HARD_BLOCK_PATTERNS

  if (props.mode === 'global') {
    const remove = (id: string) =>
      props.onChange(props.patterns.filter(p => p.id !== id))
    const add = (p: BashPattern) => {
      props.onChange([...props.patterns, p])
      setAdding(false)
    }
    const suggestions = () => (props.builtinSuggestions ?? [])
      .filter(s => !props.patterns.some(p => p.id === s.id))
    return (
      <div class="ring-1 ring-border-subtle rounded-lg p-4 bg-surface-1">
        <h3 class="text-sm font-medium">Bash deny patterns</h3>
        <p class="text-xs text-text-dim mt-1">
          Bash commands matching these patterns will require approval. Everything else is auto-allowed.
        </p>
        <div class="mt-3">
          <For each={hardBlocks()}>{(h) => <LockedRow label={h.label} />}</For>
          <For each={props.patterns}>
            {(p) => (
              <div class="flex items-center gap-2 py-1 text-sm">
                <span class="text-text-primary">{p.pattern}</span>
                <button
                  type="button"
                  aria-label={`Remove ${p.pattern}`}
                  class="ml-auto text-text-dim hover:text-text-primary"
                  onClick={() => remove(p.id)}
                >×</button>
              </div>
            )}
          </For>
        </div>
        <Show when={!adding()} fallback={
          <div class="mt-3"><AddPatternForm
            suggestions={suggestions()}
            onAdd={add}
            onCancel={() => setAdding(false)}
          /></div>
        }>
          <button
            class="mt-3 px-2.5 py-1 text-xs ring-1 ring-border-subtle rounded-md"
            onClick={() => setAdding(true)}
          >+ Add pattern</button>
        </Show>
      </div>
    )
  }

  // mode === 'project'
  const toggle = (id: string) => {
    const isDisabled = props.projectBash.disabledGlobal.includes(id)
    props.onProjectBashChange({
      ...props.projectBash,
      disabledGlobal: isDisabled
        ? props.projectBash.disabledGlobal.filter(x => x !== id)
        : [...props.projectBash.disabledGlobal, id],
    })
  }
  const removeExtra = (id: string) =>
    props.onProjectBashChange({
      ...props.projectBash,
      extra: props.projectBash.extra.filter(p => p.id !== id),
    })
  const addExtra = (p: BashPattern) => {
    props.onProjectBashChange({
      ...props.projectBash,
      extra: [...props.projectBash.extra, p],
    })
    setAdding(false)
  }
  return (
    <div class="ring-1 ring-border-subtle rounded-lg p-4 bg-surface-1">
      <h3 class="text-sm font-medium">Bash deny patterns</h3>
      <p class="text-xs text-text-dim mt-1">
        Toggle off a global pattern to allow it in this project. Add project-only patterns at the bottom.
      </p>

      <For each={hardBlocks()}>{(h) => <LockedRow label={h.label} />}</For>

      <p class="mt-3 text-xs text-text-dim">From global config:</p>
      <For each={props.global}>
        {(p) => {
          const disabled = () => props.projectBash.disabledGlobal.includes(p.id)
          return (
            <div class="flex items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                aria-label={`Toggle ${p.pattern}`}
                checked={!disabled()}
                onChange={() => toggle(p.id)}
              />
              <span classList={{ 'text-text-primary': !disabled(), 'text-text-dim line-through': disabled() }}>
                {p.pattern}
              </span>
            </div>
          )
        }}
      </For>

      <p class="mt-3 text-xs text-text-dim">Project-only patterns:</p>
      <For each={props.projectBash.extra}>
        {(p) => (
          <div class="flex items-center gap-2 py-1 text-sm">
            <span class="text-text-primary">{p.pattern}</span>
            <button
              type="button"
              aria-label={`Remove ${p.pattern}`}
              class="ml-auto text-text-dim hover:text-text-primary"
              onClick={() => removeExtra(p.id)}
            >×</button>
          </div>
        )}
      </For>

      <Show when={!adding()} fallback={
        <div class="mt-3"><AddPatternForm
          suggestions={[]}
          onAdd={addExtra}
          onCancel={() => setAdding(false)}
        /></div>
      }>
        <button
          class="mt-3 px-2.5 py-1 text-xs ring-1 ring-border-subtle rounded-md"
          onClick={() => setAdding(true)}
        >+ Add pattern</button>
      </Show>
    </div>
  )
}
