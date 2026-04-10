import { Component, Show, For, createEffect, on, createSignal, onCleanup } from 'solid-js'
import { selectedTaskId, selectedSessionId, setSelectedSessionId, setSelectedProjectId, addToast, showTerminal, toggleTerminal, terminalHeight, setTerminalHeightAndPersist } from '../store/ui'
import { refitActiveTerminal } from '../store/terminals'
import { projects, addProject, projectById } from '../store/projects'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { taskById, isTaskCreating, getTaskError, retryTaskCreation, removePlaceholderTask } from '../store/tasks'
import { isSetupRunning, setupFailed, setupError } from '../store/setup'
import { sessionsForTask, outputItems, sessionById, createSession, abortMessage, closeSession, loadSessions, loadOutputLines, sessionCosts } from '../store/sessions'
import { MessageInput } from './MessageInput'
import { ChatView } from './ChatView'
import { RightPanel } from './RightPanel'
import { QuickOpen } from './QuickOpen'
import { TerminalPanel } from './TerminalPanel'
import { Square, Plus, X, PanelRightClose, PanelRightOpen, PanelBottomClose, PanelBottomOpen, ChevronDown, Loader2, AlertCircle, RotateCcw, Trash2 } from 'lucide-solid'
import { clsx } from 'clsx'
import * as ipc from '../lib/ipc'
import type { Session } from '../types'
import vscodeIcon from '../assets/icons/vscode.svg?raw'
import cursorIcon from '../assets/icons/cursor.svg?raw'
import zedIcon from '../assets/icons/zed.svg?raw'
import finderIcon from '../assets/icons/finder.svg?raw'
import { fileManagerName, hasOverlayTitlebar } from '../lib/platform'

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

function SvgIcon(props: { svg: string; size?: number }) {
  const s = props.size ?? 12
  const sized = props.svg.replace('<svg ', `<svg width="${s}" height="${s}" `)
  return <span class="inline-flex items-center justify-center shrink-0" innerHTML={sized} />
}

const EDITORS = [
  { label: 'VS Code', app: 'Visual Studio Code', svg: vscodeIcon },
  { label: 'Cursor', app: 'Cursor', svg: cursorIcon },
  { label: 'Zed', app: 'Zed', svg: zedIcon },
  { label: fileManagerName, app: fileManagerName, svg: finderIcon },
]

function OpenInButton(props: { path: string }) {
  const [open, setOpen] = createSignal(false)
  let containerRef: HTMLDivElement | undefined

  const defaultEditor = () => EDITORS[0]

  const handleOpen = (app: string) => {
    if (app === fileManagerName) {
      ipc.openInFinder(props.path)
    } else {
      ipc.openInApp(props.path, app)
    }
    setOpen(false)
  }

  // Close dropdown on outside click
  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false)
    }
  }

  createEffect(() => {
    if (open()) {
      document.addEventListener('mousedown', handleClickOutside)
    } else {
      document.removeEventListener('mousedown', handleClickOutside)
    }
    onCleanup(() => document.removeEventListener('mousedown', handleClickOutside))
  })

  return (
    <div ref={containerRef} class="relative flex items-stretch h-6 border-1 border-solid border-border-active rounded-md">
      <button
        class="flex items-center gap-1.5 px-2.5 text-xs text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors rounded-l-md"
        onClick={() => handleOpen(defaultEditor().app)}
        title={`Open in ${defaultEditor().label}`}
      >
        <SvgIcon svg={defaultEditor().svg} size={13} />
        {defaultEditor().label}
      </button>
      <span class="w-px self-stretch bg-border-active" />
      <button
        class="flex items-center px-2 text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors rounded-r-md"
        onClick={() => setOpen(!open())}
      >
        <ChevronDown size={11} />
      </button>
      <Show when={open()}>
        <div class="absolute right-0 top-full mt-1 bg-surface-1 border border-border-subtle rounded-lg shadow-lg py-1 z-50 min-w-[120px]">
          <For each={EDITORS}>
            {(editor) => (
              <button
                class="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
                onClick={() => handleOpen(editor.app)}
              >
                <SvgIcon svg={editor.svg} size={12} />
                {editor.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
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
      const tid = selectedTaskId()
      await loadOutputLines(sessionId, tid ?? sessionId)
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
          <div class="flex-1 flex items-center justify-center drag-region" data-tauri-drag-region>
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
                      onClick={async () => {
                        const selected = await openDialog({ directory: true, multiple: false })
                        if (!selected) return
                        try {
                          const project = await addProject(selected as string)
                          setSelectedProjectId(project.id)
                          addToast(`Added ${project.name}`, 'success')
                        } catch (e) {
                          addToast(String(e), 'error')
                        }
                      }}
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
        {(t) => {
          const creating = () => isTaskCreating(t().id)
          const error = () => getTaskError(t().id)

          return (
            <>
              {/* Chat column */}
              <div class="flex flex-col w-0 flex-[3] overflow-hidden">
                {/* Header — drag region for titlebar */}
                <div class={`px-4 ${hasOverlayTitlebar ? 'pt-10' : 'pt-2'} pb-2 flex items-center justify-between bg-surface-0 drag-region`} data-tauri-drag-region>
                  <h2 class="text-sm font-semibold text-text-primary truncate min-w-0 no-drag">
                    {t().name || 'New task'}
                  </h2>
                  <Show when={!creating() && !error()}>
                    <div class="flex items-center gap-1 no-drag shrink-0">
                      <OpenInButton path={t().worktreePath} />
                      <button
                        class="h-6 w-6 flex items-center justify-center rounded-md text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors"
                        onClick={toggleTerminal}
                        title={showTerminal() ? 'Hide terminal' : 'Show terminal'}
                      >
                        {showTerminal() ? <PanelBottomClose size={14} /> : <PanelBottomOpen size={14} />}
                      </button>
                      <button
                        class="h-6 w-6 flex items-center justify-center rounded-md text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors"
                        onClick={toggleChanges}
                        title={showChanges() ? 'Hide changes panel' : 'Show changes panel'}
                      >
                        {showChanges() ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
                      </button>
                    </div>
                  </Show>
                </div>

                {/* Creating state */}
                <Show when={creating()}>
                  <div class="flex-1 flex items-center justify-center">
                    <div class="text-center">
                      <Loader2 size={24} class="animate-spin text-accent mx-auto mb-3" />
                      <p class="text-sm text-text-secondary mb-1">Setting up worktree…</p>
                      <p class="text-xs text-text-dim">Fetching latest and creating branch</p>
                    </div>
                  </div>
                </Show>

                {/* Error state */}
                <Show when={error()}>
                  <div class="flex-1 flex items-center justify-center">
                    <div class="text-center max-w-sm">
                      <AlertCircle size={24} class="text-status-error mx-auto mb-3" />
                      <p class="text-sm text-text-secondary mb-2">Task setup failed</p>
                      <p class="text-xs text-status-error/80 bg-status-error/5 border border-status-error/10 rounded-lg px-3 py-2 mb-4 text-left">
                        {error()}
                      </p>
                      <div class="flex items-center justify-center gap-2">
                        <button
                          class="btn-ghost text-xs flex items-center gap-1.5"
                          onClick={() => removePlaceholderTask(t().id)}
                        >
                          <Trash2 size={12} />
                          Delete
                        </button>
                        <button
                          class="btn-primary text-xs flex items-center gap-1.5"
                          onClick={() => retryTaskCreation(t().id, t().projectId, projectById(t().projectId)?.baseBranch ?? 'main')}
                        >
                          <RotateCcw size={12} />
                          Retry
                        </button>
                      </div>
                    </div>
                  </div>
                </Show>

                {/* Normal task UI */}
                <Show when={!creating() && !error()}>
                  {/* Setup hook progress banner */}
                  <Show when={isSetupRunning(t().id)}>
                    <div class="flex items-center gap-2 px-4 py-2 bg-accent-muted/30 border-b border-accent/10 text-xs text-text-secondary">
                      <Loader2 size={12} class="animate-spin text-accent shrink-0" />
                      <span>Running setup hook…</span>
                    </div>
                  </Show>
                  <Show when={setupFailed(t().id)}>
                    <div class="flex items-center gap-2 px-4 py-2 bg-status-error/10 border-b border-status-error/10 text-xs text-status-error/80">
                      <AlertCircle size={12} class="shrink-0" />
                      <span>Setup hook failed{setupError(t().id) ? `: ${setupError(t().id)}` : ''}</span>
                    </div>
                  </Show>

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
                          <Show when={sessionCosts[session.id] > 0}>
                            <span class="text-text-dim">${sessionCosts[session.id] < 1 ? sessionCosts[session.id].toFixed(3) : sessionCosts[session.id].toFixed(2)}</span>
                          </Show>

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

                  {/* Terminal panel — resizable bottom section, kept in DOM to preserve xterm state */}
                  <div
                    class="h-1 cursor-row-resize bg-border-subtle hover:bg-accent/50 transition-colors shrink-0"
                    style={{ display: showTerminal() ? 'block' : 'none' }}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      const startY = e.clientY
                      const startH = terminalHeight()
                      const onMove = (ev: MouseEvent) => {
                        const delta = startY - ev.clientY
                        setTerminalHeightAndPersist(Math.max(100, Math.min(600, startH + delta)))
                      }
                      const onUp = () => {
                        document.removeEventListener('mousemove', onMove)
                        document.removeEventListener('mouseup', onUp)
                        // Refit after resize completes
                        const tid = selectedTaskId()
                        if (tid) refitActiveTerminal(tid)
                      }
                      document.addEventListener('mousemove', onMove)
                      document.addEventListener('mouseup', onUp)
                    }}
                  />
                  <div
                    style={{ height: `${terminalHeight()}px`, display: showTerminal() ? 'block' : 'none' }}
                    class="shrink-0 overflow-hidden"
                  >
                    <TerminalPanel taskId={t().id} startCommand={projectById(t().projectId)?.startCommand} />
                  </div>
                </Show>
              </div>

              {/* Right panel — collapsible, contains Changes + Files tabs */}
              <Show when={showChanges() && !creating() && !error()}>
                <div class="w-0 flex-[2] border-l border-border-subtle overflow-hidden">
                  <RightPanel
                    taskId={t().id}
                    sessionId={selectedSessionId()}
                    isRunning={currentSession()?.status === 'running'}
                  />
                </div>
              </Show>
            </>
          )
        }}
      </Show>
      <QuickOpen />
    </div>
  )
}
