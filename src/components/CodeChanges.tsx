import { Component, createSignal, createMemo, createEffect, on, Show } from 'solid-js'
import { GitCompare, FileText, ClipboardCopy, FolderOpen, ExternalLink, Tag, Plus, Minus, X } from 'lucide-solid'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ChangesHeader } from './ChangesHeader'
import { FileSection, type SectionKind, type BulkAction } from './FileSection'
import { FileRow } from './FileRow'
import { CommitComposer } from './CommitComposer'
import { ConflictStageDialog, type ConflictChoice } from './ConflictStageDialog'
import { BranchCommits } from './BranchCommits'
import { fanOut, type FileEntry } from '../lib/gitStatus'
import { taskGit, refreshTaskGit } from '../store/git'
import { taskById } from '../store/tasks'
import { selectedTaskId } from '../store/ui'
import { openDiffTab, openFilePinned, revealFileInTree, mainView, type DiffSource } from '../store/editorView'
import { diffTabKey } from '../store/files'
import * as ipc from '../lib/ipc'
import {
  stageOne, unstageOne, discardOne, resolveConflict, stageConflictAsIs,
  stageAll, unstageAll, discardAllUnstaged,
  commitWithFallback, commitAndPush, commitAmend,
} from '../store/changesActions'
import type { GitStatus } from '../types'

interface Props { taskId: string }

export const CodeChanges: Component<Props> = (props) => {
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [selectedCommit, setSelectedCommit] = createSignal<string | null>(null)
  const [commitStatus, setCommitStatus] = createSignal<GitStatus | null>(null)
  const [conflictDialogPath, setConflictDialogPath] = createSignal<string | null>(null)
  const [bulkInflight, setBulkInflight] = createSignal<SectionKind | null>(null)

  const liveStatus = (): GitStatus | null =>
    selectedCommit() ? commitStatus() : taskGit(props.taskId).status

  const statsByPath = createMemo(() => {
    const map = new Map<string, { insertions: number; deletions: number }>()
    for (const s of liveStatus()?.stats ?? []) map.set(s.path, s)
    return map
  })

  const allEntries = createMemo<FileEntry[]>(() => {
    const files = liveStatus()?.files ?? []
    return files.flatMap(fanOut)
  })

  const conflicts = () => allEntries().filter(e => e.kind === 'conflict')
  const stagedEntries = () => allEntries().filter(e => e.kind === 'staged')
  const unstagedEntries = () => allEntries().filter(e => e.kind === 'unstaged')

  const refresh = async () => {
    try {
      setLoading(true); setError(null)
      await refreshTaskGit(props.taskId, { force: true })
    } catch (e: unknown) { setError(e?.toString() || 'Failed to load status') }
    finally { setLoading(false) }
  }

  const selectCommit = async (hash: string | null) => {
    setSelectedCommit(hash)
    if (hash === null) setCommitStatus(null)
    else {
      try { setCommitStatus(await ipc.getCommitFiles(props.taskId, hash)) }
      catch { /* ignore */ }
    }
  }

  createEffect(on(() => props.taskId, () => {
    setSelectedCommit(null)
    setCommitStatus(null)
    refreshTaskGit(props.taskId)
    ipc.watchWorktree(props.taskId)
  }))

  // Diff source per row kind
  const sourceForEntry = (entry: FileEntry): DiffSource => {
    if (selectedCommit()) return { type: 'commit', commitHash: selectedCommit()! }
    if (entry.kind === 'staged') return { type: 'staged' }
    if (entry.kind === 'unstaged' && entry.file.indexStatus === '?') return { type: 'working' }
    if (entry.kind === 'unstaged') return { type: 'unstaged' }
    return { type: 'working' }  // conflict
  }

  const isRowActive = (entry: FileEntry) => {
    const tid = selectedTaskId()
    if (!tid || tid !== props.taskId) return false
    return mainView(tid) === diffTabKey(sourceForEntry(entry), entry.file.path)
  }

  const openDiff = (entry: FileEntry, opts?: { pinned?: boolean }) =>
    openDiffTab(props.taskId, entry.file.path, sourceForEntry(entry), opts)

  const openFile = (entry: FileEntry) =>
    openFilePinned(props.taskId, entry.file.path, entry.file.path.split('/').pop() || entry.file.path)

  const onPrimary = async (entry: FileEntry) => {
    if (entry.kind === 'conflict') { setConflictDialogPath(entry.file.path); return }
    if (entry.kind === 'staged') await unstageOne(props.taskId, entry.file.path)
    else await stageOne(props.taskId, entry.file.path)
  }

  const onDiscard = async (entry: FileEntry) => {
    await discardOne(props.taskId, entry.file.path)
  }

  const onConflictChoice = async (choice: ConflictChoice) => {
    const path = conflictDialogPath()
    if (!path) return
    setConflictDialogPath(null)
    if (choice === 'ours' || choice === 'theirs') {
      await resolveConflict(props.taskId, path, choice)
    } else {
      await stageConflictAsIs(props.taskId, path)
    }
  }

  const runBulk = async (kind: SectionKind, fn: () => Promise<void>) => {
    setBulkInflight(kind)
    try { await fn() } finally { setBulkInflight(null) }
  }

  const conflictBulk: BulkAction[] = []
  const stagedBulk = (): BulkAction[] => [
    { icon: Minus, title: 'Unstage all', onClick: () => runBulk('staged', () => unstageAll(props.taskId)) },
  ]
  const changesBulk = (): BulkAction[] => [
    { icon: Plus, title: 'Stage all', onClick: () => runBulk('changes', () => stageAll(props.taskId)) },
    {
      icon: X,
      title: 'Discard all',
      onClick: () => runBulk('changes', async () => {
        if (window.confirm('Discard all unstaged changes? This cannot be undone.')) {
          await discardAllUnstaged(props.taskId)
        }
      }),
    },
  ]

  const onJumpToSection = (kind: SectionKind) => {
    localStorage.setItem(`verun:changes:section:${kind}:open`, 'true')
    refreshTaskGit(props.taskId, { force: true })
  }

  const canCommit = () => conflicts().length === 0 && allEntries().length > 0
  const canAmend = () => taskGit(props.taskId).commits.length > 0
  const amendDefault = () => taskGit(props.taskId).commits[0]?.message ?? ''
  const onCommit = (msg: string) => commitWithFallback(props.taskId, msg, stagedEntries().length > 0)
  const onCommitAndPush = async (msg: string) => commitAndPush(props.taskId, msg)
  const onAmend = (msg: string) => commitAmend(props.taskId, msg)

  const [fileMenu, setFileMenu] = createSignal<{ x: number; y: number; entry: FileEntry } | null>(null)
  const closeFileMenu = () => setFileMenu(null)
  const fullPath = (rel: string) => {
    const t = taskById(props.taskId)
    return t?.worktreePath ? `${t.worktreePath}/${rel}` : rel
  }
  const fileMenuItems = (): ContextMenuItem[] => {
    const m = fileMenu()
    if (!m) return []
    const e = m.entry
    const path = e.file.path
    const name = path.split('/').pop() || path
    const items: ContextMenuItem[] = [
      { label: 'Open Diff',       icon: GitCompare,   action: () => { openDiff(e, { pinned: true }); closeFileMenu() } },
      { label: 'Open File',       icon: FileText,     action: () => { openFile(e); closeFileMenu() } },
      { label: 'Open in VS Code', icon: ExternalLink, action: () => { ipc.openInApp(fullPath(path), 'Visual Studio Code'); closeFileMenu() } },
      { separator: true },
    ]
    if (e.kind === 'conflict') {
      items.push({ label: 'Stage…',  icon: Plus,  action: () => { setConflictDialogPath(path); closeFileMenu() } })
    } else if (e.kind === 'staged') {
      items.push({ label: 'Unstage', icon: Minus, action: () => { unstageOne(props.taskId, path); closeFileMenu() } })
    } else {
      items.push({ label: 'Stage',   icon: Plus,  action: () => { stageOne(props.taskId, path); closeFileMenu() } })
    }
    if (e.kind !== 'conflict') {
      items.push({ label: 'Discard', icon: X, action: () => { discardOne(props.taskId, path); closeFileMenu() } })
    }
    items.push(
      { separator: true },
      { label: 'Reveal in File Tree', icon: FolderOpen,    action: () => { revealFileInTree(props.taskId, path); closeFileMenu() } },
      { label: 'Reveal in Finder',    icon: FolderOpen,    action: () => { ipc.openInFinder(fullPath(path)); closeFileMenu() } },
      { separator: true },
      { label: 'Copy Name',           icon: Tag,           action: () => { navigator.clipboard.writeText(name); closeFileMenu() } },
      { label: 'Copy Relative Path',  icon: ClipboardCopy, action: () => { navigator.clipboard.writeText(path); closeFileMenu() } },
      { label: 'Copy Absolute Path',  icon: ClipboardCopy, action: () => { navigator.clipboard.writeText(fullPath(path)); closeFileMenu() } },
    )
    return items
  }

  const renderRow = (entry: FileEntry) => {
    const stats = statsByPath().get(entry.file.path)
    return (
      <FileRow
        entry={entry}
        active={isRowActive(entry)}
        insertions={stats?.insertions}
        deletions={stats?.deletions}
        onOpenDiff={() => openDiff(entry)}
        onOpenDiffPinned={() => openDiff(entry, { pinned: true })}
        onOpenFile={() => openFile(entry)}
        onPrimary={() => onPrimary(entry)}
        onDiscard={() => onDiscard(entry)}
        onContextMenu={(e: MouseEvent) => { e.preventDefault(); setFileMenu({ x: e.clientX, y: e.clientY, entry }) }}
      />
    )
  }

  const selectedCommitInfo = () =>
    taskGit(props.taskId).commits.find(c => c.hash === selectedCommit())

  return (
    <div class="flex flex-col h-full overflow-hidden min-w-0">
      <ChangesHeader
        conflicts={conflicts().length}
        staged={stagedEntries().length}
        changes={unstagedEntries().length}
        totalInsertions={liveStatus()?.totalInsertions ?? 0}
        totalDeletions={liveStatus()?.totalDeletions ?? 0}
        loading={loading()}
        selectedCommitShortHash={selectedCommit() ? selectedCommitInfo()?.shortHash : undefined}
        onRefresh={refresh}
        onJumpToSection={onJumpToSection}
      />

      <Show when={error()}>
        <div class="px-3 py-2 text-xs text-red-400 bg-red-400/5 border-b-1 border-b-solid border-b-outline/8 flex items-center justify-between">
          <span class="truncate">{error()}</span>
          <button class="shrink-0 ml-2" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      </Show>

      <div class="flex-1 overflow-auto flex flex-col min-h-0">
        <FileSection
          kind="conflicts"
          title="Conflicts"
          entries={conflicts()}
          renderRow={renderRow}
          bulkActions={conflictBulk}
          bulkInflight={bulkInflight() === 'conflicts'}
        />
        <FileSection
          kind="staged"
          title="Staged Changes"
          entries={stagedEntries()}
          renderRow={renderRow}
          bulkActions={stagedBulk()}
          bulkInflight={bulkInflight() === 'staged'}
        />
        <FileSection
          kind="changes"
          title="Changes"
          entries={unstagedEntries()}
          renderRow={renderRow}
          bulkActions={changesBulk()}
          bulkInflight={bulkInflight() === 'changes'}
        />

        <Show when={allEntries().length === 0 && !loading() && !selectedCommit()}>
          <div class="px-4 py-10 text-center">
            <p class="text-sm text-text-muted mb-1">No changes yet</p>
            <p class="text-xs text-text-dim">File modifications will appear here as the agent works.</p>
          </div>
        </Show>
      </div>

      <Show when={!selectedCommit()}>
        <CommitComposer
          taskId={props.taskId}
          canCommit={canCommit()}
          canAmend={canAmend()}
          amendDefaultMessage={amendDefault()}
          onCommit={onCommit}
          onCommitAndPush={onCommitAndPush}
          onAmend={onAmend}
        />
      </Show>

      <BranchCommits
        taskId={props.taskId}
        selectedCommit={selectedCommit()}
        uncommittedCount={liveStatus()?.files.length ?? 0}
        onSelectCommit={selectCommit}
      />

      <ConflictStageDialog
        path={conflictDialogPath()}
        onChoose={onConflictChoice}
        onClose={() => setConflictDialogPath(null)}
      />

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
