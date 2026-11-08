import { createSignal, type Component } from 'solid-js'
import { Check, Coffee } from 'lucide-solid'
import { clsx } from 'clsx'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { KEEP_AWAKE_DURATIONS, keepAwakeSummary } from '../lib/keepAwake'
import { keepAwakeAuto, keepAwakeStatus, setKeepAwakeAuto } from '../store/keepAwake'
import * as ipc from '../lib/ipc'

/** Caffeine control: auto while agents work, or screen on for a chosen time. */
export const KeepAwakeButton: Component = () => {
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null)
  const status = keepAwakeStatus
  const manualOn = () => status().manualForever || status().manualUntil !== null
  const summary = () => keepAwakeSummary(status(), keepAwakeAuto())
  const report = (e: unknown) => console.error('keep awake:', e)

  const items = (): ContextMenuItem[] => [
    { label: 'Keep awake while agents work', icon: keepAwakeAuto() ? Check : undefined, action: () => setKeepAwakeAuto(!keepAwakeAuto()) },
    { separator: true },
    { heading: 'Keep screen on for' },
    ...KEEP_AWAKE_DURATIONS.map(d => ({
      label: d.label,
      action: () => { ipc.keepAwakeSetManual(d.minutes).catch(report) },
    })),
    ...(manualOn() ? [{ separator: true } as const, { label: 'Turn off', action: () => { ipc.keepAwakeClearManual().catch(report) } }] : []),
  ]

  return <>
    <button
      type="button"
      class={clsx(
        'p-1.5 rounded-md transition-colors',
        status().keepsScreenOn ? 'text-accent bg-accent-muted'
          : status().active ? 'text-accent hover:bg-surface-3'
          : 'text-text-dim hover:text-text-secondary hover:bg-surface-3',
      )}
      aria-pressed={manualOn()}
      aria-label={`${summary()}. Keep awake options`}
      title={summary()}
      onClick={e => {
        const r = e.currentTarget.getBoundingClientRect()
        setMenu({ x: r.left, y: r.top - 6 })
      }}
    >
      <Coffee size={14} />
    </button>
    <ContextMenu open={!!menu()} pos={menu() ?? undefined} items={items()} placement="above" onClose={() => setMenu(null)} minWidth="min-w-52" />
  </>
}
