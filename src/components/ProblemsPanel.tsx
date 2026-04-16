import { Component, For, Show, createSignal, createMemo } from 'solid-js'
import { ChevronRight, ChevronDown, CircleCheck, Loader2, XCircle, AlertTriangle, Info, ClipboardCopy } from 'lucide-solid'
import { problemsByFileForTask, problemCountForTask, isProblemsLoading } from '../store/problems'
import { openFilePinned, revealFileInTree, setMainView, setPendingGoToLine, mainView } from '../store/editorView'
import { getFileIcon } from '../lib/fileIcons'
import { clsx } from 'clsx'
import { ContextMenu } from './ContextMenu'
import type { Problem, DiagnosticSeverity } from '../types'

interface Props {
  taskId: string
}

function severityIcon(severity: DiagnosticSeverity): Component<{ size: number; class?: string }> {
  switch (severity) {
    case 'error': return XCircle
    case 'warning': return AlertTriangle
    case 'info':
    case 'hint': return Info
  }
}

function severityColor(severity: DiagnosticSeverity): string {
  switch (severity) {
    case 'error': return 'text-status-error'
    case 'warning': return 'text-amber-400/80'
    case 'info':
    case 'hint': return 'text-text-dim'
  }
}

interface ContextMenuState {
  x: number
  y: number
  problem: Problem
}

type FlatItem = { kind: 'file'; file: string } | { kind: 'problem'; file: string; problem: Problem }

export const ProblemsPanel: Component<Props> = (props) => {
  const [collapsedFiles, setCollapsedFiles] = createSignal<Set<string>>(new Set())
  const [selectedIndex, setSelectedIndex] = createSignal(-1)
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null)
  const closeMenu = () => setContextMenu(null)
  let listRef: HTMLDivElement | undefined

  const counts = () => problemCountForTask(props.taskId)
  const byFile = () => problemsByFileForTask(props.taskId)

  const sortedFiles = createMemo(() => {
    const files = byFile()
    return Object.keys(files).sort((a, b) => {
      const aHasError = files[a].some(p => p.severity === 'error')
      const bHasError = files[b].some(p => p.severity === 'error')
      if (aHasError !== bHasError) return aHasError ? -1 : 1
      return a.localeCompare(b)
    })
  })

  // Flat list of all visible items for keyboard navigation
  const flatItems = createMemo((): FlatItem[] => {
    const items: FlatItem[] = []
    const collapsed = collapsedFiles()
    for (const file of sortedFiles()) {
      items.push({ kind: 'file', file })
      if (!collapsed.has(file)) {
        for (const problem of (byFile()[file] || [])) {
          items.push({ kind: 'problem', file, problem })
        }
      }
    }
    return items
  })

  const collapseFile = (file: string) => {
    setCollapsedFiles(prev => { const s = new Set(prev); s.add(file); return s })
  }

  const expandFile = (file: string) => {
    setCollapsedFiles(prev => { const s = new Set(prev); s.delete(file); return s })
  }

  const toggleCollapsed = (file: string) => {
    if (collapsedFiles().has(file)) expandFile(file)
    else collapseFile(file)
  }

  const collapseAll = () => {
    setCollapsedFiles(new Set<string>(sortedFiles()))
  }

  const expandAll = () => {
    setCollapsedFiles(new Set<string>())
  }

  const handleProblemClick = (problem: Problem) => {
    setPendingGoToLine({ taskId: props.taskId, relativePath: problem.file, line: problem.line, column: problem.column })
    if (mainView(props.taskId) !== problem.file) {
      const name = problem.file.split('/').pop() || problem.file
      openFilePinned(props.taskId, problem.file, name)
      setMainView(props.taskId, problem.file)
      revealFileInTree(props.taskId, problem.file)
    }
  }

  const scrollSelectedIntoView = (idx: number) => {
    if (!listRef) return
    const el = listRef.querySelector(`[data-idx="${idx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const items = flatItems()
    if (items.length === 0) return
    const idx = selectedIndex()
    const item = idx >= 0 && idx < items.length ? items[idx] : null
    const mod = e.metaKey || e.ctrlKey

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = Math.min(idx + 1, items.length - 1)
        setSelectedIndex(next)
        scrollSelectedIntoView(next)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const next = Math.max(idx - 1, 0)
        setSelectedIndex(next)
        scrollSelectedIntoView(next)
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        if (mod) {
          // Cmd+Left — collapse all
          collapseAll()
          // Select the file header of the current item
          if (item) {
            const fileIdx = flatItems().findIndex(i => i.kind === 'file' && i.file === item.file)
            if (fileIdx >= 0) setSelectedIndex(fileIdx)
          }
        } else if (item?.kind === 'problem') {
          // On a problem row — jump to file header
          const fileIdx = items.findIndex(i => i.kind === 'file' && i.file === item.file)
          if (fileIdx >= 0) {
            setSelectedIndex(fileIdx)
            scrollSelectedIntoView(fileIdx)
          }
        } else if (item?.kind === 'file') {
          // On a file header — collapse it
          collapseFile(item.file)
        }
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        if (mod) {
          // Cmd+Right — expand all
          expandAll()
        } else if (item?.kind === 'file') {
          if (collapsedFiles().has(item.file)) {
            expandFile(item.file)
          } else {
            // Already expanded — move to first problem
            const next = idx + 1
            if (next < flatItems().length && flatItems()[next].kind === 'problem') {
              setSelectedIndex(next)
              scrollSelectedIntoView(next)
            }
          }
        }
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        if (item?.kind === 'file') {
          toggleCollapsed(item.file)
        } else if (item?.kind === 'problem') {
          handleProblemClick(item.problem)
        }
        break
      }
    }
  }

  const copyMessage = (p: Problem) => navigator.clipboard.writeText(p.message)
  const copyLine = (p: Problem) => navigator.clipboard.writeText(`${p.file}:${p.line}:${p.column}`)
  const copyAll = (p: Problem) => {
    const text = `${p.file}(${p.line},${p.column}): ${p.severity} ${p.code || ''}: ${p.message}`
    navigator.clipboard.writeText(text)
  }

  const loading = () => isProblemsLoading(props.taskId)
  const total = () => counts().errors + counts().warnings + counts().info

  // Get flat index for a file header or problem row
  const indexOfFile = (file: string) => flatItems().findIndex(i => i.kind === 'file' && i.file === file)
  const indexOfProblem = (file: string, problem: Problem) =>
    flatItems().findIndex(i => i.kind === 'problem' && i.file === file && i.problem === problem)

  return (
    <div
      class="flex flex-col h-full outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div ref={listRef} class="flex-1 overflow-y-auto scrollbar-thin">
        <Show
          when={!loading() || total() > 0}
          fallback={
            <div class="flex items-center justify-center h-full text-text-dim gap-1.5">
              <Loader2 size={13} class="animate-spin text-text-dim/50" />
              <span class="text-[11px]">Analyzing...</span>
            </div>
          }
        >
        <Show
          when={sortedFiles().length > 0}
          fallback={
            <div class="flex items-center justify-center h-full text-text-dim gap-1.5">
              <CircleCheck size={13} class="text-text-dim/50" />
              <span class="text-[11px]">No problems</span>
            </div>
          }
        >
          <For each={sortedFiles()}>
            {(file) => {
              const FileIcon = () => {
                const name = file.split('/').pop() || file
                const I = getFileIcon(name)
                return <I size={12} />
              }
              const isCollapsed = () => collapsedFiles().has(file)
              const problems = () => byFile()[file] || []
              const errorCount = () => problems().filter(p => p.severity === 'error').length
              const warnCount = () => problems().filter(p => p.severity === 'warning').length
              const fileIdx = () => indexOfFile(file)

              return (
                <div>
                  <button
                    data-idx={fileIdx()}
                    class={clsx(
                      'w-full flex items-center gap-1.5 px-3 py-1 text-[11px] text-left',
                      selectedIndex() === fileIdx() ? 'bg-surface-2' : 'hover:bg-surface-2'
                    )}
                    onClick={() => { setSelectedIndex(fileIdx()); toggleCollapsed(file) }}
                  >
                    {isCollapsed()
                      ? <ChevronRight size={10} class="shrink-0 text-text-dim" />
                      : <ChevronDown size={10} class="shrink-0 text-text-dim" />}
                    <FileIcon />
                    <span class="text-text-muted truncate">{file}</span>
                    <span class="ml-auto shrink-0 flex items-center gap-1.5 text-[10px] tabular-nums">
                      <Show when={errorCount() > 0}>
                        <span class="text-status-error">{errorCount()}</span>
                      </Show>
                      <Show when={warnCount() > 0}>
                        <span class="text-amber-400/80">{warnCount()}</span>
                      </Show>
                    </span>
                  </button>

                  <Show when={!isCollapsed()}>
                    <For each={problems()}>
                      {(problem) => {
                        const pIdx = () => indexOfProblem(file, problem)
                        const SeverityIcon = severityIcon(problem.severity)
                        return (
                          <button
                            data-idx={pIdx()}
                            class={clsx(
                              'w-full flex items-start gap-2 pl-7 pr-3 py-0.5 text-[11px] text-left cursor-pointer',
                              selectedIndex() === pIdx() ? 'bg-surface-2' : 'hover:bg-surface-2'
                            )}
                            onClick={() => { setSelectedIndex(pIdx()); handleProblemClick(problem) }}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setContextMenu({ x: e.clientX, y: e.clientY, problem })
                            }}
                          >
                            <SeverityIcon size={12} class={clsx('shrink-0 mt-0.5', severityColor(problem.severity))} />
                            <span class="text-text-muted flex-1 min-w-0 break-words leading-relaxed">{problem.message}</span>
                            <span class="text-text-dim/60 shrink-0 text-[10px] tabular-nums mt-0.5">
                              {problem.line}:{problem.column}
                            </span>
                            <Show when={problem.code != null}>
                              <span class="text-text-dim/40 shrink-0 font-mono text-[10px] mt-0.5">{problem.code}</span>
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>
        </Show>
      </div>

      {/* Context menu */}
      <ContextMenu
        open={!!contextMenu()}
        onClose={closeMenu}
        pos={contextMenu() ? { x: contextMenu()!.x, y: contextMenu()!.y } : undefined}
        items={contextMenu() ? [
          { label: 'Copy Message', icon: ClipboardCopy, action: () => copyMessage(contextMenu()!.problem) },
          { label: 'Copy Path', icon: ClipboardCopy, action: () => copyLine(contextMenu()!.problem) },
          { label: 'Copy All', icon: ClipboardCopy, action: () => copyAll(contextMenu()!.problem) },
        ] : []}
      />
    </div>
  )
}
