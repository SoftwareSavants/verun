import { Component, For, Show, createEffect, on, onCleanup, onMount, createSignal } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import { Folder, FolderOpen, File, ChevronRight, ChevronDown, FileCode, FileJson, FileText, Image, FileType } from 'lucide-solid'
import {
  getDirContents, loadDirectory, isExpanded, toggleExpanded, collapseDir,
  invalidateDirectory, openFile
} from '../store/files'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
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

function getFileIcon(name: string): Component<{ size: number; class?: string }> {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs':
    case 'rs': case 'py': case 'go': case 'java': case 'rb': case 'php':
    case 'c': case 'cpp': case 'h': case 'hpp': case 'swift': case 'kt':
    case 'cs': case 'lua': case 'sh': case 'bash': case 'zsh':
    case 'html': case 'css': case 'scss': case 'vue': case 'svelte':
      return FileCode
    case 'json': case 'jsonc': case 'json5':
      return FileJson
    case 'md': case 'mdx': case 'txt': case 'rst': case 'adoc':
      return FileText
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': case 'ico': case 'webp':
      return Image
    case 'toml': case 'yaml': case 'yml': case 'ini': case 'cfg': case 'conf':
      return FileType
    default:
      return File
  }
}

export const FileTree: Component<Props> = (props) => {
  let scrollRef: HTMLDivElement | undefined
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null)

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
  const closeMenu = () => setContextMenu(null)
  createEffect(() => {
    if (contextMenu()) {
      document.addEventListener('mousedown', closeMenu)
    } else {
      document.removeEventListener('mousedown', closeMenu)
    }
  })
  onCleanup(() => document.removeEventListener('mousedown', closeMenu))

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
    estimateSize: () => 28,
    overscan: 10,
  })

  const handleClick = (entry: FileEntry) => {
    if (entry.isDir) {
      toggleExpanded(props.taskId, entry.relativePath)
      if (!getDirContents(props.taskId, entry.relativePath)) {
        loadDirectory(props.taskId, entry.relativePath)
      }
    } else {
      openFile(entry.relativePath, entry.name)
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
    openFile(menu.entry.relativePath, menu.entry.name)
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

  return (
    <div ref={scrollRef} class="h-full overflow-auto relative">
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
                        class="w-full flex items-center gap-1 px-2 py-0.5 text-[12px] text-text-secondary hover:bg-surface-2 transition-colors text-left truncate"
                        style={{ "padding-left": `${n().depth * 16 + 8}px` }}
                        onClick={() => handleClick(n().entry)}
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
                              class={n().entry.isDir ? 'text-accent' : 'text-text-dim'}
                            />
                          })()}
                        </span>
                        <span class="truncate ml-1">{n().entry.name}</span>
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
            class="fixed z-100 bg-[#21252b] border border-[#181a1f] rounded-lg py-1 min-w-52"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
              'box-shadow': '0 6px 24px rgba(0,0,0,0.5)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
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
