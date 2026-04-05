import { Component, Show, For, lazy, createEffect, on, createSignal, onCleanup } from 'solid-js'
import { selectedTaskId, selectedSessionId, setSelectedSessionId } from '../store/ui'
import { taskById } from '../store/tasks'
import { sessionsForTask, outputLines, startSession, stopSession, resumeSession, loadSessions, loadOutputLines } from '../store/sessions'
import { MergeBar } from './MergeBar'
import { Square, Plus, FolderOpen, Play, Terminal as TerminalIcon } from 'lucide-solid'
import { clsx } from 'clsx'
import * as ipc from '../lib/ipc'
import type { Session } from '../types'

const Terminal = lazy(() => import('./Terminal').then(m => ({ default: m.Terminal })))

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  if (mins < 60) return `${mins}m ${remSecs}s`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hours}h ${remMins}m`
}

function SessionTime(props: { session: Session }) {
  const [now, setNow] = createSignal(Date.now())

  const interval = props.session.status === 'running'
    ? setInterval(() => setNow(Date.now()), 1000)
    : undefined

  onCleanup(() => { if (interval) clearInterval(interval) })

  const elapsed = () => {
    const end = props.session.endedAt || now()
    return formatDuration(end - props.session.startedAt)
  }

  return <span class="text-gray-500">{elapsed()}</span>
}

export const TaskPanel: Component = () => {
  createEffect(on(selectedTaskId, async (taskId) => {
    if (taskId) {
      await loadSessions(taskId)
      const taskSessions = sessionsForTask(taskId)
      if (taskSessions.length > 0) {
        setSelectedSessionId(taskSessions[0].id)
      } else {
        setSelectedSessionId(null)
      }
    }
  }))

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

  const handleResume = async (sessionId: string) => {
    const session = await resumeSession(sessionId)
    setSelectedSessionId(session.id)
  }

  const openInTerminal = (path: string) => {
    // Opens a new Terminal.app window at the given path
    ipc.openInFinder(path)
  }

  return (
    <div class="flex-1 h-full flex flex-col bg-surface-0">
      <Show
        when={task()}
        fallback={
          <div class="flex-1 flex items-center justify-center text-gray-500">
            <div class="text-center">
              <p class="text-lg mb-1">No task selected</p>
              <p class="text-sm">Select a task from the sidebar or create a new one</p>
            </div>
          </div>
        }
      >
        {(t) => (
          <>
            {/* Header */}
            <div class="px-4 py-2 border-b border-border flex items-center justify-between bg-surface-1">
              <div class="min-w-0">
                <h2 class="text-sm font-semibold text-gray-200 truncate">
                  {t().name || t().branch}
                </h2>
                <span class="text-xs text-gray-500 truncate block">{t().worktreePath}</span>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button
                  class="btn-ghost p-1.5 rounded"
                  onClick={() => openInTerminal(t().worktreePath)}
                  title="Open in Terminal"
                >
                  <TerminalIcon size={14} />
                </button>
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
            <div class="flex items-center border-b border-border bg-surface-1 px-2 gap-0.5 overflow-x-auto">
              <For each={taskSessions()}>
                {(session) => (
                  <button
                    class={clsx(
                      'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors whitespace-nowrap',
                      selectedSessionId() === session.id
                        ? 'text-gray-200 border-b-2 border-accent'
                        : 'text-gray-500 hover:text-gray-300'
                    )}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <span>{session.name || `Session ${session.id.slice(0, 6)}`}</span>
                    <SessionTime session={session} />

                    {/* Inline actions */}
                    <Show when={session.status === 'running'}>
                      <button
                        class="ml-1 text-status-error hover:text-red-400"
                        onClick={(e) => { e.stopPropagation(); stopSession(session.id) }}
                        title="Stop"
                      >
                        <Square size={10} />
                      </button>
                    </Show>
                    <Show when={session.status === 'idle' && session.claudeSessionId}>
                      <button
                        class="ml-1 text-status-running hover:text-green-400"
                        onClick={(e) => { e.stopPropagation(); handleResume(session.id) }}
                        title="Resume"
                      >
                        <Play size={10} />
                      </button>
                    </Show>
                  </button>
                )}
              </For>
              <button
                class="btn-ghost p-1 rounded ml-1"
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
