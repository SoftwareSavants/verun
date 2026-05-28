import { Component, createSignal, createMemo, createEffect, on, Show } from 'solid-js'
import { GitCompare, FileText, ClipboardCopy, FolderOpen, ExternalLink, Tag, Plus, Minus, X, Undo2 } from 'lucide-solid'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { ChangesHeader } from './ChangesHeader'
import { FileSection, type SectionKind, type BulkAction } from './FileSection'
import { FileRow } from './FileRow'
import { CommitComposer, type CommitComposerApi } from './CommitComposer'
import { ConflictStageDialog, type ConflictChoice } from './ConflictStageDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { BranchCommits } from './BranchCommits'
import { type FileEntry } from '../lib/gitStatus'
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
  undoLastCommit, revertCommit,
} from '../store/changesActions'
import type { GitStatus, BranchCommit } from '../types'

interface Props { taskId: string }

export const CodeChanges: Component<Props> = (props) => {
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [selectedCommit, setSelectedCommit] = createSignal<string | null>(null)
  const [commitStatus, setCommitStatus] = createSignal<GitStatus | null>(null)
  const [conflictDialogPath, setConflictDialogPath] = createSignal<string | null>(null)
  // null = no dialog; 'all' = bulk discard; otherwise the path of the single file to discard
  const [discardTarget, setDiscardTarget] = createSignal<string | 'all' | null>(null)
  const [undoConfirm, setUndoConfirm] = createSignal(false)
  const [revertTarget, setRevertTarget] = createSignal<BranchCommit | null>(null)

  const liveStatus = (): GitStatus | null =>
    selectedCommit() ? commitStatus() : taskGit(props.taskId).status

  const statsByPath = createMemo(() => {
    const map = new Map<string, { insertions: number; deletions: number }>()
    for (const s of liveStatus()?.stats ?? []) map.set(s.path, s)
    return map
  })

  // Cache FileEntry wrappers by `${kind}:${path}` so the same logical row keeps
  // the same reference across memo recomputes. <For> keys by reference, so this
  // prevents row remounts on every store update (which would lose :hover state
  // and flicker the action buttons).
  const entryCache = new Map<string, FileEntry>()
  const allEntries = createMemo<FileEntry[]>(() => {
    const files = liveStatus()?.files ?? []
    const liveKeys = new Set<string>()
    const out: FileEntry[] = []
    const reuse = (file: typeof files[number], kind: FileEntry['kind']) => {
      const k = `${kind}:${file.path}`
      liveKeys.add(k)
      let entry = entryCache.get(k)
      if (!entry || entry.file !== file) {
        entry = { kind, file } as FileEntry
        entryCache.set(k, entry)
      }
      out.push(entry)
    }
    for (const file of files) {
      if (file.conflict) { reuse(file, 'conflict'); continue }
      if (file.indexStatus === '?' && file.worktreeStatus === '?') { reuse(file, 'unstaged'); continue }
      if (file.indexStatus !== ' ' && file.indexStatus !== '?') reuse(file, 'staged')
      if (file.worktreeStatus !== ' ' && file.worktreeStatus !== '?') reuse(file, 'unstaged')
    }
    for (const key of entryCache.keys()) {
      if (!liveKeys.has(key)) entryCache.delete(key)
    }
    return out
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

  const onDiscard = (entry: FileEntry) => {
    setDiscardTarget(entry.file.path)
  }

  const confirmDiscard = async () => {
    const target = discardTarget()
    setDiscardTarget(null)
    if (target === null) return
    if (target === 'all') await discardAllUnstaged(props.taskId)
    else await discardOne(props.taskId, target)
  }

  const discardDialogMessage = () => {
    const target = discardTarget()
    if (target === 'all') {
      return `Discard all ${unstagedEntries().length} unstaged change${unstagedEntries().length === 1 ? '' : 's'}? This cannot be undone.`
    }
    if (target) return `Discard changes in ${target}? This cannot be undone.`
    return ''
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

  // Read-only view: when the user is inspecting a past commit, working-tree
  // mutations (stage/unstage/discard, bulk + context-menu equivalents) make no
  // sense and would silently target the wrong files. Hide them all.
  const isCommitView = () => selectedCommit() !== null

  const conflictBulk: BulkAction[] = []
  const stagedBulk = (): BulkAction[] => isCommitView() ? [] : [
    { icon: Minus, title: 'Unstage all', onClick: () => unstageAll(props.taskId) },
  ]
  const changesBulk = (): BulkAction[] => isCommitView() ? [] : [
    { icon: Plus, title: 'Stage all', onClick: () => stageAll(props.taskId) },
    {
      icon: Undo2,
      title: 'Discard all',
      onClick: () => { setDiscardTarget('all') },
    },
  ]

  const sectionOpenKey = (kind: SectionKind) => `verun:changes:section:${kind}:open`
  const [sectionsOpen, setSectionsOpen] = createSignal<Record<SectionKind, boolean>>({
    conflicts: localStorage.getItem(sectionOpenKey('conflicts')) !== 'false',
    staged:    localStorage.getItem(sectionOpenKey('staged'))    !== 'false',
    changes:   localStorage.getItem(sectionOpenKey('changes'))   !== 'false',
  })
  const writeSectionOpen = (kind: SectionKind, value: boolean) => {
    setSectionsOpen(s => ({ ...s, [kind]: value }))
    localStorage.setItem(sectionOpenKey(kind), String(value))
  }
  const toggleSection = (kind: SectionKind) => writeSectionOpen(kind, !sectionsOpen()[kind])

  const canCommit = () => conflicts().length === 0 && allEntries().length > 0
  const canAmend = () => taskGit(props.taskId).commits.length > 0 && conflicts().length === 0
  const amendDefault = () => taskGit(props.taskId).commits[0]?.message ?? ''
  const onCommit = (msg: string) => commitWithFallback(props.taskId, msg, stagedEntries().length > 0)
  const onCommitAndPush = async (msg: string) => commitAndPush(props.taskId, msg)
  const onAmend = (msg: string) => commitAmend(props.taskId, msg)

  let composerApi: CommitComposerApi | undefined
  const runUndo = async () => {
    // Capture the last commit's message BEFORE the IPC so we can prefill the
    // composer on success without re-fetching.
    const last = taskGit(props.taskId).commits[0]
    const ok = await undoLastCommit(props.taskId)
    if (!ok) return
    // Drop any commit selection so the view returns to the working tree where
    // the undone changes are now staged (and the composer is visible again).
    selectCommit(null)
    if (last) composerApi?.setDraftIfEmpty(last.message)
  }
  // Working-tree file count, ignoring whatever commit the user might currently be viewing.
  const workingChangeCount = () => taskGit(props.taskId).status?.files.length ?? 0
  const onUndoLast = () => {
    // Confirm only if there are local files in the working tree that would be merged
    // with the undone commit's staged content (otherwise it's trivially reversible).
    if (workingChangeCount() > 0) {
      setUndoConfirm(true)
    } else {
      runUndo()
    }
  }
  const onRevertRequest = (commit: BranchCommit) => setRevertTarget(commit)
  const confirmUndo = () => {
    setUndoConfirm(false)
    runUndo()
  }
  const confirmRevert = () => {
    const c = revertTarget()
    setRevertTarget(null)
    if (c) revertCommit(props.taskId, c.hash)
  }

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
    ]
    if (!isCommitView()) {
      items.push({ separator: true })
      if (e.kind === 'conflict') {
        items.push({ label: 'Stage…',  icon: Plus,  action: () => { setConflictDialogPath(path); closeFileMenu() } })
      } else if (e.kind === 'staged') {
        items.push({ label: 'Unstage', icon: Minus, action: () => { unstageOne(props.taskId, path); closeFileMenu() } })
      } else {
        items.push({ label: 'Stage',   icon: Plus,  action: () => { stageOne(props.taskId, path); closeFileMenu() } })
      }
      if (e.kind !== 'conflict') {
        items.push({ label: 'Discard', icon: X, action: () => { setDiscardTarget(path); closeFileMenu() } })
      }
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
        onPrimary={isCommitView() ? undefined : () => onPrimary(entry)}
        onDiscard={isCommitView() ? undefined : () => onDiscard(entry)}
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
          open={sectionsOpen().conflicts}
          onToggle={() => toggleSection('conflicts')}
        />
        <FileSection
          kind="staged"
          title="Staged Changes"
          entries={stagedEntries()}
          renderRow={renderRow}
          bulkActions={stagedBulk()}
          open={sectionsOpen().staged}
          onToggle={() => toggleSection('staged')}
        />
        <FileSection
          kind="changes"
          title="Changes"
          entries={unstagedEntries()}
          renderRow={renderRow}
          bulkActions={changesBulk()}
          open={sectionsOpen().changes}
          onToggle={() => toggleSection('changes')}
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
          apiRef={(api) => { composerApi = api }}
        />
      </Show>

      <BranchCommits
        taskId={props.taskId}
        selectedCommit={selectedCommit()}
        uncommittedCount={liveStatus()?.files.length ?? 0}
        onSelectCommit={selectCommit}
        onUndoLastCommit={onUndoLast}
        onRevertCommit={onRevertRequest}
      />

      <ConflictStageDialog
        path={conflictDialogPath()}
        onChoose={onConflictChoice}
        onClose={() => setConflictDialogPath(null)}
      />

      <ConfirmDialog
        open={discardTarget() !== null}
        title={discardTarget() === 'all' ? 'Discard all changes?' : 'Discard changes?'}
        message={discardDialogMessage()}
        confirmLabel="Discard"
        danger
        onConfirm={confirmDiscard}
        onCancel={() => setDiscardTarget(null)}
      />

      <ConfirmDialog
        open={undoConfirm()}
        title="Undo last commit?"
        message={`Local changes are present. Undoing will move ${workingChangeCount()} local change${workingChangeCount() === 1 ? '' : 's'} into the same staging area as the undone commit's content. You won't lose any work, but the two sets of changes will be mixed together.`}
        confirmLabel="Undo"
        onConfirm={confirmUndo}
        onCancel={() => setUndoConfirm(false)}
      />

      <ConfirmDialog
        open={revertTarget() !== null}
        title="Revert this commit?"
        message={revertTarget()
          ? `This creates a new commit that undoes "${revertTarget()!.message}" (${revertTarget()!.shortHash}). The original commit stays in history. Conflicts may appear if newer commits depend on the reverted changes.`
          : ''}
        confirmLabel="Revert"
        onConfirm={confirmRevert}
        onCancel={() => setRevertTarget(null)}
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
