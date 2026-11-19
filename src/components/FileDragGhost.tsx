import { Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { fileDrag } from '../store/fileDrag'
import { getFileIcon } from '../lib/fileIcons'

const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

/** What a file tree drag carries, following the pointer. */
export function FileDragGhost() {
  return (
    <Show when={fileDrag()}>
      {d => {
        const name = () => baseName(d().paths[0])
        const Icon = () => getFileIcon(name())
        return (
          <Portal>
            <div
              data-file-drag-ghost
              class="fixed left-0 top-0 z-[1000] pointer-events-none flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-2 ring-1 ring-outline/15 shadow-lg text-[12px] text-text-primary"
              style={{ transform: `translate(${d().x + 12}px, ${d().y + 12}px)` }}
            >
              {(() => { const I = Icon(); return <I size={12} class="shrink-0" /> })()}
              <span class="max-w-60 truncate">{name()}</span>
              <Show when={d().paths.length > 1}><span class="text-text-dim">+{d().paths.length - 1}</span></Show>
            </div>
          </Portal>
        )
      }}
    </Show>
  )
}
