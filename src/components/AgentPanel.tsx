import { Component, Show, lazy } from 'solid-js'
import { activeAgent } from '../store/agents'
import { getSessionForAgent } from '../store/sessions'
import { MergeBar } from './MergeBar'
import { Square, RotateCcw, FolderOpen } from 'lucide-solid'

const Terminal = lazy(() => import('./Terminal').then(m => ({ default: m.Terminal })))

interface Props {
  onKill: (id: string) => void
  onRestart: (id: string) => void
  onOpenFinder: (path: string) => void
  onMerge: (worktreePath: string, targetBranch: string) => void
}

export const AgentPanel: Component<Props> = (props) => {
  return (
    <div class="flex-1 h-full flex flex-col bg-surface-0">
      <Show
        when={activeAgent()}
        fallback={
          <div class="flex-1 flex items-center justify-center text-gray-500">
            Select an agent or create a new one
          </div>
        }
      >
        {(agent) => {
          const session = () => getSessionForAgent(agent().id)

          return (
            <>
              {/* Header */}
              <div class="px-4 py-2 border-b border-border flex items-center justify-between bg-surface-1">
                <div>
                  <h2 class="text-sm font-semibold text-gray-200">{agent().name}</h2>
                  <span class="text-xs text-gray-500">{agent().branch} — {agent().worktreePath}</span>
                </div>
                <div class="flex items-center gap-1">
                  <button
                    class="btn-ghost p-1.5 rounded"
                    onClick={() => props.onOpenFinder(agent().worktreePath)}
                    title="Open in Finder"
                  >
                    <FolderOpen size={14} />
                  </button>
                  <Show when={agent().status === 'running'}>
                    <button
                      class="btn-ghost p-1.5 rounded text-status-error"
                      onClick={() => props.onKill(agent().id)}
                      title="Stop Agent"
                    >
                      <Square size={14} />
                    </button>
                  </Show>
                  <Show when={agent().status !== 'running'}>
                    <button
                      class="btn-ghost p-1.5 rounded"
                      onClick={() => props.onRestart(agent().id)}
                      title="Restart Agent"
                    >
                      <RotateCcw size={14} />
                    </button>
                  </Show>
                </div>
              </div>

              {/* Terminal */}
              <div class="flex-1 overflow-hidden p-1">
                <Terminal output={session()?.outputLines || []} />
              </div>

              {/* Merge bar when done */}
              <Show when={agent().status === 'done'}>
                <MergeBar
                  worktreePath={agent().worktreePath}
                  branch={agent().branch}
                  onMerge={(target) => props.onMerge(agent().worktreePath, target)}
                />
              </Show>
            </>
          )
        }}
      </Show>
    </div>
  )
}
