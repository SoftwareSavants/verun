import { Component, Show, For, createEffect, createSignal, onCleanup } from 'solid-js'
import { ChevronRight, ChevronDown, Folder, FolderOpen } from 'lucide-solid'
import { getFileIcon } from '../lib/fileIcons'
import { getDirContents, loadDirectory } from '../store/files'
import { openFilePinned } from '../store/editorView'
import type { FileEntry } from '../types'

// ── Helpers ──────────────────────────────────────────────────────────

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** Load directory contents, returning sorted entries. */
async function loadSorted(taskId: string, dir: string): Promise<FileEntry[]> {
  let cached = getDirContents(taskId, dir)
  if (!cached) {
    await loadDirectory(taskId, dir)
    cached = getDirContents(taskId, dir)
  }
  return cached ? sortEntries(cached) : []
}

// ── Tree node (recursive) ────────────────────────────────────────────

function TreeNode(props: {
  taskId: string
  entry: FileEntry
  depth: number
  expandedSet: Set<string>
  onToggle: (path: string) => void
  onPick: (entry: FileEntry) => void
  currentPath: string
}) {
  const isDir = () => props.entry.isDir
  const expanded = () => props.expandedSet.has(props.entry.relativePath)
  const isCurrent = () => props.entry.relativePath === props.currentPath

  const children = () => {
    if (!isDir() || !expanded()) return []
    const cached = getDirContents(props.taskId, props.entry.relativePath)
    return cached ? sortEntries(cached) : []
  }

  const handleClick = () => {
    if (isDir()) {
      props.onToggle(props.entry.relativePath)
    } else {
      props.onPick(props.entry)
    }
  }

  const Icon = () => {
    if (isDir()) {
      const I = expanded() ? FolderOpen : Folder
      return <I size={14} class="shrink-0 text-accent" />
    }
    const I = getFileIcon(props.entry.name)
    return <I size={14} class="shrink-0" />
  }

  return (
    <>
      <button
        data-current={isCurrent()}
        class="w-full flex items-center gap-1 py-0.5 text-[12px] text-left transition-colors"
        classList={{
          'bg-[#2c313a] text-text-secondary': isCurrent(),
          'text-[#abb2bf] hover:bg-[#2c313a]': !isCurrent(),
        }}
        style={{ 'padding-left': `${props.depth * 16 + 8}px`, 'padding-right': '12px' }}
        onClick={handleClick}
      >
        <span class="w-3 shrink-0 flex items-center justify-center">
          <Show when={isDir()}>
            {expanded()
              ? <ChevronDown size={10} class="text-text-dim" />
              : <ChevronRight size={10} class="text-text-dim" />
            }
          </Show>
        </span>
        <Icon />
        <span class="truncate ml-0.5">{props.entry.name}</span>
      </button>
      <Show when={isDir() && expanded()}>
        <For each={children()}>
          {(child) => (
            <TreeNode
              taskId={props.taskId}
              entry={child}
              depth={props.depth + 1}
              expandedSet={props.expandedSet}
              onToggle={props.onToggle}
              onPick={props.onPick}
              currentPath={props.currentPath}
            />
          )}
        </For>
      </Show>
    </>
  )
}

// ── Breadcrumb bar ───────────────────────────────────────────────────

export const BreadcrumbBar: Component<{
  taskId: string
  currentPath: string
  class?: string
}> = (props) => {
  const [openIdx, setOpenIdx] = createSignal(-1)
  const [entries, setEntries] = createSignal<FileEntry[]>([])
  const [dropPos, setDropPos] = createSignal<{ left: number; top: number }>({ left: 0, top: 0 })
  // Local expand state for the tree dropdown (independent from the sidebar FileTree)
  const [expandedSet, setExpandedSet] = createSignal<Set<string>>(new Set())

  let barRef: HTMLDivElement | undefined
  let dropRef: HTMLDivElement | undefined

  const parts = () => props.currentPath.split('/')
  const parentDirOf = (segmentIdx: number) => parts().slice(0, segmentIdx).join('/')

  const toggleExpand = async (path: string) => {
    const next = new Set(expandedSet())
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      // Ensure children are loaded
      if (!getDirContents(props.taskId, path)) {
        await loadDirectory(props.taskId, path)
      }
    }
    setExpandedSet(next)
  }

  const openDropdown = async (segmentIdx: number, btnEl: HTMLElement) => {
    if (openIdx() === segmentIdx) { setOpenIdx(-1); return }

    const parentDir = parentDirOf(segmentIdx)
    const sorted = await loadSorted(props.taskId, parentDir)
    setEntries(sorted)

    // Pre-expand the path to the current file
    const pathParts = parts()
    const toExpand = new Set<string>()
    // Expand each ancestor directory that's a child of the dropdown's parent
    for (let i = segmentIdx; i < pathParts.length - 1; i++) {
      const ancestorPath = pathParts.slice(0, i + 1).join('/')
      toExpand.add(ancestorPath)
      // Ensure each expanded dir is loaded
      if (!getDirContents(props.taskId, ancestorPath)) {
        await loadDirectory(props.taskId, ancestorPath)
      }
    }
    setExpandedSet(toExpand)

    const rect = btnEl.getBoundingClientRect()
    setDropPos({ left: rect.left, top: rect.bottom + 2 })
    setOpenIdx(segmentIdx)
  }

  const close = () => setOpenIdx(-1)

  const handlePick = (entry: FileEntry) => {
    close()
    openFilePinned(props.taskId, entry.relativePath, entry.name)
  }

  // Close on click outside
  const onPointerDown = (e: PointerEvent) => {
    if (dropRef?.contains(e.target as Node)) return
    if (barRef?.contains(e.target as Node)) return
    close()
  }
  createEffect(() => {
    if (openIdx() >= 0) document.addEventListener('pointerdown', onPointerDown)
    else document.removeEventListener('pointerdown', onPointerDown)
  })
  onCleanup(() => document.removeEventListener('pointerdown', onPointerDown))

  const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  createEffect(() => {
    if (openIdx() >= 0) document.addEventListener('keydown', onKeyDown)
    else document.removeEventListener('keydown', onKeyDown)
  })
  onCleanup(() => document.removeEventListener('keydown', onKeyDown))

  const scrollToCurrent = (el: HTMLDivElement) => {
    requestAnimationFrame(() => {
      const active = el.querySelector('[data-current="true"]') as HTMLElement | null
      if (active) active.scrollIntoView({ block: 'nearest' })
    })
  }

  return (
    <div
      ref={barRef}
      class={props.class ?? 'flex items-center gap-0.5 text-[11px] text-text-dim overflow-hidden'}
    >
      <For each={parts()}>
        {(segment, i) => (
          <>
            <Show when={i() > 0}>
              <ChevronRight size={10} class="shrink-0 text-text-dim/50" />
            </Show>
            <button
              class="bc-seg shrink-0 hover:text-text-secondary cursor-pointer rounded px-0.5 transition-colors"
              classList={{
                'text-text-secondary': i() === parts().length - 1,
                'bg-[#2c313a]': openIdx() === i(),
              }}
              onClick={(e) => openDropdown(i(), e.currentTarget)}
            >
              {segment}
            </button>
          </>
        )}
      </For>

      <Show when={openIdx() >= 0}>
        <div
          ref={(el) => { dropRef = el; scrollToCurrent(el) }}
          class="fixed z-100 bg-[#21252b] border border-[#181a1f] rounded-lg py-1 min-w-56 max-h-80 overflow-y-auto"
          style={{
            left: `${dropPos().left}px`,
            top: `${dropPos().top}px`,
            'box-shadow': '0 6px 24px rgba(0,0,0,0.5)',
          }}
        >
          <For each={entries()}>
            {(entry) => (
              <TreeNode
                taskId={props.taskId}
                entry={entry}
                depth={0}
                expandedSet={expandedSet()}
                onToggle={toggleExpand}
                onPick={handlePick}
                currentPath={props.currentPath}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
