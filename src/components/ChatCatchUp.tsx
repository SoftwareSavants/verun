import { Component, For, Show } from 'solid-js'
import { clsx } from 'clsx'
import { ArrowUp, X } from 'lucide-solid'
import type { TurnStart, UnseenAnchor } from '../lib/chatCatchUp'
import { formatClock } from '../lib/format'

const turnsLabel = (n: number) => `${n} turn${n === 1 ? '' : 's'}`

/** Line above the first turn that finished since you last looked. */
export const UnseenDivider: Component<{ anchor: UnseenAnchor; now?: number }> = (props) => (
  <div data-unseen-divider class="flex items-center gap-3 px-5 py-1.5 scroll-mt-3" role="separator" aria-label="New since you last looked">
    <div class="h-px flex-1 bg-accent/35" />
    <span class="text-[11px] whitespace-nowrap">
      <span class="font-semibold text-accent">New</span>
      <span class="text-text-muted"> · {turnsLabel(props.anchor.turns)} since {formatClock(props.anchor.since, props.now)}</span>
    </span>
    <div class="h-px flex-1 bg-accent/35" />
  </div>
)

/** Floating jump back to the divider once it has scrolled out of view above. */
export const UnseenJump: Component<{ anchor: UnseenAnchor; onClick: () => void }> = (props) => (
  <button
    class="h-7 px-3 flex items-center gap-1.5 rounded-full bg-surface-2 ring-1 ring-accent/30 shadow-lg text-[11px] text-accent hover:bg-surface-3 transition-colors"
    onClick={() => props.onClick()}
  >
    <ArrowUp size={12} />
    {turnsLabel(props.anchor.turns)} new
  </button>
)

/**
 * Outline of a long session on the chat's right edge: a tick per prompt,
 * expanding on hover or focus into the list of prompts to jump between.
 */
export const TurnOutline: Component<{
  turns: TurnStart[]
  /** Block index of the turn in view. */
  active: number
  /** Turns starting at or after this block index are new since the last look. */
  newFrom?: number
  onJump: (index: number) => void
}> = (props) => {
  const isNew = (t: TurnStart) => props.newFrom !== undefined && t.index + 1 >= props.newFrom
  return (
    <Show when={props.turns.length >= 3}>
      <nav aria-label="Turns" class="group absolute right-0 top-1/2 -translate-y-1/2 z-20 flex items-center pl-2 pr-1.5">
        <div
          class={clsx(
            'absolute right-full mr-0.5 w-[22rem] max-h-[60vh] overflow-y-auto p-1 rounded-lg bg-surface-2 ring-1 ring-outline/10 shadow-xl',
            'opacity-0 translate-x-1 pointer-events-none transition-[opacity,transform] duration-150 ease-out',
            'group-hover:opacity-100 group-hover:translate-x-0 group-hover:pointer-events-auto',
            'group-focus-within:opacity-100 group-focus-within:translate-x-0 group-focus-within:pointer-events-auto',
          )}
        >
          <For each={props.turns}>
            {(t, i) => (<>
              <Show when={isNew(t) && (i() === 0 || !isNew(props.turns[i() - 1]))}>
                <div class="flex items-center gap-2 px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-accent">
                  New<span class="h-px flex-1 bg-accent/30" />
                </div>
              </Show>
              <button
                class={clsx(
                  'w-full flex items-center gap-2 px-2 py-1 rounded-md text-left text-xs transition-colors',
                  t.index === props.active ? 'bg-surface-3 text-text-primary' : 'text-text-secondary hover:bg-surface-3/70',
                )}
                aria-label={`Turn ${i() + 1}: ${t.text}${t.failed ? ' (failed)' : ''}`}
                aria-current={t.index === props.active ? 'true' : undefined}
                data-new={isNew(t) ? '' : undefined}
                onClick={() => props.onJump(t.index)}
              >
                <span class={clsx('w-1.5 h-1.5 rounded-full shrink-0', isNew(t) ? 'bg-accent' : 'bg-transparent')} />
                <span class="flex-1 truncate">{t.text.split('\n')[0]}</span>
                <Show when={t.failed}>
                  <span class="flex items-center gap-0.5 text-[10px] text-status-error shrink-0"><X size={10} />failed</span>
                </Show>
                <Show when={t.at}>
                  {(ts) => <span class="text-[10px] text-text-dim tabular-nums shrink-0">{formatClock(ts())}</span>}
                </Show>
              </button>
            </>)}
          </For>
        </div>
        <div class="flex flex-col items-end gap-1 py-2 max-h-[60vh] overflow-hidden" aria-hidden="true">
          <For each={props.turns}>
            {(t) => (
              <span
                class={clsx(
                  'h-[2px] rounded-full transition-[width,background-color] duration-150',
                  t.index === props.active ? 'w-4 bg-text-primary' : 'w-2.5 group-hover:w-3',
                  t.index !== props.active && (t.failed ? 'bg-status-error/80' : isNew(t) ? 'bg-accent' : 'bg-text-muted/50'),
                )}
              />
            )}
          </For>
        </div>
      </nav>
    </Show>
  )
}
