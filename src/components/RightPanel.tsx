import { Component, Show, createSignal } from 'solid-js'
import { clsx } from 'clsx'
import { ChevronDown, ChevronRight, Loader2, AlertCircle, Files, Search, GitBranch } from 'lucide-solid'
import { CodeChanges } from './CodeChanges'
import { FilesPanel } from './FilesPanel'
import { GlobalSearchPanel } from './GlobalSearchPanel'
import { ProblemsPanel } from './ProblemsPanel'
import { rightPanelTab, setRightPanelTab } from '../store/ui'
import { problemCountForTask, isProblemsLoading } from '../store/problems'
import { problemsHeight, setProblemsHeightAndPersist } from '../store/ui'

interface Props {
  taskId: string
}

const TABS = [
  { id: 'files' as const, label: 'Files', icon: Files },
  { id: 'search' as const, label: 'Search', icon: Search },
  { id: 'changes' as const, label: 'Source Control', icon: GitBranch },
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
    <div class="flex flex-col h-full bg-surface-1">
      {/* Tab bar — icon-only (Cursor/VS Code style) */}
      <div class="flex items-center gap-0.5 px-2 pt-10 pb-1.5 bg-surface-1 shrink-0 drag-region" data-tauri-drag-region>
        {TABS.map(tab => (
          <button
            class={clsx(
              'h-7 w-7 flex items-center justify-center rounded-md transition-colors no-drag',
              rightPanelTab() === tab.id
                ? 'bg-surface-3 text-text-secondary'
                : 'text-text-dim hover:text-text-muted hover:bg-surface-2'
            )}
            onClick={() => setRightPanelTab(tab.id)}
            title={tab.label}
          >
            {(() => { const I = tab.icon; return <I size={15} /> })()}
          </button>
        ))}
      </div>

      {/* Content */}
      <div class="flex-1 overflow-hidden">
        <Show when={rightPanelTab() === 'changes'}>
          <CodeChanges taskId={props.taskId} />
        </Show>
        <Show when={rightPanelTab() === 'files'}>
          <FilesPanel taskId={props.taskId} />
        </Show>
        <Show when={rightPanelTab() === 'search'}>
          <GlobalSearchPanel taskId={props.taskId} />
        </Show>
      </div>

      {/* Resize handle — always visible as a thin border, draggable when open */}
      <div
        class={`h-px bg-outline/8 shrink-0 ${problemsOpen() ? 'cursor-row-resize hover:bg-accent/50' : ''}`}
        onMouseDown={problemsOpen() ? (e: MouseEvent) => {
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
        } : undefined}
      />

      {/* Problems — collapsible bottom section (matches Branch Commits bar) */}
      <div class="shrink-0">
        <button
          class="w-full h-8 flex items-center gap-1.5 px-3 text-xs hover:bg-surface-2 transition-colors"
          onClick={toggleProblems}
        >
          {problemsOpen()
            ? <ChevronDown size={12} class="text-text-dim shrink-0" />
            : <ChevronRight size={12} class="text-text-dim shrink-0" />}
          <Show when={isProblemsLoading(props.taskId)} fallback={
            <AlertCircle size={12} class="text-text-dim shrink-0" />
          }>
            <Loader2 size={12} class="animate-spin text-text-dim shrink-0" />
          </Show>
          <span class="font-medium text-text-secondary">Problems</span>
          <Show when={!isProblemsLoading(props.taskId) && (counts().errors > 0 || counts().warnings > 0)}>
            <span class="px-1.5 py-0.5 rounded bg-surface-3 text-text-dim text-[10px] leading-none">
              {counts().errors + counts().warnings}
            </span>
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
