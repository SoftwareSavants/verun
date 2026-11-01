import { Component, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import { createStore } from 'solid-js/store'
import { ExternalLink, MessageSquareMore, X } from 'lucide-solid'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { ToolApprovalRequest } from '../types'
import { buildElicitationContent, elicitationFields, parseElicitation, type ElicitationValue } from '../lib/mcpElicitation'

interface Props {
  approval: ToolApprovalRequest
  pendingCount: number
  onRespond: (action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => void
}

// An MCP server asking the user for input mid-call: either a form built from
// its JSON schema, or a link to open (e.g. a sign-in page).
export const McpElicitationCard: Component<Props> = (props) => {
  const req = createMemo(() => parseElicitation(props.approval.toolInput))
  const fields = createMemo(() => elicitationFields(req().schema, req().propertyOrder))
  const [values, setValues] = createStore<Record<string, ElicitationValue>>(
    Object.fromEntries(
      fields().map(f => [
        f.key,
        f.kind === 'boolean'
          ? f.defaultValue === true
          : f.defaultValue === undefined ? '' : String(f.defaultValue),
      ]),
    ),
  )
  const [error, setError] = createSignal<string | null>(null)
  const [opened, setOpened] = createSignal(false)

  const submit = () => {
    const r = buildElicitationContent(fields(), values)
    if (!r.ok) {
      setError(r.error)
      return
    }
    props.onRespond('accept', r.content)
  }

  const openLink = async () => {
    const url = req().url
    if (!url) return
    await openUrl(url)
    setOpened(true)
  }

  const inputClass = 'w-full bg-surface-2 rounded-lg px-2 py-1.5 text-xs text-text-primary outline-none ring-1 ring-white/8 focus:ring-accent/40'

  return (
    <div class="bg-surface-1 border border-accent/30 rounded-xl p-3 mb-0 min-w-0 overflow-hidden">
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2 min-w-0">
          <MessageSquareMore size={14} class="text-accent shrink-0" />
          <span class="text-xs font-medium text-accent truncate">{req().serverName} needs your input</span>
          <Show when={props.pendingCount > 1}>
            <span class="text-[10px] bg-accent/15 text-accent px-1.5 py-0.5 rounded-full">+{props.pendingCount - 1} more</span>
          </Show>
        </div>
        <button
          class="p-1 rounded-md text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors"
          onClick={() => props.onRespond('cancel')}
          title="Dismiss (Esc)"
        >
          <X size={14} />
        </button>
      </div>
      <Show when={req().message}>
        <div class="text-sm text-text-primary mb-2 whitespace-pre-wrap break-words">{req().message}</div>
      </Show>

      <Switch>
        <Match when={req().mode === 'url'}>
          <Show when={req().url}>
            {(url) => <div class="text-[11px] text-text-muted font-mono bg-surface-2 rounded-lg p-2 mb-2 break-all">{url()}</div>}
          </Show>
          <div class="flex gap-2">
            <Show
              when={opened()}
              fallback={
                <button
                  class="flex-1 py-1.5 rounded-lg bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors flex items-center justify-center gap-1.5"
                  onClick={openLink}
                >
                  <ExternalLink size={12} /> Open link
                </button>
              }
            >
              <button
                class="flex-1 py-1.5 rounded-lg bg-status-running/15 text-status-running text-xs font-medium hover:bg-status-running/25 transition-colors"
                onClick={() => props.onRespond('accept')}
              >
                Done
              </button>
            </Show>
            <button
              class="flex-1 py-1.5 rounded-lg bg-status-error/15 text-status-error text-xs font-medium hover:bg-status-error/25 transition-colors"
              onClick={() => props.onRespond('decline')}
            >
              Decline
            </button>
          </div>
        </Match>

        <Match when={req().mode === 'form'}>
          <form
            class="flex flex-col gap-2"
            onSubmit={(e) => { e.preventDefault(); submit() }}
          >
            <For each={fields()}>
              {(f) => (
                <label class="flex flex-col gap-1 min-w-0">
                  <Show
                    when={f.kind === 'boolean'}
                    fallback={
                      <span class="text-[11px] text-text-muted">
                        {f.label}{f.required ? ' *' : ''}
                      </span>
                    }
                  >
                    <span class="flex items-center gap-2 text-xs text-text-primary">
                      <input
                        type="checkbox"
                        checked={values[f.key] === true}
                        onChange={(e) => setValues(f.key, e.currentTarget.checked)}
                      />
                      {f.label}
                    </span>
                  </Show>
                  <Switch>
                    <Match when={f.kind === 'enum'}>
                      <select
                        class={inputClass}
                        value={String(values[f.key] ?? '')}
                        onChange={(e) => { setValues(f.key, e.currentTarget.value); setError(null) }}
                      >
                        <option value="">Select…</option>
                        <For each={f.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
                      </select>
                    </Match>
                    <Match when={f.kind !== 'boolean'}>
                      <input
                        class={inputClass}
                        type={f.kind === 'string' ? 'text' : 'number'}
                        step={f.kind === 'integer' ? '1' : 'any'}
                        value={String(values[f.key] ?? '')}
                        onInput={(e) => { setValues(f.key, e.currentTarget.value); setError(null) }}
                      />
                    </Match>
                  </Switch>
                  <Show when={f.description}>
                    <span class="text-[10px] text-text-dim">{f.description}</span>
                  </Show>
                </label>
              )}
            </For>
            <Show when={error()}>
              <div class="text-[11px] text-status-error">{error()}</div>
            </Show>
            <div class="flex gap-2">
              <button
                type="submit"
                class="flex-1 py-1.5 rounded-lg bg-status-running/15 text-status-running text-xs font-medium hover:bg-status-running/25 transition-colors"
              >
                Submit
              </button>
              <button
                type="button"
                class="flex-1 py-1.5 rounded-lg bg-status-error/15 text-status-error text-xs font-medium hover:bg-status-error/25 transition-colors"
                onClick={() => props.onRespond('decline')}
              >
                Decline
              </button>
            </div>
          </form>
        </Match>
      </Switch>
    </div>
  )
}
