import { Component, Show, For, createEffect, on, createSignal, onCleanup } from 'solid-js'
import { selectedTaskId, selectedSessionId, setSelectedSessionId, setShowAddProjectDialog } from '../store/ui'
import { projects } from '../store/projects'
import { taskById } from '../store/tasks'
import { sessionsForTask, outputItems, sessionById, createSession, abortMessage, closeSession, loadSessions, loadOutputLines } from '../store/sessions'
import { MessageInput } from './MessageInput'
import { ChatView } from './ChatView'
import { CodeChanges } from './CodeChanges'
import { Square, Plus, X, PanelRightClose, PanelRightOpen } from 'lucide-solid'
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

  const [creatingSession, setCreatingSession] = createSignal(false)
  const handleNewSession = async () => {
    const tid = selectedTaskId()
    if (!tid || creatingSession()) return
    setCreatingSession(true)
    try {
      const session = await createSession(tid)
      setSelectedSessionId(session.id)
    } finally {
      setCreatingSession(false)
    }
  }

  const currentSession = () => {
    const sid = selectedSessionId()
    return sid ? sessionById(sid) : undefined
  }

  const [showChanges, setShowChanges] = createSignal(
    localStorage.getItem('verun:showChanges') !== 'false'
  )
  const toggleChanges = () => {
    const next = !showChanges()
    setShowChanges(next)
    localStorage.setItem('verun:showChanges', String(next))
  }

  return (
    <div class="flex-1 h-full flex bg-surface-0">
      <Show
        when={task()}
        fallback={
          <div class="flex-1 flex items-center justify-center drag-region">
            <div class="text-center max-w-xs no-drag">
              <div class="flex items-center justify-center gap-3 mb-5 text-text-dim">
                <div class="flex flex-col items-center gap-1">
                  <div class="w-8 h-8 rounded-lg bg-surface-2 flex items-center justify-center text-xs font-medium text-text-muted">1</div>
                  <span class="text-[10px]">Project</span>
                </div>
                <span class="text-text-dim/40 mt-[-14px]">&rarr;</span>
                <div class="flex flex-col items-center gap-1">
                  <div class="w-8 h-8 rounded-lg bg-surface-2 flex items-center justify-center text-xs font-medium text-text-muted">2</div>
                  <span class="text-[10px]">Task</span>
                </div>
                <span class="text-text-dim/40 mt-[-14px]">&rarr;</span>
                <div class="flex flex-col items-center gap-1">
                  <div class="w-8 h-8 rounded-lg bg-surface-2 flex items-center justify-center text-xs font-medium text-text-muted">3</div>
                  <span class="text-[10px]">Session</span>
                </div>
              </div>
              <Show
                when={projects.length > 0}
                fallback={
                  <>
                    <p class="text-sm text-text-secondary mb-1">Add a project to get started</p>
                    <p class="text-xs text-text-dim leading-relaxed mb-4">
                      Point Verun at a git repo, then create tasks to spin up parallel worktrees.
                    </p>
                    <button
                      class="btn-primary text-xs"
                      onClick={() => setShowAddProjectDialog(true)}
                    >
                      Add Project <kbd class="ml-1.5 px-1 py-0.5 rounded bg-white/10 text-[10px] font-mono">{'\u2318'}O</kbd>
                    </button>
                  </>
                }
              >
                <p class="text-sm text-text-secondary mb-1">Pick a task to get started</p>
                <p class="text-xs text-text-dim leading-relaxed">
                  Select a task from the sidebar, or press <kbd class="px-1 py-0.5 rounded bg-surface-3 text-text-muted text-[10px] font-mono">{'\u2318'}N</kbd> to create one.
                </p>
              </Show>
            </div>
          </div>
        }
      >
        {(t) => (
          <>
            {/* Chat column */}
            <div class="flex flex-col w-0 flex-[3] overflow-hidden">
              {/* Header — drag region for titlebar */}
              <div class="px-4 pt-10 pb-2 flex items-center justify-between bg-surface-0 drag-region">
                <div class="min-w-0 no-drag">
                  <h2 class="text-sm font-semibold text-text-primary truncate">
                    {t().name || 'New task'}
                  </h2>
                  <span
                    class="text-[11px] text-text-dim truncate block mt-0.5 cursor-pointer hover:text-text-muted transition-colors"
                    onClick={() => ipc.openInFinder(t().worktreePath)}
                    title={t().worktreePath}
                  >
                    {t().worktreePath.split('/').pop() || t().worktreePath}
                  </span>
                </div>
                <button
                  class="no-drag p-1 rounded-md text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors"
                  onClick={toggleChanges}
                  title={showChanges() ? 'Hide changes panel' : 'Show changes panel'}
                >
                  {showChanges() ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
                </button>
              </div>

              {/* Session tabs — pill style */}
              <div class="flex items-center px-3 py-1.5 gap-1 overflow-x-auto">
                <For each={taskSessions()}>
                  {(session) => (
                    <div
                      class={clsx(
                        'group flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] transition-all whitespace-nowrap cursor-pointer',
                        selectedSessionId() === session.id
                          ? 'bg-accent-muted text-accent-hover border border-accent/20'
                          : 'text-text-muted hover:text-text-secondary hover:bg-surface-2 border border-transparent'
                      )}
                      onClick={() => setSelectedSessionId(session.id)}
                    >
                      <span>{session.name || 'New session'}</span>
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

                      <Show when={session.status !== 'running'}>
                        <button
                          class="ml-0.5 opacity-0 group-hover:opacity-100 text-text-dim hover:text-text-muted transition-all"
                          onClick={(e) => {
                            e.stopPropagation()
                            const sessions = taskSessions()
                            const idx = sessions.findIndex(s => s.id === session.id)
                            if (selectedSessionId() === session.id) {
                              const next = sessions[idx + 1] || sessions[idx - 1]
                              setSelectedSessionId(next?.id ?? null)
                            }
                            closeSession(session.id)
                          }}
                          title="Close session"
                        >
                          <X size={10} />
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
                <button
                  class="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors disabled:opacity-40"
                  onClick={handleNewSession}
                  disabled={creatingSession()}
                  title="New Session"
                >
                  <Plus size={12} class={creatingSession() ? 'animate-spin' : ''} />
                  <span>{creatingSession() ? '...' : 'New'}</span>
                </button>
              </div>

              {/* Chat */}
              <div class="flex-1 overflow-hidden">
                <ChatView
                  output={currentOutput()}
                  sessionStatus={currentSession()?.status}
                />
              </div>

              <MessageInput
                sessionId={selectedSessionId()}
                isRunning={currentSession()?.status === 'running'}
              />
            </div>

            {/* Source control panel — collapsible */}
            <Show when={showChanges()}>
              <div class="w-0 flex-[2] border-l border-border-subtle overflow-hidden">
                <CodeChanges
                  taskId={t().id}
                  sessionId={selectedSessionId()}
                  isRunning={currentSession()?.status === 'running'}
                />
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
