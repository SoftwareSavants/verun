import { Component, Show, createSignal } from 'solid-js'
import { clsx } from 'clsx'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-solid'
import { CodeChanges } from './CodeChanges'
import { FilesPanel } from './FilesPanel'
import { ProblemsPanel } from './ProblemsPanel'
import { rightPanelTab, setRightPanelTab } from '../store/files'
import { problemCountForTask, isProblemsLoading } from '../store/problems'
import { problemsHeight, setProblemsHeightAndPersist } from '../store/ui'
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
  const [problemsOpen, setProblemsOpen] = createSignal(
    localStorage.getItem('verun:problemsOpen') !== 'false'
  )
  const toggleProblems = () => {
    const next = !problemsOpen()
    setProblemsOpen(next)
    localStorage.setItem('verun:problemsOpen', String(next))
  }

  const counts = () => problemCountForTask(props.taskId)

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

      {/* Resize handle */}
      <Show when={problemsOpen()}>
        <div
          class="h-1 cursor-row-resize bg-border-subtle hover:bg-accent/50 transition-colors shrink-0"
          onMouseDown={(e) => {
            e.preventDefault()
            const startY = e.clientY
            const startH = problemsHeight()
            const onMove = (ev: MouseEvent) => {
              const delta = startY - ev.clientY
              setProblemsHeightAndPersist(Math.max(60, Math.min(400, startH + delta)))
            }
            const onUp = () => {
              document.removeEventListener('mousemove', onMove)
              document.removeEventListener('mouseup', onUp)
            }
            document.addEventListener('mousemove', onMove)
            document.addEventListener('mouseup', onUp)
          }}
        />
      </Show>

      {/* Problems — collapsible bottom section */}
      <div class="shrink-0 border-t border-border-subtle">
        <button
          class="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-text-dim hover:text-text-muted transition-colors"
          onClick={toggleProblems}
        >
          {problemsOpen()
            ? <ChevronDown size={10} class="shrink-0" />
            : <ChevronRight size={10} class="shrink-0" />}
          <span class="font-medium">Problems</span>
          <Show when={isProblemsLoading(props.taskId)}>
            <Loader2 size={10} class="animate-spin text-text-dim/50 shrink-0" />
          </Show>
          <Show when={!isProblemsLoading(props.taskId) && counts().errors > 0}>
            <span class="text-status-error">{counts().errors}</span>
          </Show>
          <Show when={!isProblemsLoading(props.taskId) && counts().warnings > 0}>
            <span class="text-text-dim">{counts().warnings}</span>
          </Show>
        </button>
        <Show when={problemsOpen()}>
          <div
            style={{ height: `${problemsHeight()}px` }}
            class="overflow-hidden"
          >
            <ProblemsPanel taskId={props.taskId} />
          </div>
        </Show>
      </div>
    </div>
  )
}
