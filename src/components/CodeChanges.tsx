import { Component, createSignal, createEffect, on, Show, For } from 'solid-js'
import { ChevronDown, ChevronRight, FileText, FilePlus, FileX, FileEdit, RefreshCw, X, WrapText, EyeOff, GitCommit, Circle } from 'lucide-solid'
import { defaultWrapLines, defaultHideWhitespace } from '../store/ui'
import { hasOverlayTitlebar } from '../lib/platform'
import { taskGit, refreshTaskGit } from '../store/git'
import * as ipc from '../lib/ipc'
import { highlightLine, langFromPath, type HighlightToken } from '../lib/highlighter'
import { GitActions } from './GitActions'
import type { GitStatus, FileDiff, DiffLine } from '../types'

interface Props {
  taskId: string
  sessionId: string | null
  isRunning?: boolean
}

const STATUS_ICONS: Record<string, Component<{ size: number }>> = {
  M: FileEdit,
  A: FilePlus,
  D: FileX,
  R: FileEdit,
  '?': FilePlus,
}

const STATUS_COLORS: Record<string, string> = {
  M: 'text-amber-400',
  A: 'text-emerald-400',
  D: 'text-red-400',
  R: 'text-blue-400',
  '?': 'text-text-dim',
}

export const CodeChanges: Component<Props> = (props) => {
  const [openFiles, setOpenFiles] = createSignal<Set<string>>(new Set())
  const [fileDiffs, setFileDiffs] = createSignal<Map<string, FileDiff>>(new Map())
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // null = uncommitted changes (read from store), string = commit hash (local)
  const [selectedCommit, setSelectedCommit] = createSignal<string | null>(null)
  const [commitStatus, setCommitStatus] = createSignal<GitStatus | null>(null)
  const [commitsOpen, setCommitsOpen] = createSignal(
    localStorage.getItem('verun:commitsOpen') !== 'false'
  )

  // Reactive accessors that branch on selectedCommit
  const status = () => selectedCommit() ? commitStatus() : taskGit(props.taskId).status
  const commits = () => taskGit(props.taskId).commits
  const uncommittedCount = () => taskGit(props.taskId).status?.files.length ?? 0

  // Prune open files when store status changes (uncommitted view only)
  createEffect(() => {
    const s = taskGit(props.taskId).status
    if (!s || selectedCommit()) return
    const paths = new Set(s.files.map(f => f.path))
    const current = openFiles()
    const stillValid = new Set([...current].filter(p => paths.has(p)))
    if (stillValid.size !== current.size) {
      setOpenFiles(stillValid)
      const diffs = new Map(fileDiffs())
      for (const p of current) {
        if (!stillValid.has(p)) diffs.delete(p)
      }
      setFileDiffs(diffs)
    }
  })

  const refresh = async () => {
    try {
      setLoading(true)
      setError(null)
      await refreshTaskGit(props.taskId, { force: true })
    } catch (e: any) {
      setError(e?.toString() || 'Failed to load status')
    } finally {
      setLoading(false)
    }
  }

  const selectCommit = async (hash: string | null) => {
    setSelectedCommit(hash)
    setOpenFiles(new Set<string>())
    setFileDiffs(new Map<string, FileDiff>())

    if (hash === null) {
      setCommitStatus(null) // will read from store
    } else {
      try {
        const s = await ipc.getCommitFiles(props.taskId, hash)
        setCommitStatus(s)
      } catch {}
    }
  }

  createEffect(on(() => props.taskId, () => {
    setSelectedCommit(null)
    setCommitStatus(null)
    setOpenFiles(new Set<string>())
    setFileDiffs(new Map<string, FileDiff>())
    refreshTaskGit(props.taskId)
  }))

  const [wordWrap, setWordWrap] = createSignal(defaultWrapLines())
  const [hideWhitespace, setHideWhitespace] = createSignal(defaultHideWhitespace())

  // Syntax highlighting: shared cache across all files
  const [tokenCache, setTokenCache] = createSignal<Map<string, HighlightToken[]>>(new Map())

  const highlightDiff = async (diff: FileDiff, path: string) => {
    const lang = langFromPath(path)
    if (!lang) return

    const lines = diff.hunks.flatMap(h => h.lines)
    const unique = [...new Set(lines.map(l => l.content))]
    const cache = new Map(tokenCache())

    const toHighlight = unique.filter(c => !cache.has(c))
    if (toHighlight.length === 0) return

    const results = await Promise.all(
      toHighlight.map(async (content) => {
        const tokens = await highlightLine(content, lang)
        return [content, tokens] as const
      })
    )

    for (const [content, tokens] of results) {
      cache.set(content, tokens)
    }
    setTokenCache(new Map(cache))
  }

  const toggleFile = async (path: string) => {
    const current = new Set(openFiles())
    if (current.has(path)) {
      current.delete(path)
      setOpenFiles(current)
      const diffs = new Map(fileDiffs())
      diffs.delete(path)
      setFileDiffs(diffs)
      return
    }

    current.add(path)
    setOpenFiles(current)
    try {
      const commit = selectedCommit()
      const diff = commit
        ? await ipc.getCommitFileDiff(props.taskId, commit, path, undefined, hideWhitespace() || undefined)
        : await ipc.getFileDiff(props.taskId, path, undefined, hideWhitespace() || undefined)
      const diffs = new Map(fileDiffs())
      diffs.set(path, diff)
      setFileDiffs(diffs)
      highlightDiff(diff, path)
    } catch {}
  }

  // Re-fetch all open files when hideWhitespace changes
  createEffect(on(hideWhitespace, async (hw) => {
    const paths = [...openFiles()]
    if (paths.length === 0) return
    const commit = selectedCommit()
    const diffs = new Map(fileDiffs())
    for (const path of paths) {
      try {
        const diff = commit
          ? await ipc.getCommitFileDiff(props.taskId, commit, path, undefined, hw || undefined)
          : await ipc.getFileDiff(props.taskId, path, undefined, hw || undefined)
        diffs.set(path, diff)
        highlightDiff(diff, path)
      } catch {}
    }
    setFileDiffs(new Map(diffs))
  }, { defer: true }))

  const EXPAND_LINES = 20

  const expandAbove = async (path: string, hunkIndex: number) => {
    const diff = fileDiffs().get(path)
    if (!diff) return

    const hunk = diff.hunks[hunkIndex]
    const endLine = hunk.newStart - 1
    const startLine = Math.max(1, endLine - EXPAND_LINES + 1)
    if (endLine < 1) return

    try {
      const lines = await ipc.getFileContext(props.taskId, path, startLine, endLine, 'new')
      if (lines.length === 0) return

      const contextLines: DiffLine[] = lines.map((content, i) => ({
        kind: 'context',
        content,
        oldLineNumber: hunk.oldStart - lines.length + i,
        newLineNumber: startLine + i,
      }))

      const updatedHunks = [...diff.hunks]
      const updatedHunk = { ...hunk }
      updatedHunk.lines = [...contextLines, ...hunk.lines]
      updatedHunk.oldStart = Math.max(1, hunk.oldStart - lines.length)
      updatedHunk.oldCount = hunk.oldCount + lines.length
      updatedHunk.newStart = startLine
      updatedHunk.newCount = hunk.newCount + lines.length
      updatedHunks[hunkIndex] = updatedHunk

      const newDiff = { ...diff, hunks: updatedHunks }
      const diffs = new Map(fileDiffs())
      diffs.set(path, newDiff)
      setFileDiffs(diffs)
      highlightDiff(newDiff, path)
    } catch {}
  }

  const expandBelow = async (path: string, hunkIndex: number) => {
    const diff = fileDiffs().get(path)
    if (!diff) return

    const hunk = diff.hunks[hunkIndex]
    const lastNewLine = hunk.lines.reduce((max, l) => l.newLineNumber ? Math.max(max, l.newLineNumber) : max, 0)
    const startLine = lastNewLine + 1
    const endLine = startLine + EXPAND_LINES - 1

    try {
      const lines = await ipc.getFileContext(props.taskId, path, startLine, endLine, 'new')
      if (lines.length === 0) return

      const contextLines: DiffLine[] = lines.map((content, i) => {
        const lastOldLine = hunk.lines.reduce((max, l) => l.oldLineNumber ? Math.max(max, l.oldLineNumber) : max, 0)
        return {
          kind: 'context',
          content,
          oldLineNumber: lastOldLine + 1 + i,
          newLineNumber: startLine + i,
        }
      })

      const updatedHunks = [...diff.hunks]
      const updatedHunk = { ...hunk }
      updatedHunk.lines = [...hunk.lines, ...contextLines]
      updatedHunk.oldCount = hunk.oldCount + lines.length
      updatedHunk.newCount = hunk.newCount + lines.length
      updatedHunks[hunkIndex] = updatedHunk

      const newDiff = { ...diff, hunks: updatedHunks }
      const diffs = new Map(fileDiffs())
      diffs.set(path, newDiff)
      setFileDiffs(diffs)
      highlightDiff(newDiff, path)
    } catch {}
  }

  const statsForFile = (path: string) => {
    return status()?.stats.find(s => s.path === path)
  }

  const toggleCommitsPanel = () => {
    const next = !commitsOpen()
    setCommitsOpen(next)
    localStorage.setItem('verun:commitsOpen', String(next))
  }

  const selectedCommitInfo = () => commits().find(c => c.hash === selectedCommit())

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000)
    const now = Date.now()
    const diff = now - d.getTime()
    if (diff < 60_000) return 'just now'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
    return `${Math.floor(diff / 86400_000)}d ago`
  }

  return (
    <div class="flex flex-col h-full overflow-hidden min-w-0">
      {/* Drag region for titlebar (macOS overlay) */}
      <Show when={hasOverlayTitlebar}><div class="h-10 shrink-0 drag-region" data-tauri-drag-region /></Show>

      {/* Header row: title + stats + git action — fixed height */}
      <div class="flex items-center justify-between px-3 h-9 border-b border-border-subtle bg-surface-1">
        <div class="flex items-center gap-2 text-xs text-text-muted min-w-0">
          <span class="font-medium text-text-secondary shrink-0">
            {selectedCommit() ? 'Commit' : 'Changes'}
          </span>
          <Show when={selectedCommit() && selectedCommitInfo()}>
            <span class="font-mono text-text-dim truncate">{selectedCommitInfo()!.shortHash}</span>
          </Show>
          <Show when={status()}>
            <span class="px-1.5 py-0.5 rounded bg-surface-3 text-text-dim shrink-0">
              {status()!.files.length} file{status()!.files.length !== 1 ? 's' : ''}
            </span>
            <Show when={status()!.totalInsertions > 0}>
              <span class="text-emerald-400 shrink-0">+{status()!.totalInsertions}</span>
            </Show>
            <Show when={status()!.totalDeletions > 0}>
              <span class="text-red-400 shrink-0">-{status()!.totalDeletions}</span>
            </Show>
          </Show>
        </div>

        <GitActions
          taskId={props.taskId}
          sessionId={props.sessionId}
          isRunning={props.isRunning}
        />
      </div>

      {/* Formatting toolbar */}
      <div class="flex items-center justify-end gap-1 px-3 py-1 border-b border-border-subtle">
        <button
          class={`p-1 rounded transition-colors ${wordWrap() ? 'text-accent bg-accent-muted' : 'text-text-dim hover:text-text-secondary hover:bg-surface-3'}`}
          onClick={() => setWordWrap(!wordWrap())}
          title="Word wrap"
        >
          <WrapText size={12} />
        </button>
        <button
          class={`p-1 rounded transition-colors ${hideWhitespace() ? 'text-accent bg-accent-muted' : 'text-text-dim hover:text-text-secondary hover:bg-surface-3'}`}
          onClick={() => setHideWhitespace(!hideWhitespace())}
          title="Hide whitespace changes"
        >
          <EyeOff size={12} />
        </button>
        <button
          class="p-1 rounded text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors"
          onClick={refresh}
          disabled={loading()}
          title="Refresh"
        >
          <RefreshCw size={12} class={loading() ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Error */}
      <Show when={error()}>
        <div class="px-3 py-2 text-xs text-red-400 bg-red-400/5 border-b border-border-subtle flex items-center justify-between">
          <span class="truncate">{error()}</span>
          <button class="shrink-0 ml-2" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      </Show>

      {/* File list + diff */}
      <div class="flex-1 overflow-auto">
        <Show when={status()?.files.length === 0 && !loading()}>
          <div class="px-4 py-10 text-center">
            <p class="text-sm text-text-muted mb-1">
              {selectedCommit() ? 'No files in this commit' : 'No changes yet'}
            </p>
            <Show when={!selectedCommit()}>
              <p class="text-xs text-text-dim">File modifications will appear here as Claude works.</p>
            </Show>
          </div>
        </Show>

        <For each={status()?.files || []}>
          {(file) => {
            const Icon = STATUS_ICONS[file.status] || FileText
            const color = STATUS_COLORS[file.status] || 'text-text-muted'
            const stats = () => statsForFile(file.path)
            const isOpen = () => openFiles().has(file.path)
            const diff = () => fileDiffs().get(file.path)

            return (
              <div>
                {/* File row */}
                <div
                  class={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs transition-colors ${
                    isOpen()
                      ? 'bg-surface-1 text-text-primary sticky top-0 z-10 border-b border-border-subtle'
                      : 'hover:bg-surface-2 text-text-secondary'
                  }`}
                  onClick={() => toggleFile(file.path)}
                >
                  {/* Expand chevron */}
                  <span class="text-text-dim shrink-0">
                    {isOpen() ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>

                  {/* Status icon */}
                  <span class={`shrink-0 ${color}`}>
                    <Icon size={13} />
                  </span>

                  {/* File path */}
                  <span class="truncate flex-1 font-mono">
                    {file.path}
                  </span>

                  {/* Stats */}
                  <Show when={stats()}>
                    <span class="shrink-0 flex items-center gap-1.5 text-[10px] font-mono">
                      <Show when={stats()!.insertions > 0}>
                        <span class="text-emerald-400">+{stats()!.insertions}</span>
                      </Show>
                      <Show when={stats()!.deletions > 0}>
                        <span class="text-red-400">-{stats()!.deletions}</span>
                      </Show>
                    </span>
                  </Show>
                </div>

                {/* Inline diff */}
                <Show when={isOpen() && diff()}>
                  <DiffView
                    diff={diff()!}
                    tokens={tokenCache()}
                    wordWrap={wordWrap()}
                    onExpandAbove={(hi) => expandAbove(file.path, hi)}
                    onExpandBelow={(hi) => expandBelow(file.path, hi)}
                  />
                </Show>
              </div>
            )
          }}
        </For>
      </div>

      {/* Branch commits — collapsible, bottom-aligned like VS Code */}
      <div class="shrink-0 border-t border-border-subtle">
        <button
          class="w-full h-8 flex items-center gap-1.5 px-3 text-xs hover:bg-surface-2 transition-colors"
          onClick={toggleCommitsPanel}
        >
          {commitsOpen() ? <ChevronDown size={12} class="text-text-dim shrink-0" /> : <ChevronRight size={12} class="text-text-dim shrink-0" />}
          <GitCommit size={12} class="text-text-dim shrink-0" />
          <span class="font-medium text-text-secondary">Branch Commits</span>
          <Show when={commits().length > 0}>
            <span class="px-1.5 py-0.5 rounded bg-surface-3 text-text-dim text-[10px] leading-none">
              {commits().length}
            </span>
          </Show>
        </button>

        {/* Commits list */}
        <Show when={commitsOpen()}>
          <div class="max-h-48 overflow-auto">
            {/* Uncommitted changes tile */}
            <button
              class={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                selectedCommit() === null
                  ? 'bg-accent-muted text-accent-hover'
                  : 'hover:bg-surface-2 text-text-secondary'
              }`}
              onClick={() => selectCommit(null)}
            >
              <Circle size={11} class={`shrink-0 ${uncommittedCount() > 0 ? 'text-amber-400' : 'text-text-dim'}`} />
              <span class="truncate flex-1 text-left">Uncommitted changes</span>
              <Show when={uncommittedCount() > 0}>
                <span class="text-[10px] text-text-dim shrink-0">{uncommittedCount()} file{uncommittedCount() !== 1 ? 's' : ''}</span>
              </Show>
            </button>

            <For each={commits()}>
              {(commit) => (
                <button
                  class={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                    selectedCommit() === commit.hash
                      ? 'bg-accent-muted text-accent-hover'
                      : 'hover:bg-surface-2 text-text-secondary'
                  }`}
                  onClick={() => selectCommit(commit.hash)}
                >
                  <span class="font-mono text-text-dim text-[10px] shrink-0">{commit.shortHash}</span>
                  <span class="truncate flex-1 text-left">{commit.message}</span>
                  <span class="text-[10px] text-text-dim shrink-0">{formatTime(commit.timestamp)}</span>
                </button>
              )}
            </For>

            <Show when={commits().length === 0 && !loading()}>
              <div class="px-3 py-3 text-[11px] text-text-dim text-center">
                No commits on this branch yet
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Diff viewer sub-component
// ---------------------------------------------------------------------------

const ExpandButton: Component<{ onClick: () => void; label: string; direction: 'up' | 'down' }> = (props) => (
  <button
    class="sticky left-0 w-full py-1 px-3 text-[10px] text-accent/70 hover:text-accent hover:bg-accent-muted/50 font-mono transition-colors select-none flex items-center gap-1"
    onClick={props.onClick}
  >
    <span>{props.direction === 'up' ? '↑' : '↓'}</span>
    <span>{props.label}</span>
  </button>
)

interface DiffViewProps {
  diff: FileDiff
  tokens: Map<string, HighlightToken[]>
  wordWrap: boolean
  onExpandAbove: (hunkIndex: number) => void
  onExpandBelow: (hunkIndex: number) => void
}

const DiffView: Component<DiffViewProps> = (props) => {
  return (
    <div class="border-t border-b border-border-subtle bg-surface-0 overflow-x-auto">
      <div class="min-w-fit">
      <For each={props.diff.hunks}>
        {(hunk, i) => {
          const showExpandAbove = () => i() === 0 && hunk.newStart > 1
          const showExpandBetween = () => {
            if (i() === 0) return false
            const prev = props.diff.hunks[i() - 1]
            const prevLastLine = prev.lines.reduce((max, l) => l.newLineNumber ? Math.max(max, l.newLineNumber) : max, 0)
            return hunk.newStart > prevLastLine + 1
          }

          return (
            <div>
              {/* Expand above first hunk */}
              <Show when={showExpandAbove()}>
                <ExpandButton onClick={() => props.onExpandAbove(i())} label="Load more" direction="up" />
              </Show>

              {/* Expand between hunks — show both down (prev) and up (current) */}
              <Show when={showExpandBetween()}>
                <div class="sticky left-0 flex border-y border-border-subtle">
                  <button
                    class="flex-1 py-1 px-3 text-[10px] text-accent/70 hover:text-accent hover:bg-accent-muted/50 font-mono transition-colors select-none text-left"
                    onClick={() => props.onExpandBelow(i() - 1)}
                  >
                    ↓ Load below
                  </button>
                  <div class="w-px bg-border-subtle" />
                  <button
                    class="flex-1 py-1 px-3 text-[10px] text-accent/70 hover:text-accent hover:bg-accent-muted/50 font-mono transition-colors select-none text-left"
                    onClick={() => props.onExpandAbove(i())}
                  >
                    ↑ Load above
                  </button>
                </div>
              </Show>

              {/* Hunk header */}
              <div class="px-3 py-1 text-[10px] font-mono text-text-dim bg-surface-2 border-b border-border-subtle select-none">
                @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
                <Show when={hunk.header}>
                  <span class="ml-2 text-text-muted">{hunk.header}</span>
                </Show>
              </div>

              {/* Lines */}
              <For each={hunk.lines}>
                {(line) => {
                  const bgClass = line.kind === 'add'
                    ? 'bg-emerald-500/8'
                    : line.kind === 'delete'
                      ? 'bg-red-500/8'
                      : ''

                  const prefixClass = line.kind === 'add'
                    ? 'text-emerald-300'
                    : line.kind === 'delete'
                      ? 'text-red-300'
                      : 'text-text-muted'

                  const plainClass = line.kind === 'context' ? 'text-text-muted' : ''
                  const prefix = line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '

                  // Reactive getter so it updates when tokenCache changes
                  const tokens = () => props.tokens.get(line.content)

                  return (
                    <div class={`flex font-mono text-[11px] leading-5 ${bgClass}`}>
                      {/* Old line number */}
                      <span class="w-10 text-right pr-1 text-text-dim/50 select-none shrink-0 text-[10px]">
                        {line.oldLineNumber ?? ''}
                      </span>
                      {/* New line number */}
                      <span class="w-10 text-right pr-2 text-text-dim/50 select-none shrink-0 text-[10px]">
                        {line.newLineNumber ?? ''}
                      </span>
                      {/* Prefix */}
                      <span class={`w-4 text-center select-none shrink-0 ${prefixClass}`}>
                        {prefix}
                      </span>
                      {/* Content */}
                      <span class={`flex-1 min-w-0 pr-3 ${props.wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'} ${plainClass}`}>
                        <Show when={tokens()} fallback={line.content}>
                          <For each={tokens()!}>
                            {(tok) => (
                              <span style={tok.color ? { color: tok.color } : undefined}>
                                {tok.content}
                              </span>
                            )}
                          </For>
                        </Show>
                      </span>
                    </div>
                  )
                }}
              </For>

              {/* Expand below last hunk — only if we haven't reached EOF */}
              <Show when={i() === props.diff.hunks.length - 1 && (() => {
                const lastLine = hunk.lines.reduce((max, l) => l.newLineNumber ? Math.max(max, l.newLineNumber) : max, 0)
                return lastLine < props.diff.totalLines
              })()}>
                <ExpandButton onClick={() => props.onExpandBelow(i())} label="Load more" direction="down" />
              </Show>
            </div>
          )
        }}
      </For>
      </div>

      <Show when={props.diff.hunks.length === 0}>
        <div class="px-4 py-3 text-xs text-text-dim text-center">
          No diff available (binary file?)
        </div>
      </Show>
    </div>
  )
}
