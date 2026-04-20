import { Component, createSignal, createEffect, on, Show, For } from 'solid-js'
import { ChevronDown, ChevronRight, RefreshCw, X, GitCommit, Circle, GitCompare, FileText, ClipboardCopy, FolderOpen, ExternalLink, Tag } from 'lucide-solid'
import { diffTabKey } from '../store/files'
import { openDiffTab, openFilePinned, revealFileInTree, mainView, type DiffSource } from '../store/editorView'
import { selectedTaskId } from '../store/ui'
import { taskById } from '../store/tasks'
import { clsx } from 'clsx'
import { getFileIcon } from '../lib/fileIcons'
import { taskGit, refreshTaskGit } from '../store/git'
import * as ipc from '../lib/ipc'
import type { GitStatus } from '../types'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

interface Props {
  taskId: string
}

const STATUS_LETTERS: Record<string, string> = {
  M: 'M',
  A: 'A',
  D: 'D',
  R: 'R',
  '?': 'U',
}

const STATUS_COLORS: Record<string, string> = {
  M: 'text-amber-400',
  A: 'text-emerald-400',
  D: 'text-red-400',
  R: 'text-blue-400',
  '?': 'text-emerald-400',
}

export const CodeChanges: Component<Props> = (props) => {
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
    refreshTaskGit(props.taskId)
  }))

  const sourceForRow = (): DiffSource => {
    const commit = selectedCommit()
    return commit ? { type: 'commit', commitHash: commit } : { type: 'working' }
  }

  const openDiff = (path: string, opts?: { pinned?: boolean }) => {
    openDiffTab(props.taskId, path, sourceForRow(), opts)
  }

  const isRowActive = (path: string) => {
    const tid = selectedTaskId()
    if (!tid || tid !== props.taskId) return false
    return mainView(tid) === diffTabKey(sourceForRow(), path)
  }

  const statsForFile = (path: string) => {
    return status()?.stats.find(s => s.path === path)
  }

  // ── File row context menu ─────────────────────────────────────────────
  const [fileMenu, setFileMenu] = createSignal<{ x: number; y: number; path: string } | null>(null)
  const closeFileMenu = () => setFileMenu(null)

  const fullPath = (rel: string) => {
    const t = taskById(props.taskId)
    return t?.worktreePath ? `${t.worktreePath}/${rel}` : rel
  }

  const fileMenuItems = (): ContextMenuItem[] => {
    const m = fileMenu()
    if (!m) return []
    const path = m.path
    const name = path.split('/').pop() || path
    return [
      { label: 'Open Diff', icon: GitCompare, action: () => { openDiff(path, { pinned: true }); closeFileMenu() } },
      { label: 'Open File', icon: FileText, action: () => { openFilePinned(props.taskId, path, name); closeFileMenu() } },
      { label: 'Open in VS Code', icon: ExternalLink, action: () => { ipc.openInApp(fullPath(path), 'Visual Studio Code'); closeFileMenu() } },
      { separator: true },
      { label: 'Reveal in File Tree', icon: FolderOpen, action: () => { revealFileInTree(props.taskId, path); closeFileMenu() } },
      { label: 'Reveal in Finder', icon: FolderOpen, action: () => { ipc.openInFinder(fullPath(path)); closeFileMenu() } },
      { separator: true },
      { label: 'Copy Name', icon: Tag, action: () => { navigator.clipboard.writeText(name); closeFileMenu() } },
      { label: 'Copy Relative Path', icon: ClipboardCopy, action: () => { navigator.clipboard.writeText(path); closeFileMenu() } },
      { label: 'Copy Absolute Path', icon: ClipboardCopy, action: () => { navigator.clipboard.writeText(fullPath(path)); closeFileMenu() } },
    ]
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
      {/* Header — title + stats on the left, view toggles on the right */}
      <div class="flex items-center justify-between px-3 h-9 bg-surface-1">
        <div class="flex items-center gap-2 text-xs text-text-muted min-w-0">
          <span class="font-medium text-text-secondary shrink-0">
            {selectedCommit() ? 'Commit' : 'Changes'}
          </span>
          <Show when={selectedCommit() && selectedCommitInfo()}>
            <span class="font-mono text-text-dim truncate">{selectedCommitInfo()!.shortHash}</span>
          </Show>
          <Show when={status()}>
            <span class="text-text-dim shrink-0 tabular-nums">
              {status()!.files.length} file{status()!.files.length !== 1 ? 's' : ''}
            </span>
            <Show when={status()!.totalInsertions > 0}>
              <span class="text-emerald-400 shrink-0 tabular-nums">+{status()!.totalInsertions}</span>
            </Show>
            <Show when={status()!.totalDeletions > 0}>
              <span class="text-red-400 shrink-0 tabular-nums">-{status()!.totalDeletions}</span>
            </Show>
          </Show>
        </div>

        <div class="flex items-center gap-0.5 shrink-0">
          <button
            class="p-1 rounded text-text-dim hover:text-text-secondary hover:bg-surface-3 disabled:opacity-40"
            onClick={refresh}
            disabled={loading()}
            title="Refresh"
          >
            <RefreshCw size={12} class={loading() ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Error */}
      <Show when={error()}>
        <div class="px-3 py-2 text-xs text-red-400 bg-red-400/5 border-b-1 border-b-solid border-b-outline/8 flex items-center justify-between">
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
              <p class="text-xs text-text-dim">File modifications will appear here as the agent works.</p>
            </Show>
          </div>
        </Show>

        <For each={status()?.files || []}>
          {(file) => {
            const fileName = file.path.split('/').pop() || file.path
            const FileIcon = getFileIcon(fileName)
            const statusLetter = STATUS_LETTERS[file.status] || '?'
            const statusColor = STATUS_COLORS[file.status] || 'text-text-muted'
            const stats = () => statsForFile(file.path)
            const active = () => isRowActive(file.path)

            return (
              <div
                class={`relative flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs ${
                  active()
                    ? 'bg-surface-2 text-text-primary'
                    : 'hover:bg-surface-2 text-text-secondary'
                }`}
                style={active() ? { 'box-shadow': 'inset 2px 0 0 #2d6e4f' } : undefined}
                onClick={() => openDiff(file.path)}
                onDblClick={(e) => { e.stopPropagation(); openDiff(file.path, { pinned: true }) }}
                onContextMenu={(e) => { e.preventDefault(); setFileMenu({ x: e.clientX, y: e.clientY, path: file.path }) }}
              >
                <span class="shrink-0 text-text-dim">
                  <FileIcon size={12} />
                </span>

                <span class="truncate flex-1">
                  {file.path}
                </span>

                <Show when={stats()}>
                  <span class="shrink-0 flex items-center gap-1.5 text-[10px] tabular-nums">
                    <Show when={stats()!.insertions > 0}>
                      <span class="text-emerald-400">+{stats()!.insertions}</span>
                    </Show>
                    <Show when={stats()!.deletions > 0}>
                      <span class="text-red-400">-{stats()!.deletions}</span>
                    </Show>
                  </span>
                </Show>

                <span class={`shrink-0 text-[11px] font-medium tabular-nums w-3 text-center ${statusColor}`}>
                  {statusLetter}
                </span>
              </div>
            )
          }}
        </For>
      </div>

      {/* Branch commits — collapsible, bottom-aligned like VS Code */}
      <div class="h-px bg-outline/8 shrink-0" />
      <div class="shrink-0">
        <button
          class="w-full h-8 flex items-center gap-1.5 px-3 text-xs hover:bg-surface-2"
          onClick={toggleCommitsPanel}
        >
          {commitsOpen() ? <ChevronDown size={12} class="text-text-dim shrink-0" /> : <ChevronRight size={12} class="text-text-dim shrink-0" />}
          <GitCommit size={12} class="text-text-dim shrink-0" />
          <span class="font-medium text-text-secondary">Branch Commits</span>
          <Show when={commits().length > 0}>
            <span class="text-text-dim text-[10px] tabular-nums">
              {commits().length}
            </span>
          </Show>
        </button>

        {/* Commits list */}
        <Show when={commitsOpen()}>
          <div class="max-h-48 overflow-auto">
            {/* Uncommitted changes tile */}
            <button
              class={clsx(
                'relative w-full flex items-center gap-2 px-3 py-1.5 text-xs',
                selectedCommit() === null
                  ? 'bg-surface-2 text-text-primary'
                  : 'hover:bg-surface-2 text-text-secondary',
              )}
              style={selectedCommit() === null ? { 'box-shadow': 'inset 2px 0 0 #2d6e4f' } : undefined}
              onClick={() => selectCommit(null)}
            >
              <Circle size={11} class="shrink-0 text-text-dim" />
              <span class="truncate flex-1 text-left">Uncommitted changes</span>
              <Show when={uncommittedCount() > 0}>
                <span class="text-[10px] text-text-dim shrink-0">{uncommittedCount()} file{uncommittedCount() !== 1 ? 's' : ''}</span>
              </Show>
            </button>

            <For each={commits()}>
              {(commit) => {
                const isSelected = () => selectedCommit() === commit.hash
                return (
                  <button
                    class={clsx(
                      'relative w-full flex items-center gap-2 px-3 py-1.5 text-xs',
                      isSelected() ? 'bg-surface-2 text-text-primary' : 'hover:bg-surface-2 text-text-secondary',
                    )}
                    style={isSelected() ? { 'box-shadow': 'inset 2px 0 0 #2d6e4f' } : undefined}
                    onClick={() => selectCommit(commit.hash)}
                  >
                    <span class="font-mono text-text-dim text-[10px] shrink-0">{commit.shortHash}</span>
                    <span class="truncate flex-1 text-left">{commit.message}</span>
                    <span class="text-[10px] text-text-dim shrink-0">{formatTime(commit.timestamp)}</span>
                  </button>
                )
              }}
            </For>

            <Show when={commits().length === 0 && !loading()}>
              <div class="px-3 py-3 text-[11px] text-text-dim text-center">
                No commits on this branch yet
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <ContextMenu
        open={!!fileMenu()}
        onClose={closeFileMenu}
        pos={fileMenu() ? { x: fileMenu()!.x, y: fileMenu()!.y } : undefined}
        minWidth="min-w-44"
        items={fileMenuItems()}
      />
    </div>
  )
}
