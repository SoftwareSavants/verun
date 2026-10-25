import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import { Check, ChevronDown, Search } from 'lucide-solid'
import type { AccountSelection, AgentType, ModelOption } from '../types'
import { agents } from '../store/agents'
import { agentIcon, meetsVersionReq } from '../lib/agents'
import { accountChoicesFor, agentRows, PROJECT_DEFAULT, selectedChoice } from '../lib/accounts'
import { registerDismissable } from '../lib/dismissable'
import SvgIcon from './SvgIcon'
import { AgentRowName } from './AgentRowName'

interface Props {
  agent: AgentType
  model?: string
  /** The account the session would run on. The project's when left out. */
  account?: AccountSelection
  /** The project the session is for: its account for each harness is the one listed first. */
  projectId?: string
  disabled?: boolean
  onPick: (agent: AgentType, model?: string, account?: AccountSelection) => void
}

/**
 * Browsing a harness is temporary; choosing a model commits both values. A
 * harness with accounts is a row for each, and the model commits its account too.
 */
export function HarnessModelPicker(props: Props) {
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const rows = createMemo(() => agentRows(agents, props.projectId))
  const hasAccounts = () => rows().some(r => r.choice)
  // The row being browsed: `AgentRow.key`, which names the account as well as the harness.
  const [browsing, setBrowsing] = createSignal<string>(props.agent)
  const [query, setQuery] = createSignal('')
  const [position, setPosition] = createSignal({ left: 0, top: 0, width: 420, height: 320 })
  let trigger!: HTMLButtonElement
  let panel!: HTMLDivElement
  const current = () => agents.find(a => a.id === props.agent)
  const currentModel = () => current()?.models.find(m => m.id === props.model) ?? current()?.models[0]
  // The account the session would run on: the one chosen, else the project's when
  // the harness no longer offers that one. None for a harness without accounts.
  const currentChoice = createMemo(() => {
    const choices = accountChoicesFor(props.agent, props.projectId)
    return selectedChoice(choices, props.account ?? PROJECT_DEFAULT) ?? selectedChoice(choices, PROJECT_DEFAULT) ?? choices[0]
  })
  const currentKey = () => currentChoice()?.key ?? props.agent
  const accountSuffix = () => {
    const choice = currentChoice()
    return choice && choice.selection.kind !== 'default' ? ` · ${choice.label}` : ''
  }
  const label = () => `${currentModel()?.label ?? current()?.name ?? props.agent}${accountSuffix()}`
  const browsingRow = () => rows().find(r => r.key === browsing())
  const harness = () => browsingRow()?.agent
  const models = () => (harness()?.models ?? []).filter(m => `${m.label} ${m.id} ${m.description}`.toLowerCase().includes(query().toLowerCase()))
  const close = () => { setOpen(false); trigger?.focus() }
  const show = () => {
    if (props.disabled) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(hasAccounts() ? 520 : 420, window.innerWidth - 16)
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const height = Math.min(320, Math.max(below, above))
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: below >= height ? rect.bottom + 6 : Math.max(8, rect.top - height - 6), width, height })
    setBrowsing(currentKey())
    setQuery('')
    setOpen(true)
    queueMicrotask(() => panel?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus())
  }
  createEffect(() => {
    if (props.disabled && open()) close()
    if (!open()) return
    const unregister = registerDismissable(close)
    window.addEventListener('resize', close)
    onCleanup(() => { unregister(); window.removeEventListener('resize', close) })
  })
  const pick = (model?: ModelOption) => {
    const row = browsingRow()
    if (!row?.agent.installed || !meetsVersionReq(row.agent.cliVersion, model?.minVersion)) return
    props.onPick(row.agent.id, model?.id, row.choice?.selection)
    close()
  }
  const onKey = (event: KeyboardEvent) => {
    const buttons = Array.from(panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled), input'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Tab') {
      if (event.shiftKey && index === 0) { event.preventDefault(); buttons[buttons.length - 1]?.focus() }
      else if (!event.shiftKey && index === buttons.length - 1) { event.preventDefault(); buttons[0]?.focus() }
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && document.activeElement?.tagName !== 'INPUT') {
      event.preventDefault()
      const next = buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]
      next?.focus(); next?.scrollIntoView?.({ block: 'nearest' })
    }
  }
  return <>
    <button ref={trigger} type="button" aria-label={`Choose model: ${label()}`} title={current()?.name}
      aria-haspopup="dialog" aria-expanded={open()} aria-controls={open() ? id : undefined} disabled={props.disabled}
      class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      onClick={() => open() ? close() : show()}>
      <SvgIcon svg={agentIcon(props.agent)} size={14} /><span>{label()}</span><ChevronDown size={12} class="text-text-dim" />
    </button>
    <Show when={open()}><Portal>
      <div class="fixed inset-0 z-100" onClick={close} />
      <div ref={panel} id={id} role="dialog" aria-label="Choose harness and model" aria-modal="true" onKeyDown={onKey}
        class="fixed z-[101] flex overflow-hidden rounded-xl bg-surface-2 ring-1 ring-outline/10 shadow-xl"
        style={{ left: `${position().left}px`, top: `${position().top}px`, width: `${position().width}px`, height: `${position().height}px` }}>
        <div class="shrink-0 bg-surface-1 p-2 overflow-y-auto border-r-1 border-r-solid border-r-outline/8"
          classList={{ 'w-34': !hasAccounts(), 'w-64': hasAccounts() }}>
          <For each={rows()}>{row => <button type="button" disabled={!row.agent.installed} aria-label={row.name} aria-pressed={browsing() === row.key}
            title={!row.agent.installed ? `${row.name} is not installed` : row.name}
            class="w-full flex items-center gap-2 text-left rounded-md px-2 py-2 text-xs disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent"
            classList={{ 'bg-surface-3 text-text-primary': browsing() === row.key, 'text-text-muted hover:bg-surface-2': browsing() !== row.key }}
            onClick={() => { setBrowsing(row.key); setQuery('') }}>
            <SvgIcon svg={agentIcon(row.agent.id)} size={13} />
            <span class="min-w-0 flex-1">
              <AgentRowName row={row} />
              <Show when={row.detail}><span class="block truncate text-[10px] text-text-dim">{row.detail}</span></Show>
            </span>
          </button>}</For>
        </div>
        <div class="min-w-0 flex-1 flex flex-col">
          <div class="p-2 pb-1">
            <div class="flex items-center gap-2 rounded-md bg-surface-1 px-2.5 py-2 text-text-muted focus-within:ring-1 focus-within:ring-accent/40"><Search size={13} /><input aria-label="Search models" placeholder="Search models…" value={query()} onInput={e => setQuery(e.currentTarget.value)} class="min-w-0 w-full bg-transparent text-xs text-text-primary outline-none" /></div>
          </div>
          <div class="flex-1 overflow-y-auto p-1.5">
            <Show when={harness()?.supportsModelSelection && harness()?.models.length} fallback={<button class="w-full text-left rounded-md p-2 text-xs text-text-primary hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-accent" disabled={!harness()?.installed} onClick={() => pick()}>CLI default<span class="block text-text-muted mt-1">Use the harness’s configured model</span></button>}>
              <For each={models()}>{model => {
                const locked = () => !meetsVersionReq(harness()?.cliVersion, model.minVersion)
                const selected = () => currentKey() === browsing() && currentModel()?.id === model.id
                return <button type="button" disabled={locked()} aria-label={model.label} aria-pressed={selected()} onClick={() => pick(model)}
                  class="w-full flex items-center gap-2 text-left rounded-md p-2 hover:bg-surface-3 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent">
                  <span class="min-w-0 flex-1"><span class="block text-xs text-text-primary font-medium">{model.label}</span>
                    <span class="block text-[11px] text-text-muted mt-0.5">{locked() ? `Requires CLI ${model.minVersion}` : model.description}</span></span>
                  <Show when={selected()}><Check size={13} class="shrink-0 text-accent" /></Show>
                </button>
              }}</For>
              <Show when={!models().length}><p class="p-3 text-xs text-text-muted">No matching models.</p></Show>
            </Show>
          </div>
        </div>
      </div>
    </Portal></Show>
  </>
}
