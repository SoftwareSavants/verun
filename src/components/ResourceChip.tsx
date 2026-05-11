import { Component, Show } from 'solid-js'
import { resourceSample } from '../store/resource-monitor'
import { formatBytes, formatPct } from '../lib/format'

interface Props {
  onClick: () => void
}

export const ResourceChip: Component<Props> = (props) => {
  return (
    <button
      data-testid="resource-chip"
      onClick={() => props.onClick()}
      title="Activity"
      class="px-2 py-1 rounded-md text-xs tabular-nums text-text-dim hover:text-text-secondary hover:bg-surface-3 ring-1 ring-white/8 transition-colors"
    >
      <Show
        when={resourceSample()}
        fallback={<span>RAM -</span>}
      >
        {(s) => (
          <span>
            RAM {formatBytes(s().total.rssBytes)} <span class="opacity-60">·</span> {formatPct(s().total.cpuPct)}
          </span>
        )}
      </Show>
    </button>
  )
}
