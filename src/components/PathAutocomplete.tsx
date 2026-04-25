import { Component, createEffect, createMemo, createSignal, For, Show, on, onCleanup } from 'solid-js'
import { Folder, FolderPlus, FolderOpen } from 'lucide-solid'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { createSubdir, listSubdirs } from '../lib/ipc'

interface Props {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  autoFocus?: boolean
}

function splitPath(raw: string): { parent: string; prefix: string } {
  if (raw === '') return { parent: '~', prefix: '' }
  const idx = raw.lastIndexOf('/')
  if (idx === -1) return { parent: '~', prefix: raw }
  return { parent: raw.slice(0, idx) || '/', prefix: raw.slice(idx + 1) }
}

function join(parent: string, name: string): string {
  if (parent === '/') return `/${name}/`
  return `${parent}/${name}/`
}

const VALID_NAME = /^[^/\\]+$/

type Row = { kind: 'dir'; name: string } | { kind: 'create'; name: string }

export const PathAutocomplete: Component<Props> = (props) => {
  const [entries, setEntries] = createSignal<string[]>([])
  const [highlight, setHighlight] = createSignal(0)
  const [dismissed, setDismissed] = createSignal(true)
  const [focused, setFocused] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [createError, setCreateError] = createSignal<string | null>(null)
  let inputRef: HTMLInputElement | undefined
  let listRef: HTMLUListElement | undefined
  const itemRefs: HTMLLIElement[] = []

  createEffect(
    on(highlight, (idx) => {
      const el = itemRefs[idx]
      if (el && listRef && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' })
      }
    }),
  )

  createEffect(
    on(
      () => props.value,
      async (val) => {
        const { parent } = splitPath(val)
        try {
          const list = await listSubdirs(parent)
          setEntries(list)
          setHighlight(0)
          setCreateError(null)
        } catch {
          setEntries([])
        }
      },
    ),
  )

  const matches = createMemo<string[]>(() => {
    const { prefix } = splitPath(props.value)
    const all = entries()
    if (!prefix) return all
    const lower = prefix.toLowerCase()
    return all.filter((n) => n.toLowerCase().startsWith(lower))
  })

  const createName = createMemo<string | null>(() => {
    const { prefix } = splitPath(props.value)
    if (!prefix || prefix === '.' || prefix === '..' || !VALID_NAME.test(prefix)) return null
    const exact = entries().some((n) => n.toLowerCase() === prefix.toLowerCase())
    return exact ? null : prefix
  })

  const rows = createMemo<Row[]>(() => {
    const list: Row[] = matches().map((name) => ({ kind: 'dir', name }))
    const c = createName()
    if (c) list.push({ kind: 'create', name: c })
    return list
  })

  const open = () => focused() && !dismissed() && rows().length > 0

  const applyAt = async (idx: number) => {
    const row = rows()[idx]
    if (!row) return
    const { parent } = splitPath(props.value)
    if (row.kind === 'create') {
      if (creating()) return
      setCreating(true)
      setCreateError(null)
      try {
        await createSubdir(parent, row.name)
        const list = await listSubdirs(parent)
        setEntries(list)
        props.onChange(join(parent, row.name))
        setDismissed(false)
        setHighlight(0)
      } catch (e) {
        setCreateError(String(e))
      } finally {
        setCreating(false)
      }
      return
    }
    props.onChange(join(parent, row.name))
    setDismissed(false)
    setHighlight(0)
  }

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      if (!open()) return
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, rows().length - 1))
    } else if (e.key === 'ArrowUp') {
      if (!open()) return
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (!open()) return
      e.preventDefault()
      e.stopPropagation()
      void applyAt(highlight())
    } else if (e.key === 'Escape') {
      if (!open()) return
      e.preventDefault()
      e.stopPropagation()
      setDismissed(true)
    }
  }

  const onFocus = () => {
    setFocused(true)
    setDismissed(false)
  }
  const onBlur = () => {
    setTimeout(() => {
      setFocused(false)
      setDismissed(true)
    }, 120)
  }

  createEffect(() => {
    if (props.autoFocus && inputRef) inputRef.focus()
  })

  onCleanup(() => {})

  const browse = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false })
      if (typeof picked === 'string' && picked) {
        const next = picked.endsWith('/') ? picked : `${picked}/`
        props.onChange(next)
        setDismissed(true)
      }
    } catch {
      // user cancelled or plugin unavailable
    }
  }

  return (
    <div class="relative">
      <div class="relative">
        <input
          ref={inputRef}
          type="text"
          class="input-base font-mono text-[12px] pr-9"
          placeholder={props.placeholder ?? '~'}
          value={props.value}
          spellcheck={false}
          autocapitalize="off"
          autocorrect="off"
          role="textbox"
          onInput={(e) => props.onChange(e.currentTarget.value)}
          onKeyDown={handleKey}
          onFocus={onFocus}
          onBlur={onBlur}
        />
        <button
          type="button"
          aria-label="Browse for folder"
          title="Browse for folder"
          class="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-text-dim hover:text-text-primary hover:bg-surface-3 transition-colors"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void browse()}
        >
          <FolderOpen size={14} />
        </button>
      </div>
      <Show when={open()}>
        <ul
          ref={listRef}
          class="list-none m-0 p-1 absolute left-0 right-0 top-full mt-1 z-10 bg-surface-2 ring-1 ring-white/8 rounded-lg max-h-56 overflow-y-auto shadow-xl"
          role="listbox"
        >
          <For each={matches()}>
            {(name, i) => (
              <li
                ref={(el) => (itemRefs[i()] = el)}
                class="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs font-mono cursor-pointer transition-colors"
                classList={{
                  'bg-accent/15 text-text-primary': i() === highlight(),
                  'text-text-secondary hover:bg-surface-3': i() !== highlight(),
                }}
                onMouseEnter={() => setHighlight(i())}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void applyAt(i())}
              >
                <Folder size={12} class="shrink-0 text-text-dim" />
                <span class="truncate">{name}</span>
              </li>
            )}
          </For>
          <Show when={createName()}>
            {(name) => {
              const idx = () => matches().length
              return (
                <>
                  <Show when={matches().length > 0}>
                    <li role="separator" class="my-1 h-px bg-outline/8 list-none" aria-hidden="true" />
                  </Show>
                  <li
                    ref={(el) => (itemRefs[idx()] = el)}
                    class="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs font-mono cursor-pointer transition-colors"
                    classList={{
                      'bg-accent/15 text-text-primary': idx() === highlight(),
                      'text-text-secondary hover:bg-surface-3': idx() !== highlight(),
                    }}
                    onMouseEnter={() => setHighlight(idx())}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void applyAt(idx())}
                  >
                    <FolderPlus size={12} class="shrink-0" />
                    <span class="truncate">Create "{name()}"</span>
                  </li>
                </>
              )
            }}
          </Show>
        </ul>
      </Show>
      <Show when={createError()}>
        <div class="absolute left-0 right-0 top-full mt-1 px-2 py-1 text-[11px] text-status-error">
          {createError()}
        </div>
      </Show>
    </div>
  )
}
