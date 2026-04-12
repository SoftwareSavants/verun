import { Component, For, Show, createEffect, on, onCleanup, onMount, createSignal } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import { Folder, FolderOpen, ChevronRight, ChevronDown } from 'lucide-solid'
import { fileHasErrors, fileHasWarnings, pathHasErrors, pathHasWarnings } from '../store/problems'
import { getFileIcon } from '../lib/fileIcons'
import {
  getDirContents, loadDirectory, isExpanded, toggleExpanded, expandDir, collapseDir,
  invalidateDirectory, openFile, openFilePinned, revealRequest, mainView
} from '../store/files'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import { registerDismissable } from '../lib/dismissable'
import type { FileEntry, FileTreeChangedEvent } from '../types'

interface Props {
  taskId: string
}

interface FlatNode {
  entry: FileEntry
  depth: number
}

interface ContextMenuState {
  x: number
  y: number
  entry: FileEntry
}

// getFileIcon imported from ../lib/fileIcons

export const FileTree: Component<Props> = (props) => {
  let scrollRef: HTMLDivElement | undefined
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null)
  const [selectedIndex, setSelectedIndex] = createSignal(-1)

  // Load root directory on mount
  onMount(() => {
    loadDirectory(props.taskId, '')
    ipc.watchWorktree(props.taskId)
  })

  // Listen for file system changes
  const unlistenPromise = listen<FileTreeChangedEvent>('file-tree-changed', (event) => {
    if (event.payload.taskId === props.taskId) {
      invalidateDirectory(props.taskId, event.payload.path)
    }
  })

  onCleanup(() => {
    unlistenPromise.then(fn => fn())
  })

  // Reload root when task changes
  createEffect(on(() => props.taskId, (taskId) => {
    loadDirectory(taskId, '')
    ipc.watchWorktree(taskId)
  }))

  // Close context menu on click outside
  let menuRef: HTMLDivElement | undefined
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

  // Build flattened node list from expanded state
  const flatNodes = (): FlatNode[] => {
    const nodes: FlatNode[] = []
    const buildLevel = (relativePath: string, depth: number) => {
      const entries = getDirContents(props.taskId, relativePath)
      if (!entries) return
      for (const entry of entries) {
        nodes.push({ entry, depth })
        if (entry.isDir && isExpanded(props.taskId, entry.relativePath)) {
          buildLevel(entry.relativePath, depth + 1)
        }
      }
    }
    buildLevel('', 0)
    return nodes
  }

  const virtualizer = createVirtualizer({
    get count() { return flatNodes().length },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => 24,
    overscan: 10,
  })

  // Reveal file in tree — scroll to it after expanded dirs settle
  createEffect(() => {
    const req = revealRequest()
    if (!req || req.taskId !== props.taskId) return
    setTimeout(() => {
      const nodes = flatNodes()
      const idx = nodes.findIndex(n => n.entry.relativePath === req.relativePath)
      if (idx >= 0 && scrollRef) {
        const rowHeight = 24
        const containerHeight = scrollRef.clientHeight
        const targetTop = idx * rowHeight
        const currentTop = scrollRef.scrollTop
        // Skip scroll if the item is already visible in the viewport
        const visibleTop = currentTop
        const visibleBottom = currentTop + containerHeight
        if (targetTop >= visibleTop && targetTop + rowHeight <= visibleBottom) return
        scrollRef.scrollTop = targetTop - containerHeight / 2 + rowHeight / 2
      }
    }, 50)
  })

  const handleClick = (entry: FileEntry) => {
    if (entry.isDir) {
      toggleExpanded(props.taskId, entry.relativePath)
      if (!getDirContents(props.taskId, entry.relativePath)) {
        loadDirectory(props.taskId, entry.relativePath)
      }
    } else {
      // Single click → preview tab (replaces existing preview)
      openFile(props.taskId, entry.relativePath, entry.name)
    }
  }

  const handleDoubleClick = (entry: FileEntry) => {
    if (!entry.isDir) {
      // Double click → pin the tab (make it permanent)
      openFilePinned(props.taskId, entry.relativePath, entry.name)
    }
  }

  // ── Context menu actions ───────────────────────────────────────────
  const getFullPath = async (relativePath: string) => {
    const task = await ipc.getTask(props.taskId)
    return task ? `${task.worktreePath}/${relativePath}` : relativePath
  }

  const handleOpenFile = () => {
    const menu = contextMenu()
    if (!menu) return
    openFilePinned(props.taskId, menu.entry.relativePath, menu.entry.name)
    setContextMenu(null)
  }

  const handleCopyPath = () => {
    const menu = contextMenu()
    if (!menu) return
    navigator.clipboard.writeText(menu.entry.relativePath)
    setContextMenu(null)
  }

  const handleCopyAbsPath = async () => {
    const menu = contextMenu()
    if (!menu) return
    const full = await getFullPath(menu.entry.relativePath)
    navigator.clipboard.writeText(full)
    setContextMenu(null)
  }

  const handleRevealInFinder = async () => {
    const menu = contextMenu()
    if (!menu) return
    const full = await getFullPath(menu.entry.relativePath)
    ipc.openInFinder(full)
    setContextMenu(null)
  }

  const handleOpenInEditor = async () => {
    const menu = contextMenu()
    if (!menu) return
    const full = await getFullPath(menu.entry.relativePath)
    ipc.openInApp(full, 'Visual Studio Code')
    setContextMenu(null)
  }

  const handleRefresh = () => {
    const menu = contextMenu()
    if (!menu) return
    if (menu.entry.isDir) {
      loadDirectory(props.taskId, menu.entry.relativePath)
    } else {
      // Refresh parent directory
      const parent = menu.entry.relativePath.includes('/')
        ? menu.entry.relativePath.substring(0, menu.entry.relativePath.lastIndexOf('/'))
        : ''
      loadDirectory(props.taskId, parent)
    }
    setContextMenu(null)
  }

  const handleCollapseFolder = () => {
    const menu = contextMenu()
    if (!menu || !menu.entry.isDir) return
    collapseDir(props.taskId, menu.entry.relativePath)
    setContextMenu(null)
  }

  const handleExpandFolder = () => {
    const menu = contextMenu()
    if (!menu || !menu.entry.isDir) return
    toggleExpanded(props.taskId, menu.entry.relativePath)
    if (!getDirContents(props.taskId, menu.entry.relativePath)) {
      loadDirectory(props.taskId, menu.entry.relativePath)
    }
    setContextMenu(null)
  }

  const handleCopyName = () => {
    const menu = contextMenu()
    if (!menu) return
    navigator.clipboard.writeText(menu.entry.name)
    setContextMenu(null)
  }

  const scrollToIndex = (idx: number) => {
    if (!scrollRef) return
    const rowHeight = 24
    const containerHeight = scrollRef.clientHeight
    const targetTop = idx * rowHeight
    const visibleTop = scrollRef.scrollTop
    const visibleBottom = visibleTop + containerHeight
    if (targetTop >= visibleTop && targetTop + rowHeight <= visibleBottom) return
    scrollRef.scrollTop = targetTop - containerHeight / 2 + rowHeight / 2
  }

  const parentDir = (relativePath: string) => {
    const lastSlash = relativePath.lastIndexOf('/')
    return lastSlash > 0 ? relativePath.substring(0, lastSlash) : ''
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    const nodes = flatNodes()
    if (nodes.length === 0) return
    const idx = selectedIndex()
    const node = idx >= 0 && idx < nodes.length ? nodes[idx] : null

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = Math.min(idx + 1, nodes.length - 1)
        setSelectedIndex(next)
        scrollToIndex(next)
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const next = Math.max(idx - 1, 0)
        setSelectedIndex(next)
        scrollToIndex(next)
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        if (!node) break
        if (node.entry.isDir && isExpanded(props.taskId, node.entry.relativePath)) {
          // Expanded dir — collapse it
          collapseDir(props.taskId, node.entry.relativePath)
        } else {
          // File or collapsed dir — jump to parent dir
          const parent = parentDir(node.entry.relativePath)
          const parentIdx = nodes.findIndex(n => n.entry.relativePath === parent && n.entry.isDir)
          if (parentIdx >= 0) {
            setSelectedIndex(parentIdx)
            scrollToIndex(parentIdx)
          }
        }
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        if (!node || !node.entry.isDir) break
        if (!isExpanded(props.taskId, node.entry.relativePath)) {
          // Collapsed — expand it
          expandDir(props.taskId, node.entry.relativePath)
          if (!getDirContents(props.taskId, node.entry.relativePath)) {
            loadDirectory(props.taskId, node.entry.relativePath)
          }
        } else {
          // Already expanded — move to first child
          const next = idx + 1
          if (next < flatNodes().length) {
            setSelectedIndex(next)
            scrollToIndex(next)
          }
        }
        break
      }
      case 'Enter': {
        e.preventDefault()
        if (!node) break
        handleClick(node.entry)
        break
      }
      case ' ': {
        e.preventDefault()
        if (!node) break
        if (node.entry.isDir) {
          toggleExpanded(props.taskId, node.entry.relativePath)
          if (!getDirContents(props.taskId, node.entry.relativePath)) {
            loadDirectory(props.taskId, node.entry.relativePath)
          }
        }
        break
      }
    }
  }

  return (
    <div ref={scrollRef} class="h-full overflow-auto relative outline-none" tabIndex={0} onKeyDown={handleKeyDown}>
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        <For each={virtualizer.getVirtualItems()}>
          {(virtualRow) => {
            const node = () => flatNodes()[virtualRow.index]
            return (
              <Show when={node()}>
                {(n) => {
                  const Icon = () => n().entry.isDir
                    ? (isExpanded(props.taskId, n().entry.relativePath) ? FolderOpen : Folder)
                    : getFileIcon(n().entry.name)
                  const ChevronIcon = () => n().entry.isDir
                    ? (isExpanded(props.taskId, n().entry.relativePath) ? ChevronDown : ChevronRight)
                    : null

                  return (
                    <div
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualRow.size}px`,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <button
                        class={`w-full h-full flex items-center gap-1 px-2 py-1 text-[12px] transition-colors text-left truncate${
                          !n().entry.isDir && mainView(props.taskId) === n().entry.relativePath
                            ? ' bg-surface-3 text-text-primary'
                            : selectedIndex() === virtualRow.index
                              ? ' bg-surface-2 text-text-secondary'
                              : ' text-text-secondary hover:bg-surface-2'
                        }`}
                        style={{ "padding-left": `${n().depth * 16 + 8}px` }}
                        onClick={() => { setSelectedIndex(virtualRow.index); handleClick(n().entry) }}
                        onDblClick={() => handleDoubleClick(n().entry)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setContextMenu({ x: e.clientX, y: e.clientY, entry: n().entry })
                        }}
                        title={n().entry.relativePath}
                      >
                        <span class="w-3 shrink-0 flex items-center justify-center">
                          <Show when={ChevronIcon()}>
                            {(_) => {
                              const C = ChevronIcon()!
                              return <C size={10} class="text-text-dim" />
                            }}
                          </Show>
                        </span>
                        <span class="shrink-0">
                          {(() => {
                            const I = Icon()
                            return <I
                              size={14}
                              class={n().entry.isDir ? 'text-accent' : undefined}
                            />
                          })()}
                        </span>
                        <span class={`truncate ml-1${
                          !n().entry.isDir && fileHasErrors(props.taskId, n().entry.relativePath) ? ' text-status-error' :
                          !n().entry.isDir && fileHasWarnings(props.taskId, n().entry.relativePath) ? ' text-yellow-500' :
                          n().entry.isDir && pathHasErrors(props.taskId, n().entry.relativePath) ? ' text-status-error' :
                          n().entry.isDir && pathHasWarnings(props.taskId, n().entry.relativePath) ? ' text-yellow-500' :
                          ''
                        }`}>{n().entry.name}</span>
                      </button>
                    </div>
                  )
                }}
              </Show>
            )
          }}
        </For>
      </div>

      {/* Context menu */}
      <Show when={contextMenu()}>
        {(menu) => (
          <div
            ref={menuRef}
            class="fixed z-100 bg-[#21252b] border border-[#181a1f] rounded-lg py-1 min-w-52"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
              'box-shadow': '0 6px 24px rgba(0,0,0,0.5)',
            }}
          >
            {/* File-specific actions */}
            <Show when={!menu().entry.isDir}>
              <TreeMenuItem label="Open in Editor" onClick={handleOpenFile} />
              <TreeMenuItem label="Open in VS Code" onClick={handleOpenInEditor} />
              <div class="h-px bg-[#181a1f] my-1" />
            </Show>

            {/* Folder-specific actions */}
            <Show when={menu().entry.isDir}>
              <Show
                when={isExpanded(props.taskId, menu().entry.relativePath)}
                fallback={<TreeMenuItem label="Expand" onClick={handleExpandFolder} />}
              >
                <TreeMenuItem label="Collapse" onClick={handleCollapseFolder} />
              </Show>
              <TreeMenuItem label="Open in VS Code" onClick={handleOpenInEditor} />
              <TreeMenuItem label="Refresh" onClick={handleRefresh} />
              <div class="h-px bg-[#181a1f] my-1" />
            </Show>

            {/* Common actions */}
            <TreeMenuItem label="Copy Name" onClick={handleCopyName} />
            <TreeMenuItem label="Copy Relative Path" onClick={handleCopyPath} />
            <TreeMenuItem label="Copy Absolute Path" onClick={handleCopyAbsPath} />
            <div class="h-px bg-[#181a1f] my-1" />
            <TreeMenuItem label="Reveal in Finder" onClick={handleRevealInFinder} />
          </div>
        )}
      </Show>
    </div>
  )
}

function TreeMenuItem(props: { label: string; onClick: () => void }) {
  return (
    <button
      class="w-full flex items-center px-3 py-1.5 text-[12px] text-[#abb2bf] hover:bg-[#2c313a] transition-colors text-left"
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}
