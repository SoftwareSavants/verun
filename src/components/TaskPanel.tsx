import { Component, Show, For, lazy, createEffect, on } from 'solid-js'
import { selectedTaskId, selectedSessionId, setSelectedSessionId } from '../store/ui'
import { taskById } from '../store/tasks'
import { sessionsForTask, outputLines, startSession, stopSession, loadSessions, loadOutputLines } from '../store/sessions'
import { MergeBar } from './MergeBar'
import { Square, Plus, FolderOpen } from 'lucide-solid'
import { clsx } from 'clsx'
import * as ipc from '../lib/ipc'

const Terminal = lazy(() => import('./Terminal').then(m => ({ default: m.Terminal })))

export const TaskPanel: Component = () => {
  // Load sessions when selected task changes
  createEffect(on(selectedTaskId, async (taskId) => {
    if (taskId) {
      await loadSessions(taskId)
      // Auto-select the first session
      const taskSessions = sessionsForTask(taskId)
      if (taskSessions.length > 0) {
        setSelectedSessionId(taskSessions[0].id)
      } else {
        setSelectedSessionId(null)
      }
    }
  }))

  // Load output lines when selected session changes
  createEffect(on(selectedSessionId, async (sessionId) => {
    if (sessionId) {
      await loadOutputLines(sessionId)
    }
  }))

  const task = () => {
    const id = selectedTaskId()
    return id ? taskById(id) : undefined
  }

  const taskSessions = () => {
    const id = selectedTaskId()
    return id ? sessionsForTask(id) : []
  }

  const currentOutput = () => {
    const sid = selectedSessionId()
    return sid ? (outputLines[sid] || []) : []
  }

  const handleNewSession = async () => {
    const tid = selectedTaskId()
    if (!tid) return
    const session = await startSession(tid)
    setSelectedSessionId(session.id)
  }

  const handleStopSession = async (sessionId: string) => {
    await stopSession(sessionId)
  }

  return (
    <div class="flex-1 h-full flex flex-col bg-surface-0">
      <Show
        when={task()}
        fallback={
          <div class="flex-1 flex items-center justify-center text-gray-500">
            Select a task or create a new one
          </div>
        }
      >
        {(t) => (
          <>
            {/* Header */}
            <div class="px-4 py-2 border-b border-border flex items-center justify-between bg-surface-1">
              <div>
                <h2 class="text-sm font-semibold text-gray-200">
                  {t().name || t().branch}
                </h2>
                <span class="text-xs text-gray-500">{t().worktreePath}</span>
              </div>
              <div class="flex items-center gap-1">
                <button
                  class="btn-ghost p-1.5 rounded"
                  onClick={() => ipc.openInFinder(t().worktreePath)}
                  title="Open in Finder"
                >
                  <FolderOpen size={14} />
                </button>
              </div>
            </div>

            {/* Session tabs */}
            <div class="flex items-center border-b border-border bg-surface-1 px-2 gap-1 overflow-x-auto">
              <For each={taskSessions()}>
                {(session) => (
                  <button
                    class={clsx(
                      'px-3 py-1.5 text-xs transition-colors whitespace-nowrap',
                      selectedSessionId() === session.id
                        ? 'text-gray-200 border-b-2 border-accent'
                        : 'text-gray-500 hover:text-gray-300'
                    )}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    {session.name || `Session ${session.id.slice(0, 6)}`}
                    <Show when={session.status === 'running'}>
                      <button
                        class="ml-1.5 text-status-error hover:text-red-400"
                        onClick={(e) => { e.stopPropagation(); handleStopSession(session.id) }}
                        title="Stop"
                      >
                        <Square size={10} />
                      </button>
                    </Show>
                  </button>
                )}
              </For>
              <button
                class="btn-ghost p-1 rounded"
                onClick={handleNewSession}
                title="New Session"
              >
                <Plus size={14} />
              </button>
            </div>

            {/* Terminal */}
            <div class="flex-1 overflow-hidden p-1">
              <Terminal output={currentOutput()} />
            </div>

            {/* Merge bar when latest session is done */}
            <Show when={taskSessions().length > 0 && taskSessions()[0].status === 'done'}>
              <MergeBar
                taskId={t().id}
                branch={t().branch}
                onMerge={(target) => ipc.mergeBranch(t().id, target)}
              />
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
