import { For, createSignal } from 'solid-js'

export interface ChipListProps {
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

export function ChipList(props: ChipListProps) {
  const [draft, setDraft] = createSignal('')
  const commit = () => {
    const v = draft().trim()
    if (!v) return
    if (props.values.includes(v)) { setDraft(''); return }
    props.onChange([...props.values, v])
    setDraft('')
  }
  const remove = (v: string) => props.onChange(props.values.filter(x => x !== v))
  return (
    <div class="flex flex-wrap items-center gap-1.5">
      <For each={props.values}>
        {(v) => (
          <span class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md bg-surface-2 ring-1 ring-border-subtle">
            <span>{v}</span>
            <button
              type="button"
              aria-label={`Remove ${v}`}
              class="text-text-dim hover:text-text-primary"
              onClick={() => remove(v)}
            >×</button>
          </span>
        )}
      </For>
      <input
        class="bg-transparent text-xs px-2 py-0.5 outline-none ring-1 ring-transparent focus:ring-border-subtle rounded-md"
        placeholder={props.placeholder ?? 'Add'}
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
        onBlur={commit}
      />
    </div>
  )
}
