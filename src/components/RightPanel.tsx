import { Component, Show } from 'solid-js'
import { clsx } from 'clsx'
import { CodeChanges } from './CodeChanges'
import { FilesPanel } from './FilesPanel'
import { rightPanelTab, setRightPanelTab } from '../store/files'
import { hasOverlayTitlebar } from '../lib/platform'

interface Props {
  taskId: string
  sessionId: string | null
  isRunning?: boolean
}

const TABS = [
  { id: 'changes' as const, label: 'Changes' },
  { id: 'files' as const, label: 'Files' },
]

export const RightPanel: Component<Props> = (props) => {
  return (
    <div class="flex flex-col h-full">
      {/* Tab bar */}
      <div class={`flex items-center gap-0.5 px-3 ${hasOverlayTitlebar ? 'pt-10' : 'pt-2'} pb-1.5 border-b border-border-subtle bg-surface-0 shrink-0 drag-region`} data-tauri-drag-region>
        {TABS.map(tab => (
          <button
            class={clsx(
              'px-3 py-1 text-[11px] font-medium rounded-md transition-colors no-drag',
              rightPanelTab() === tab.id
                ? 'bg-surface-2 text-text-secondary'
                : 'text-text-dim hover:text-text-muted hover:bg-surface-1'
            )}
            onClick={() => setRightPanelTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div class="flex-1 overflow-hidden">
        <Show when={rightPanelTab() === 'changes'}>
          <CodeChanges
            taskId={props.taskId}
            sessionId={props.sessionId}
            isRunning={props.isRunning}
          />
        </Show>
        <Show when={rightPanelTab() === 'files'}>
          <FilesPanel taskId={props.taskId} />
        </Show>
      </div>
    </div>
  )
}
