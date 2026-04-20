import { Component, For, Show, createSignal, createMemo } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
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

interface FileGroup {
  file: string
  problems: Problem[]
  errorCount: number
  warnCount: number
}

type ProblemRow =
  | { kind: 'file'; file: string; group: FileGroup }
  | { kind: 'problem'; file: string; problem: Problem }

export const ProblemsPanel: Component<Props> = (props) => {
  const [collapsedFiles, setCollapsedFiles] = createSignal<Set<string>>(new Set())
  const [selectedIndex, setSelectedIndex] = createSignal(-1)
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null)
  const closeMenu = () => setContextMenu(null)
  let listRef: HTMLDivElement | undefined

  const counts = () => problemCountForTask(props.taskId)
  const byFile = () => problemsByFileForTask(props.taskId)

  const fileGroups = createMemo((): FileGroup[] => {
    const files = byFile()
    return Object.keys(files).map((file) => {
      const problems = files[file] || []
      let errorCount = 0
      let warnCount = 0
      for (const p of problems) {
        if (p.severity === 'error') errorCount++
        else if (p.severity === 'warning') warnCount++
      }
      return { file, problems, errorCount, warnCount }
    }).sort((a, b) => {
      const aHasError = a.errorCount > 0
      const bHasError = b.errorCount > 0
      if (aHasError !== bHasError) return aHasError ? -1 : 1
      return a.file.localeCompare(b.file)
    })
  })

  // Flat list of all visible items for keyboard navigation
  const flatItems = createMemo((): ProblemRow[] => {
    const items: ProblemRow[] = []
    const collapsed = collapsedFiles()
    for (const group of fileGroups()) {
      items.push({ kind: 'file', file: group.file, group })
      if (!collapsed.has(group.file)) {
        for (const problem of group.problems) {
          items.push({ kind: 'problem', file: group.file, problem })
        }
      }
    }
    return items
  })

  const virtualizer = createVirtualizer({
    get count() { return flatItems().length },
    getScrollElement: () => listRef ?? null,
    estimateSize: () => 26,
    overscan: 8,
    initialRect: { width: 320, height: 240 },
  })

  const virtualRows = () => {
    const rows = virtualizer.getVirtualItems()
    if (rows.length > 0 || flatItems().length === 0) return rows
    const size = 26
    return Array.from({ length: Math.min(flatItems().length, 18) }, (_, index) => ({
      key: index,
      index,
      start: index * size,
      end: (index + 1) * size,
      size,
      lane: 0,
    }))
  }

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
    setCollapsedFiles(new Set<string>(fileGroups().map(g => g.file)))
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
          when={fileGroups().length > 0}
          fallback={
            <div class="flex items-center justify-center h-full text-text-dim gap-1.5">
              <CircleCheck size={13} class="text-text-dim/50" />
              <span class="text-[11px]">No problems</span>
            </div>
          }
        >
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            <For each={virtualRows()}>
              {(vrow) => {
                const row = () => flatItems()[vrow.index]
                return (
                  <div
                    data-idx={vrow.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${vrow.size}px`,
                      transform: `translateY(${vrow.start}px)`,
                    }}
                  >
                    <Show when={row()?.kind === 'file'}>
                      {(() => {
                        const r = row() as Extract<ProblemRow, { kind: 'file' }>
                        const file = () => r.file
                        const name = () => file().split('/').pop() || file()
                        const isCollapsed = () => collapsedFiles().has(file())
                        const FileIcon = () => {
                          const I = getFileIcon(name())
                          return <I size={12} />
                        }
                        return (
                          <button
                            class={clsx(
                              'w-full h-full flex items-center gap-1.5 px-3 text-[11px] text-left',
                              selectedIndex() === vrow.index ? 'bg-surface-2' : 'hover:bg-surface-2'
                            )}
                            onClick={() => { setSelectedIndex(vrow.index); toggleCollapsed(file()) }}
                          >
                            {isCollapsed()
                              ? <ChevronRight size={10} class="shrink-0 text-text-dim" />
                              : <ChevronDown size={10} class="shrink-0 text-text-dim" />}
                            <FileIcon />
                            <span class="text-text-muted truncate">{file()}</span>
                            <span class="ml-auto shrink-0 flex items-center gap-1.5 text-[10px] tabular-nums">
                              <Show when={r.group.errorCount > 0}>
                                <span class="text-status-error">{r.group.errorCount}</span>
                              </Show>
                              <Show when={r.group.warnCount > 0}>
                                <span class="text-amber-400/80">{r.group.warnCount}</span>
                              </Show>
                            </span>
                          </button>
                        )
                      })()}
                    </Show>
                    <Show when={row()?.kind === 'problem'}>
                      {(() => {
                        const r = row() as Extract<ProblemRow, { kind: 'problem' }>
                        const problem = () => r.problem
                        const SeverityIcon = severityIcon(problem().severity)
                        return (
                          <button
                            class={clsx(
                              'w-full h-full flex items-start gap-2 pl-7 pr-3 py-0.5 text-[11px] text-left cursor-pointer',
                              selectedIndex() === vrow.index ? 'bg-surface-2' : 'hover:bg-surface-2'
                            )}
                            onClick={() => { setSelectedIndex(vrow.index); handleProblemClick(problem()) }}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setContextMenu({ x: e.clientX, y: e.clientY, problem: problem() })
                            }}
                          >
                            <SeverityIcon size={12} class={clsx('shrink-0 mt-0.5', severityColor(problem().severity))} />
                            <span class="text-text-muted flex-1 min-w-0 truncate leading-relaxed">{problem().message}</span>
                            <span class="text-text-dim/60 shrink-0 text-[10px] tabular-nums mt-0.5">
                              {problem().line}:{problem().column}
                            </span>
                            <Show when={problem().code != null}>
                              <span class="text-text-dim/40 shrink-0 font-mono text-[10px] mt-0.5">{problem().code}</span>
                            </Show>
                          </button>
                        )
                      })()}
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
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
