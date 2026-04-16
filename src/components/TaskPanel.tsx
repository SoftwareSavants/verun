import { Component, Show, For, createEffect, on, createSignal, onCleanup } from 'solid-js'
import { selectedTaskId, selectedSessionId, setSelectedSessionId, setSelectedProjectId, addToast, showTerminal, setShowTerminal, setShowSettings, toggleTerminal, terminalHeight, setTerminalHeightAndPersist, isSessionUnread, clearSessionUnread, rightPanelWidth, setRightPanelWidth, consumePendingSessionNav, getLastSessionForTask } from '../store/ui'
import { refitActiveTerminal, setActiveTerminalForTask, startCommandTerminalId, isStartCommandRunning, spawnStartCommand, stopStartCommand } from '../store/terminals'
import { projects, addProject, projectById } from '../store/projects'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { taskById, isTaskCreating, getTaskError, retryTaskCreation, removePlaceholderTask, restoreTask } from '../store/tasks'
import { isSetupRunning, setupFailed, setupError } from '../store/setup'
import { sessionsForTask, outputItems, sessionById, createSession, abortMessage, closeSession, loadSessions, loadOutputLines, sessionCosts } from '../store/sessions'
import { loadSteps } from '../store/steps'
import { StepList } from './StepList'
import { MessageInput } from './MessageInput'
import { ChatView } from './ChatView'
import { RightPanel } from './RightPanel'
import { QuickOpen } from './QuickOpen'
import { FileViewer } from './FileViewer'
import { TerminalPanel } from './TerminalPanel'
import { ConfirmDialog } from './ConfirmDialog'
import { selectSettingsSection } from './SettingsPage'
import { openTabs, mainView, setMainView, setActiveTab, requestCloseTab, forceCloseTab, pendingClose, cancelCloseTab, pinTab, closeOtherTabs, closeAllTabs, revealFileInTree, restoreTabState } from '../store/editorView'
import { Square, X, PanelRightClose, PanelRightOpen, Terminal, ChevronDown, Loader2, AlertCircle, RotateCcw, Trash2, Archive, Play, TerminalSquare, ClipboardCopy, GitCompare } from 'lucide-solid'
import { GitActions, hasGitActionsContent } from './GitActions'
import { NewSessionMenu } from './NewSessionMenu'
import { ContextMenu } from './ContextMenu'
import { getFileIcon } from '../lib/fileIcons'
import { clsx } from 'clsx'
import SvgIcon from './SvgIcon'
import { fileHasErrors, fileHasWarnings } from '../store/problems'
import { getLspClient } from '../lib/lsp'
import * as ipc from '../lib/ipc'
import type { Session } from '../types'
import { AGENT_DISPLAY_NAMES } from '../types'
import { initTaskContext } from '../store/taskContext'
import vscodeIcon from '../assets/icons/vscode.svg?raw'
import cursorIcon from '../assets/icons/cursor.svg?raw'
import { agentIcon } from '../lib/agents'
import zedIcon from '../assets/icons/zed.svg?raw'
import finderIcon from '../assets/icons/finder.svg?raw'
import { fileManagerName } from '../lib/platform'

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
    <div ref={containerRef} class="toolbar-chrome relative flex items-stretch text-text-muted hover:text-text-secondary transition-colors">
      <button
        class="flex items-center px-1.5 hover:bg-surface-2 transition-colors rounded-l-md"
        onClick={() => handleOpen(defaultEditor().app)}
        title={`Open in ${defaultEditor().label}`}
      >
        <SvgIcon svg={defaultEditor().svg} size={14} />
      </button>
      <span class="w-px self-stretch bg-white/8" />
      <button
        class="flex items-center px-1 hover:bg-surface-2 transition-colors rounded-r-md"
        onClick={() => setOpen(!open())}
        title="Choose editor"
      >
        <ChevronDown size={10} />
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
      initTaskContext(taskId)
      restoreTabState(taskId)
      await loadSessions(taskId)
      const pending = consumePendingSessionNav(taskId)
      const taskSessions = sessionsForTask(taskId)
      if (pending && taskSessions.some(s => s.id === pending)) {
        setSelectedSessionId(pending)
      } else {
        const last = getLastSessionForTask(taskId)
        if (last && taskSessions.some(s => s.id === last)) {
          setSelectedSessionId(last)
        } else if (taskSessions.length > 0) {
          setSelectedSessionId(taskSessions[0].id)
        } else {
          setSelectedSessionId(null)
        }
      }
      // Start LSP eagerly so project-wide diagnostics populate the problems
      // panel without waiting for the user to open a file in the editor.
      // Wait until setup is done — node_modules must exist for tsgo to resolve
      // dependencies correctly.
      if (!isSetupRunning(taskId) && !setupFailed(taskId)) {
        const t = taskById(taskId)
        if (t?.worktreePath) {
          getLspClient(taskId, t.worktreePath).catch(() => {})
        }
      }
    }
  }))

  createEffect(on(selectedSessionId, async (sessionId) => {
    if (sessionId) {
      clearSessionUnread(sessionId)
      await loadOutputLines(sessionId)
      await loadSteps(sessionId)
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

  // Scroll active tab into view when it changes
  let tabBarRef: HTMLDivElement | undefined
  createEffect(() => {
    const tid = selectedTaskId()
    if (!tid || !tabBarRef) return
    const view = mainView(tid)
    if (!view || view === 'session') return
    // Find the active tab element by data attribute
    const el = tabBarRef.querySelector(`[data-tab-path="${CSS.escape(view)}"]`) as HTMLElement | null
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  })

  // File tab context menu
  const [tabMenu, setTabMenu] = createSignal<{ x: number; y: number; path: string; taskId: string } | null>(null)
  const closeTabMenu = () => setTabMenu(null)

  const handleNewSession = async (agentType: string, model?: string) => {
    const tid = selectedTaskId()
    if (!tid) return
    const session = await createSession(tid, agentType, model)
    setSelectedSessionId(session.id)
  }

  const currentSession = () => {
    const sid = selectedSessionId()
    return sid ? sessionById(sid) : undefined
  }

  const [showChanges, setShowChanges] = createSignal(
    localStorage.getItem('verun:showChanges') !== 'false'
  )
  const [rightPanelDragging, setRightPanelDragging] = createSignal(false)
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
                      Add Project <kbd class="ml-1.5 px-1 py-0.5 rounded bg-white/8 text-[10px] font-mono">{'\u2318'}O</kbd>
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
              <div class="flex flex-col flex-1 min-w-0 overflow-hidden bg-surface-1">
                {/* Header — drag region for titlebar */}
                <div class="px-4 pt-8 pb-2 flex items-center justify-between bg-surface-1 drag-region" data-tauri-drag-region>
                  <div class="flex items-center gap-2 min-w-0 no-drag">
                    <h2 class="text-[13px] font-medium text-text-primary truncate shrink-0">
                      {t().name || 'New task'}
                    </h2>
                    <button
                      class="text-[11px] text-text-tertiary hover:text-text-secondary truncate min-w-0 transition-colors"
                      title="Click to copy path"
                      onClick={() => {
                        navigator.clipboard.writeText(t().worktreePath)
                        addToast('Path copied to clipboard', 'info')
                      }}
                    >
                      {t().worktreePath.split('/').slice(-2).join('/')}
                    </button>
                  </div>
                  <Show when={!creating() && !error()}>
                    <div class="flex items-center gap-2 no-drag shrink-0">
                      <OpenInButton path={t().worktreePath} />

                      {/* Start command button */}
                      {(() => {
                        const project = () => projectById(t().projectId)
                        const hasStartCommand = () => !!project()?.startCommand
                        const isRunning = () => isStartCommandRunning(t().id)
                        const setupRunning = () => isSetupRunning(t().id)
                        const [showNoStartCmd, setShowNoStartCmd] = createSignal(false)

                        const handleStart = async () => {
                          const cmd = project()?.startCommand
                          if (!cmd) {
                            setShowNoStartCmd(true)
                            return
                          }
                          setShowTerminal(true)
                          await spawnStartCommand(t().id, cmd)
                        }
                        const handleStop = async () => {
                          await stopStartCommand(t().id)
                        }
                        const focusLogs = () => {
                          const tid = startCommandTerminalId(t().id)
                          if (tid) {
                            setActiveTerminalForTask(t().id, tid)
                            setShowTerminal(true)
                            requestAnimationFrame(() => refitActiveTerminal(t().id))
                          }
                        }

                        return (
                          <>
                            <Show
                              when={isRunning()}
                              fallback={
                                <button
                                  class="toolbar-btn gap-1 px-2"
                                  onClick={handleStart}
                                  disabled={setupRunning()}
                                  title={setupRunning() ? 'Waiting for setup hook…' : hasStartCommand() ? `Run: ${project()!.startCommand} (F5)` : 'Set up a start command'}
                                >
                                  <Play size={12} />
                                  <span>Start</span>
                                </button>
                              }
                            >
                              <div class="toolbar-chrome flex items-stretch ring-accent/30 overflow-hidden">
                                <button
                                  class="flex items-center gap-1 px-2 text-[11px] text-accent hover:bg-accent/10 transition-colors"
                                  onClick={handleStop}
                                  title="Stop (F5)"
                                >
                                  <Square size={10} class="fill-current" />
                                  <span>Stop</span>
                                </button>
                                <span class="w-px self-stretch bg-accent/20" />
                                <button
                                  class="flex items-center px-1.5 text-accent/60 hover:text-accent hover:bg-accent/10 transition-colors"
                                  onClick={focusLogs}
                                  title="View start command logs"
                                >
                                  <TerminalSquare size={12} />
                                </button>
                              </div>
                            </Show>

                            {/* No start command dialog */}
                            <ConfirmDialog
                              open={showNoStartCmd()}
                              title="No start command"
                              message="Set up a start command in project settings to auto-run a process (e.g. dev server) for each task."
                              confirmLabel="Go to Settings"
                              onConfirm={() => {
                                setShowNoStartCmd(false)
                                selectSettingsSection(t().projectId)
                                setShowSettings(true)
                              }}
                              onCancel={() => setShowNoStartCmd(false)}
                            />
                          </>
                        )
                      })()}

                      <button
                        class={clsx(
                          'toolbar-btn w-6 justify-center',
                          showTerminal() && 'text-text-secondary bg-surface-2'
                        )}
                        onClick={toggleTerminal}
                        title={showTerminal() ? 'Hide terminal' : 'Show terminal'}
                      >
                        <Terminal size={13} />
                      </button>
                      <Show when={hasGitActionsContent(t().id)}>
                        <span class="w-px h-4 bg-white/8 mx-1" />
                        <GitActions
                          taskId={t().id}
                          sessionId={selectedSessionId()}
                          isRunning={currentSession()?.status === 'running'}
                        />
                        <span class="w-px h-4 bg-white/8 mx-1" />
                      </Show>
                      <button
                        class="toolbar-btn w-6 justify-center"
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
                  {/* Setup hook progress banner — thin status, controls are in header */}
                  <Show when={isSetupRunning(t().id)}>
                    <div class="flex items-center gap-2 px-4 py-1.5 bg-accent-muted/30 border-b border-accent/10 text-xs text-text-secondary">
                      <Loader2 size={11} class="animate-spin text-accent shrink-0" />
                      <span>Running setup hook…</span>
                    </div>
                  </Show>
                  <Show when={setupFailed(t().id)}>
                    <div class="flex items-center gap-2 px-4 py-1.5 bg-status-error/10 border-b border-status-error/10 text-xs text-status-error/80">
                      <AlertCircle size={11} class="shrink-0" />
                      <span>Setup failed{setupError(t().id) ? `: ${setupError(t().id)}` : ''}</span>
                    </div>
                  </Show>

                  {/* Unified tab bar — sessions + open files */}
                  <div ref={tabBarRef} class="relative z-10 flex items-stretch overflow-x-auto scrollbar-hide tab-bar-bg">
                    {/* New session button */}
                    <NewSessionMenu
                      defaultAgent={projectById(t().projectId)?.defaultAgentType}
                      onCreate={(agentType, model) => handleNewSession(agentType, model)}
                    />
                    {/* Session tabs */}
                    <For each={taskSessions()}>
                      {(session) => {
                        const isActive = () => mainView(t().id) === 'session' && selectedSessionId() === session.id
                        const hasUnread = () => isSessionUnread(session.id) && session.status !== 'running'
                        return (
                          <div
                            class={clsx(
                              'group h-8 flex items-center gap-1.5 px-3 text-[11px] rounded-t-md whitespace-nowrap cursor-pointer',
                              isActive()
                                ? 'relative z-10 bg-surface-0 text-text-primary tab-active-frame'
                                : hasUnread()
                                  ? 'text-accent hover:text-accent-hover tab-unread-pulse'
                                  : 'text-text-muted hover:text-text-secondary hover:bg-white/3'
                            )}
                            onClick={() => { setSelectedSessionId(session.id); setMainView(t().id, 'session') }}
                          >
                            <SvgIcon svg={agentIcon(session.agentType)} size={10} />
                            <span>{session.name || AGENT_DISPLAY_NAMES[session.agentType]}</span>
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
                        )
                      }}
                    </For>

                    {/* File tabs */}
                    <For each={openTabs(t().id)}>
                      {(tab) => {
                        const isActive = () => mainView(t().id) === tab.relativePath
                        const isDiff = () => tab.kind === 'diff'
                        const diffSuffix = () => {
                          if (!isDiff() || !tab.diffSource) return ''
                          if (tab.diffSource.type === 'commit') return ` @ ${tab.diffSource.commitHash.slice(0, 7)}`
                          return ' (diff)'
                        }
                        return (
                          <div
                            data-tab-path={tab.relativePath}
                            class={clsx(
                              'group h-8 flex items-center gap-1.5 px-3 text-[11px] rounded-t-md whitespace-nowrap cursor-pointer',
                              isActive()
                                ? 'relative z-10 bg-surface-0 text-text-primary tab-active-frame'
                                : 'text-text-muted hover:text-text-secondary hover:bg-white/3'
                            )}
                            onClick={() => { if (mainView(t().id) === tab.relativePath) return; setActiveTab(t().id, tab.relativePath); if (!isDiff()) revealFileInTree(t().id, tab.relativePath) }}
                            onDblClick={() => pinTab(t().id, tab.relativePath)}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              setTabMenu({ x: e.clientX, y: e.clientY, path: tab.relativePath, taskId: t().id })
                            }}
                          >
                            {(() => {
                              if (isDiff()) return <GitCompare size={10} class="shrink-0" />
                              const I = getFileIcon(tab.name); return <I size={10} class="shrink-0" />
                            })()}
                            <span class={clsx(
                              'truncate max-w-32',
                              tab.preview && 'italic',
                              !isDiff() && fileHasErrors(t().id, tab.relativePath) && 'text-status-error',
                              !isDiff() && !fileHasErrors(t().id, tab.relativePath) && fileHasWarnings(t().id, tab.relativePath) && 'text-yellow-500',
                            )}>
                              {tab.dirty ? '\u2022 ' : ''}{tab.name}{diffSuffix()}
                            </span>
                            <button
                              class={clsx(
                                'ml-0.5 shrink-0 text-text-dim hover:text-text-muted transition-opacity',
                                tab.dirty ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                              )}
                              onClick={(e) => {
                                e.stopPropagation()
                                requestCloseTab(t().id, tab.relativePath)
                              }}
                              title="Close"
                            >
                              <X size={10} />
                            </button>
                          </div>
                        )
                      }}
                    </For>
                  </div>

                  {/* Main content — chat or editor. Side borders extend the active tab's frame. */}
                  <div class="relative -mt-px flex-1 flex flex-col min-h-0 overflow-hidden rounded-t-md bg-surface-0 border-t-1 border-t-solid border-t-white/8 border-l-1 border-l-solid border-l-white/8 border-r-1 border-r-solid border-r-white/8" style="isolation: isolate; clip-path: inset(0 round 4px 4px 0 0);">
                    <Show
                      when={mainView(t().id) !== 'session'}
                      fallback={
                        <>
                          <div class="flex-1 overflow-hidden">
                            <ChatView
                              output={currentOutput()}
                              sessionStatus={currentSession()?.status}
                              sessionError={currentSession()?.error}
                              sessionId={selectedSessionId()}
                              taskId={t().id}
                              agentType={currentSession()?.agentType}
                              model={currentSession()?.model}
                            />
                          </div>
                          <Show
                            when={t().archived}
                            fallback={
                              <>
                                <StepList
                                  sessionId={selectedSessionId()}
                                  isRunning={currentSession()?.status === 'running'}
                                />
                                <MessageInput
                                  sessionId={selectedSessionId()}
                                  isRunning={currentSession()?.status === 'running'}
                                />
                              </>
                            }
                          >
                            <div class="px-4 py-3 border-t border-border-subtle bg-surface-1 flex items-center gap-3">
                              <Archive size={16} class="shrink-0 text-text-dim" />
                              <span class="flex-1 text-sm text-text-muted">This task is archived</span>
                              <button
                                class="px-3 py-1.5 text-xs font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 transition-colors flex items-center gap-1.5"
                                onClick={() => restoreTask(t().id)}
                              >
                                <RotateCcw size={12} />
                                Restore
                              </button>
                            </div>
                          </Show>
                        </>
                      }
                    >
                      <div class="flex-1 overflow-hidden">
                        <FileViewer taskId={t().id} relativePath={mainView(t().id)} />
                      </div>
                    </Show>
                  </div>

                  {/* Unsaved changes confirm */}
                  <ConfirmDialog
                    open={!!pendingClose(t().id)}
                    title="Unsaved changes"
                    message={`"${pendingClose(t().id)?.split('/').pop()}" has unsaved changes. Close without saving?`}
                    confirmLabel="Close without saving"
                    danger
                    onConfirm={() => {
                      const path = pendingClose(t().id)
                      if (path) forceCloseTab(t().id, path)
                    }}
                    onCancel={() => cancelCloseTab(t().id)}
                  />

                  {/* File tab context menu */}
                  <ContextMenu
                    open={!!tabMenu()}
                    onClose={closeTabMenu}
                    pos={tabMenu() ? { x: tabMenu()!.x, y: tabMenu()!.y } : undefined}
                    items={tabMenu() ? [
                      { label: 'Close', shortcut: '\u2318W', icon: X, action: () => requestCloseTab(tabMenu()!.taskId, tabMenu()!.path) },
                      { label: 'Close Others', icon: X, action: () => closeOtherTabs(tabMenu()!.taskId, tabMenu()!.path) },
                      { label: 'Close All', icon: X, action: () => closeAllTabs(tabMenu()!.taskId) },
                      { separator: true },
                      { label: 'Copy Relative Path', icon: ClipboardCopy, action: () => navigator.clipboard.writeText(tabMenu()!.path) },
                    ] : []}
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
                    <TerminalPanel taskId={t().id} startCommand={projectById(t().projectId)?.startCommand} autoStart={projectById(t().projectId)?.autoStart} />
                  </div>

                </Show>
              </div>

              {/* Right panel — collapsible, contains Changes + Files tabs */}
              <Show when={showChanges() && !creating() && !error()}>
                <div
                  class="w-px cursor-col-resize shrink-0 bg-border-subtle hover:bg-accent/20 transition-colors relative z-10"
                  classList={{ '!bg-accent/40': rightPanelDragging() }}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setRightPanelDragging(true)
                    const startX = e.clientX
                    const startW = rightPanelWidth()
                    const onMove = (ev: MouseEvent) => {
                      const next = Math.max(220, Math.min(700, startW + (startX - ev.clientX)))
                      setRightPanelWidth(next)
                    }
                    const onUp = () => {
                      setRightPanelDragging(false)
                      localStorage.setItem('verun:rightPanelWidth', String(rightPanelWidth()))
                      window.removeEventListener('mousemove', onMove)
                      window.removeEventListener('mouseup', onUp)
                    }
                    window.addEventListener('mousemove', onMove)
                    window.addEventListener('mouseup', onUp)
                  }}
                  style={{ "margin-left": "-3px", "margin-right": "-3px", padding: "0 3px", "background-clip": "content-box" }}
                />
                <div
                  style={{ width: `${rightPanelWidth()}px` }}
                  class="shrink-0 overflow-hidden"
                >
                  <RightPanel taskId={t().id} />
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
