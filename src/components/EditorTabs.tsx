import { Component, For, Show, createSignal, createEffect, onCleanup } from 'solid-js'
import { X } from 'lucide-solid'
import { clsx } from 'clsx'
import {
  openTabs, activeTabPath, setActiveTab, requestCloseTab, forceCloseTab,
  cancelCloseTab, pendingClose, closeOtherTabs, closeAllTabs,
} from '../store/files'
import { ConfirmDialog } from './ConfirmDialog'

export const EditorTabs: Component = () => {
  const [tabMenu, setTabMenu] = createSignal<{ x: number; y: number; path: string } | null>(null)

  const closeMenu = () => setTabMenu(null)

  createEffect(() => {
    if (tabMenu()) {
      document.addEventListener('mousedown', closeMenu)
    } else {
      document.removeEventListener('mousedown', closeMenu)
    }
  })
  onCleanup(() => document.removeEventListener('mousedown', closeMenu))

  return (
    <>
      <div class="flex items-center gap-0 overflow-x-auto bg-surface-0 border-b border-border-subtle shrink-0">
        <For each={openTabs()}>
          {(tab) => (
            <div
              class={clsx(
                'group flex items-center gap-1.5 px-3 py-1.5 text-[11px] cursor-pointer border-r border-border-subtle transition-colors min-w-0',
                activeTabPath() === tab.relativePath
                  ? 'bg-surface-1 text-text-secondary'
                  : 'text-text-dim hover:text-text-muted hover:bg-surface-1'
              )}
              onClick={() => setActiveTab(tab.relativePath)}
              onContextMenu={(e) => {
                e.preventDefault()
                setTabMenu({ x: e.clientX, y: e.clientY, path: tab.relativePath })
              }}
            >
              <span class="truncate max-w-32">
                {tab.dirty ? '\u2022 ' : ''}{tab.name}
              </span>
              <button
                class={clsx(
                  'shrink-0 text-text-dim hover:text-text-muted transition-opacity',
                  tab.dirty ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  requestCloseTab(tab.relativePath)
                }}
                title="Close"
              >
                <X size={10} />
              </button>
            </div>
          )}
        </For>
      </div>

      {/* Tab context menu */}
      <Show when={tabMenu()}>
        {(menu) => (
          <div
            class="fixed z-100 bg-[#21252b] border border-[#181a1f] rounded-lg py-1 min-w-44"
            style={{
              left: `${menu().x}px`,
              top: `${menu().y}px`,
              'box-shadow': '0 6px 24px rgba(0,0,0,0.5)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <TabMenuItem label="Close" shortcut={'\u2318W'} onClick={() => { requestCloseTab(menu().path); closeMenu() }} />
            <TabMenuItem label="Close Others" onClick={() => { closeOtherTabs(menu().path); closeMenu() }} />
            <TabMenuItem label="Close All" onClick={() => { closeAllTabs(); closeMenu() }} />
            <div class="h-px bg-[#181a1f] my-1" />
            <TabMenuItem label="Copy Relative Path" onClick={() => {
              navigator.clipboard.writeText(menu().path)
              closeMenu()
            }} />
          </div>
        )}
      </Show>

      {/* Unsaved changes confirm */}
      <ConfirmDialog
        open={!!pendingClose()}
        title="Unsaved changes"
        message={`"${pendingClose()?.split('/').pop()}" has unsaved changes. Close without saving?`}
        confirmLabel="Close without saving"
        danger
        onConfirm={() => {
          const path = pendingClose()
          if (path) forceCloseTab(path)
        }}
        onCancel={cancelCloseTab}
      />
    </>
  )
}

function TabMenuItem(props: { label: string; shortcut?: string; onClick: () => void }) {
  return (
    <button
      class="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-[#abb2bf] hover:bg-[#2c313a] transition-colors text-left"
      onClick={props.onClick}
    >
      <span>{props.label}</span>
      <Show when={props.shortcut}>
        <span class="text-[11px] text-[#5c6370] ml-8">{props.shortcut}</span>
      </Show>
    </button>
  )
}
