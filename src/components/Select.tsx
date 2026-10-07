import { For, Show, createEffect, createSignal, createUniqueId, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import { Check, ChevronDown } from 'lucide-solid'
import { registerDismissable } from '../lib/dismissable'

interface Option { value: string; label: string; disabled?: boolean }
interface Props {
  id?: string
  label: string
  value: string
  options: Option[]
  disabled?: boolean
  onChange: (value: string) => void
}

export function Select(props: Props) {
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal(0)
  const [rect, setRect] = createSignal({ left: 0, top: 0, width: 0, height: 240 })
  let trigger!: HTMLButtonElement
  const close = () => setOpen(false)
  const show = () => {
    if (props.disabled) return
    trigger.focus()
    const r = trigger.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 12
    const height = Math.min(240, Math.max(below, r.top - 12))
    setRect({ left: r.left, top: below >= height ? r.bottom + 4 : r.top - height - 4, width: r.width, height })
    setActive(Math.max(0, props.options.findIndex(o => o.value === props.value && !o.disabled)))
    setOpen(true)
  }
  const choose = (index: number) => {
    const option = props.options[index]
    if (!option || option.disabled || props.disabled) return
    props.onChange(option.value)
    close()
    trigger.focus()
  }
  createEffect(() => {
    if (props.disabled) close()
    if (!open()) return
    const unregister = registerDismissable(close)
    window.addEventListener('resize', close)
    onCleanup(() => { unregister(); window.removeEventListener('resize', close) })
  })
  const keyDown = (e: KeyboardEvent) => {
    if (e.key === 'Tab') { close(); return }
    if (!['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') { close(); return }
    if (!open()) { show(); return }
    if (e.key === 'Enter' || e.key === ' ') { choose(active()); return }
    const enabled = props.options.map((o, i) => o.disabled ? -1 : i).filter(i => i >= 0)
    if (!enabled.length) return
    const position = enabled.indexOf(active())
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? enabled.length - 1 : (position + (e.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length
    setActive(enabled[next])
    document.getElementById(`${id}-${active()}`)?.scrollIntoView?.({ block: 'nearest' })
  }
  return <>
    <button ref={trigger} id={props.id} type="button" role="combobox" aria-label={props.label}
      aria-expanded={open()} aria-haspopup="listbox" aria-controls={open() ? id : undefined}
      aria-activedescendant={open() ? `${id}-${active()}` : undefined} disabled={props.disabled}
      class="input-base flex items-center gap-2 text-left cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      onKeyDown={keyDown} onClick={() => open() ? close() : show()}>
      <span class="flex-1 truncate">{props.options.find(o => o.value === props.value)?.label ?? props.value}</span>
      <ChevronDown size={14} class="text-text-dim shrink-0" />
    </button>
    <Show when={open()}><Portal>
      <div class="fixed inset-0 z-[100]" onMouseDown={e => e.preventDefault()} onClick={close} />
      <div id={id} role="listbox" aria-label={props.label}
        class="fixed z-[101] overflow-y-auto bg-surface-2 ring-1 ring-outline/8 rounded-md shadow-xl py-1"
        style={{ left: `${rect().left}px`, top: `${rect().top}px`, width: `${rect().width}px`, 'max-height': `${rect().height}px` }}
        onMouseDown={e => e.preventDefault()}>
        <For each={props.options}>{(option, index) => <div id={`${id}-${index()}`} role="option"
          aria-selected={option.value === props.value} aria-disabled={!!option.disabled}
          class="flex items-center gap-2 px-3 py-2 text-xs cursor-pointer"
          classList={{ 'opacity-40': !!option.disabled, 'bg-accent-muted text-accent': active() === index(), 'text-text-secondary': active() !== index() }}
          onMouseMove={() => { if (!option.disabled) setActive(index()) }} onClick={() => choose(index())}>
          <span class="flex-1 break-words">{option.label}</span><Show when={option.value === props.value}><Check size={12} /></Show>
        </div>}</For>
      </div>
    </Portal></Show>
  </>
}
