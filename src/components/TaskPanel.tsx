import { Component, Show, For, createEffect, on, createSignal, onCleanup } from 'solid-js'
import { selectedTaskId, selectedSessionId, setSelectedSessionId } from '../store/ui'
import { taskById } from '../store/tasks'
import { sessionsForTask, outputItems, sessionById, createSession, abortMessage, loadSessions, loadOutputLines } from '../store/sessions'
import { MergeBar } from './MergeBar'
import { MessageInput } from './MessageInput'
import { ChatView } from './ChatView'
import { Square, Plus, FolderOpen } from 'lucide-solid'
import { clsx } from 'clsx'
import * as ipc from '../lib/ipc'
import type { Session } from '../types'

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

  return <span class="text-text-dim">{elapsed()}</span>
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
    return sid ? (outputItems[sid] || []) : []
  }

  const handleNewSession = async () => {
    const tid = selectedTaskId()
    if (!tid) return
    const session = await createSession(tid)
    setSelectedSessionId(session.id)
  }

  const currentSession = () => {
    const sid = selectedSessionId()
    return sid ? sessionById(sid) : undefined
  }

  return (
    <div class="flex-1 h-full flex flex-col bg-surface-0">
      <Show
        when={task()}
        fallback={
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center">
              <p class="text-base text-text-muted mb-1">No task selected</p>
              <p class="text-sm text-text-dim">Select a task from the sidebar or create a new one</p>
            </div>
          </div>
        }
      >
        {(t) => (
          <>
            {/* Header — drag region for titlebar */}
            <div class="px-4 pt-10 pb-2 flex items-center justify-between bg-surface-0 drag-region">
              <div class="min-w-0 no-drag">
                <h2 class="text-sm font-semibold text-text-primary truncate">
                  {t().name || t().branch}
                </h2>
                <span class="text-[11px] text-text-dim truncate block mt-0.5">{t().worktreePath}</span>
              </div>
              <div class="flex items-center gap-1 shrink-0 no-drag">
                <button
                  class="p-1.5 rounded-md text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
                  onClick={() => ipc.openInFinder(t().worktreePath)}
                  title="Open in Finder"
                >
                  <FolderOpen size={14} />
                </button>
              </div>
            </div>

            {/* Session tabs — pill style */}
            <div class="flex items-center px-3 py-1.5 gap-1 overflow-x-auto">
              <For each={taskSessions()}>
                {(session) => (
                  <button
                    class={clsx(
                      'flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] transition-all whitespace-nowrap',
                      selectedSessionId() === session.id
                        ? 'bg-accent-muted text-accent-hover border border-accent/20'
                        : 'text-text-muted hover:text-text-secondary hover:bg-surface-2 border border-transparent'
                    )}
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <span>{session.name || `Session ${session.id.slice(0, 6)}`}</span>
                    <SessionTime session={session} />

                    <Show when={session.status === 'running'}>
                      <button
                        class="ml-0.5 text-status-error hover:text-red-300 transition-colors"
                        onClick={(e) => { e.stopPropagation(); abortMessage(session.id) }}
                        title="Stop"
                      >
                        <Square size={8} />
                      </button>
                    </Show>
                  </button>
                )}
              </For>
              <button
                class="p-1 rounded-full text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors"
                onClick={handleNewSession}
                title="New Session"
              >
                <Plus size={14} />
              </button>
            </div>

            {/* Chat */}
            <div class="flex-1 overflow-hidden">
              <ChatView
                output={currentOutput()}
                sessionStatus={currentSession()?.status}
              />
            </div>

            {/* Message input */}
            <MessageInput
              sessionId={selectedSessionId()}
              isRunning={currentSession()?.status === 'running'}
            />

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
