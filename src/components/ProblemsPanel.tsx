import { Component, For, Show, createSignal, createMemo, createEffect, onCleanup } from 'solid-js'
import { ChevronRight, ChevronDown, CircleCheck, Loader2 } from 'lucide-solid'
import { problemsByFileForTask, problemCountForTask, isProblemsLoading } from '../store/problems'
import { openFilePinned, setMainView, setPendingGoToLine, revealFileInTree, mainView } from '../store/files'
import { getFileIcon } from '../lib/fileIcons'
import { clsx } from 'clsx'
import { registerDismissable } from '../lib/dismissable'
import type { Problem, DiagnosticSeverity } from '../types'

interface Props {
  taskId: string
}

function severityChar(severity: DiagnosticSeverity): string {
  switch (severity) {
    case 'error': return '\u2715'
    case 'warning': return '\u25B3'
    case 'info':
    case 'hint': return '\u2139'
  }
}

function severityColor(severity: DiagnosticSeverity): string {
  switch (severity) {
    case 'error': return 'text-status-error'
    case 'warning': return 'text-yellow-500/70'
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
  let menuRef: HTMLDivElement | undefined
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

  // Close context menu on outside click
  const closeMenu = (e: MouseEvent) => {
    if (menuRef && menuRef.contains(e.target as Node)) return
    setContextMenu(null)
  }
  createEffect(() => {
    if (contextMenu()) {
      document.addEventListener('mousedown', closeMenu, true)
      const unregister = registerDismissable(() => setContextMenu(null))
      onCleanup(() => {
        document.removeEventListener('mousedown', closeMenu, true)
        unregister()
      })
    }
  })

  const copyMessage = (p: Problem) => {
    navigator.clipboard.writeText(p.message)
    setContextMenu(null)
  }

  const copyLine = (p: Problem) => {
    navigator.clipboard.writeText(`${p.file}:${p.line}:${p.column}`)
    setContextMenu(null)
  }

  const copyAll = (p: Problem) => {
    const text = `${p.file}(${p.line},${p.column}): ${p.severity} ${p.code || ''}: ${p.message}`
    navigator.clipboard.writeText(text)
    setContextMenu(null)
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
                      'w-full flex items-center gap-1.5 px-3 py-1 text-[11px] transition-colors text-left',
                      selectedIndex() === fileIdx() ? 'bg-surface-3' : 'hover:bg-surface-2'
                    )}
                    onClick={() => { setSelectedIndex(fileIdx()); toggleCollapsed(file) }}
                  >
                    {isCollapsed()
                      ? <ChevronRight size={10} class="shrink-0 text-text-dim" />
                      : <ChevronDown size={10} class="shrink-0 text-text-dim" />}
                    <FileIcon />
                    <span class="text-text-muted truncate">{file}</span>
                    <span class="text-[10px] text-text-dim ml-auto shrink-0">
                      {errorCount() > 0 && errorCount()}{errorCount() > 0 && warnCount() > 0 && ' / '}{warnCount() > 0 && warnCount()}
                    </span>
                  </button>

                  <Show when={!isCollapsed()}>
                    <For each={problems()}>
                      {(problem) => {
                        const pIdx = () => indexOfProblem(file, problem)
                        return (
                          <button
                            data-idx={pIdx()}
                            class={clsx(
                              'w-full flex items-start gap-2 pl-8 pr-3 py-0.5 text-[11px] transition-colors text-left cursor-pointer',
                              selectedIndex() === pIdx() ? 'bg-surface-3' : 'hover:bg-surface-1'
                            )}
                            onClick={() => { setSelectedIndex(pIdx()); handleProblemClick(problem) }}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setContextMenu({ x: e.clientX, y: e.clientY, problem })
                            }}
                          >
                            <span class={clsx('shrink-0 text-[10px] leading-relaxed font-mono', severityColor(problem.severity))}>
                              {severityChar(problem.severity)}
                            </span>
                            <span class="text-text-muted flex-1 min-w-0 break-words leading-relaxed">{problem.message}</span>
                            <span class="text-text-dim/60 shrink-0 text-[10px] tabular-nums">
                              {problem.line}:{problem.column}
                            </span>
                            <Show when={problem.code != null}>
                              <span class="text-text-dim/40 shrink-0 font-mono text-[10px]">{problem.code}</span>
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
      <Show when={contextMenu()}>
        {(menu) => (
          <div
            ref={menuRef}
            class="fixed z-100 bg-[#21252b] border border-[#181a1f] rounded-lg py-1 min-w-40"
            style={{ left: `${menu().x}px`, top: `${menu().y}px`, 'box-shadow': '0 6px 24px rgba(0,0,0,0.5)' }}
          >
            <button
              class="w-full flex items-center px-3 py-1.5 text-[12px] text-[#abb2bf] hover:bg-[#2c313a] text-left"
              onClick={() => copyMessage(menu().problem)}
            >
              Copy Message
            </button>
            <button
              class="w-full flex items-center px-3 py-1.5 text-[12px] text-[#abb2bf] hover:bg-[#2c313a] text-left"
              onClick={() => copyLine(menu().problem)}
            >
              Copy Path
            </button>
            <button
              class="w-full flex items-center px-3 py-1.5 text-[12px] text-[#abb2bf] hover:bg-[#2c313a] text-left"
              onClick={() => copyAll(menu().problem)}
            >
              Copy All
            </button>
          </div>
        )}
      </Show>
    </div>
  )
}
