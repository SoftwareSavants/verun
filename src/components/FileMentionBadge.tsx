import { Component, Show, Switch, Match, createSignal, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import { computePosition, flip, shift, offset } from '@floating-ui/dom'
import { convertFileSrc } from '@tauri-apps/api/core'
import { renderMarkdown, getWorktreePath } from '../lib/markdown'
import { getFileIcon } from '../lib/fileIcons'
import { highlightCode, langFromPath } from '../lib/highlighter'
import { getPreviewType, isMediaType } from '../lib/fileTypes'
import { readWorktreeFile, resolveWorktreeFilePath } from '../lib/ipc'
import { openFile } from '../store/files'
import { X, ExternalLink } from 'lucide-solid'

interface Props {
  filePath: string
  taskId?: string
  onRemove?: () => void
  size?: 'sm' | 'md'
}

type PreviewData =
  | { type: 'code'; html: string }
  | { type: 'markdown'; html: string }
  | { type: 'svg'; dataUrl: string }
  | { type: 'media'; mediaType: 'image' | 'video' | 'audio'; assetUrl: string }
  | { type: 'error'; error: string }

// Module-level cache: taskId:relativePath → preview data
const contentCache = new Map<string, PreviewData>()

export const FileMentionBadge: Component<Props> = (props) => {
  const [hovered, setHovered] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [preview, setPreview] = createSignal<PreviewData | null>(null)
  const [floatingStyle, setFloatingStyle] = createSignal<{ top: string; left: string }>({ top: '0px', left: '0px' })

  let leaveTimer: ReturnType<typeof setTimeout> | undefined
  let referenceEl!: HTMLSpanElement
  let floatingEl: HTMLDivElement | undefined

  onCleanup(() => clearTimeout(leaveTimer))

  const filename = () => props.filePath.split('/').pop() ?? props.filePath
  const dir = () => {
    const parts = props.filePath.split('/')
    return parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : ''
  }

  const sm = () => props.size === 'sm'

  const cacheKey = () => `${props.taskId ?? ''}:${props.filePath}`

  const updatePosition = async () => {
    if (!referenceEl || !floatingEl) return
    const { x, y } = await computePosition(referenceEl, floatingEl, {
      placement: 'bottom-start',
      middleware: [offset(4), flip(), shift({ padding: 8 })],
    })
    setFloatingStyle({ top: `${y}px`, left: `${x}px` })
  }

  const fetchPreview = async () => {
    const key = cacheKey()
    const cached = contentCache.get(key)
    if (cached) {
      setPreview(cached)
      return
    }
    if (!props.taskId) return

    setLoading(true)
    try {
      const pvType = getPreviewType(props.filePath)

      let result: PreviewData

      if (isMediaType(pvType)) {
        const absPath = await resolveWorktreeFilePath(props.taskId, props.filePath)
        const assetUrl = convertFileSrc(absPath)
        result = { type: 'media', mediaType: pvType as 'image' | 'video' | 'audio', assetUrl }
      } else if (pvType === 'svg') {
        const content = await readWorktreeFile(props.taskId, props.filePath)
        const dataUrl = `data:image/svg+xml,${encodeURIComponent(content)}`
        result = { type: 'svg', dataUrl }
      } else if (pvType === 'markdown') {
        const content = await readWorktreeFile(props.taskId, props.filePath)
        const html = renderMarkdown(content, getWorktreePath(props.taskId))
        result = { type: 'markdown', html }
      } else {
        const content = await readWorktreeFile(props.taskId, props.filePath)
        const lang = langFromPath(props.filePath)
        const html = await highlightCode(content, lang)
        result = { type: 'code', html }
      }

      contentCache.set(key, result)
      setPreview(result)
    } catch (e) {
      const result: PreviewData = { type: 'error', error: String(e) }
      contentCache.set(key, result)
      setPreview(result)
    } finally {
      setLoading(false)
    }
  }

  const handleEnter = () => {
    clearTimeout(leaveTimer)
    setHovered(true)
    if (!preview() && !loading()) fetchPreview()
    requestAnimationFrame(updatePosition)
  }

  const handleLeave = () => {
    leaveTimer = setTimeout(() => setHovered(false), 150)
  }

  const handleOpen = () => {
    if (!props.taskId) return
    openFile(props.taskId, props.filePath, filename())
  }

  const Icon = getFileIcon(filename())

  // Derived accessors for clean type narrowing
  const previewCode = () => { const p = preview(); return p?.type === 'code' ? p : null }
  const previewMd = () => { const p = preview(); return p?.type === 'markdown' ? p : null }
  const previewSvg = () => { const p = preview(); return p?.type === 'svg' ? p : null }
  const previewMedia = () => { const p = preview(); return p?.type === 'media' ? p : null }
  const previewError = () => { const p = preview(); return p?.type === 'error' ? p : null }

  return (
    <>
      <span
        ref={referenceEl}
        class="inline-flex items-center align-baseline"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        <span
          class={`inline-flex items-center gap-1 rounded-md font-mono border cursor-pointer ${
            sm()
              ? 'px-1 py-px text-[11px] bg-accent/8 border-accent/12 hover:bg-accent/15'
              : 'px-1.5 py-0.5 text-xs bg-accent/10 border-accent/15 hover:bg-accent/20'
          } transition-colors`}
          title={props.filePath}
          onClick={handleOpen}
        >
          <Icon size={sm() ? 10 : 12} class="shrink-0" />
          <span class="truncate max-w-40">{filename()}</span>
          <Show when={!sm() && dir()}>
            <span class="text-text-dim truncate max-w-32">{dir()}</span>
          </Show>
          <Show when={props.onRemove}>
            <button
              class="ml-0.5 p-0 rounded hover:bg-surface-3 transition-colors text-text-dim hover:text-text-muted"
              onClick={(e) => { e.stopPropagation(); props.onRemove!() }}
            >
              <X size={10} />
            </button>
          </Show>
        </span>
      </span>

      {/* Hover popover — portaled to body, positioned by floating-ui */}
      <Show when={hovered() && props.taskId}>
        <Portal>
          <div
            ref={(el) => { floatingEl = el; updatePosition() }}
            class="fixed z-50 w-[28rem] max-h-96 bg-surface-2 border border-border-active rounded-lg shadow-xl overflow-hidden"
            style={floatingStyle()}
            onMouseEnter={handleEnter}
            onMouseLeave={handleLeave}
          >
            <div
              class="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface-1 cursor-pointer hover:bg-surface-2 transition-colors"
              onClick={handleOpen}
            >
              <Icon size={13} class="shrink-0" />
              <span class="text-[11px] font-mono text-text-primary truncate flex-1">{props.filePath}</span>
              <ExternalLink size={12} class="shrink-0 text-text-dim" />
            </div>
            <Show
              when={!loading()}
              fallback={
                <div class="px-3 py-4 text-[11px] text-text-dim text-center">Loading…</div>
              }
            >
              <Switch fallback={
                <div class="px-3 py-4 text-[11px] text-text-dim text-center">No preview available</div>
              }>
                <Match when={previewCode()}>
                  {(p) => (
                    <div
                      class="overflow-auto max-h-80 [&_pre]:!bg-transparent [&_pre]:!m-0 [&_pre]:px-3 [&_pre]:py-2 [&_code]:!text-[11px] [&_code]:!leading-relaxed"
                      innerHTML={p().html}
                    />
                  )}
                </Match>

                <Match when={previewMd()}>
                  {(p) => (
                    <div
                      class="overflow-auto max-h-80 px-3 py-2 text-xs text-text-primary leading-relaxed prose-verun select-text break-words"
                      innerHTML={p().html}
                    />
                  )}
                </Match>

                <Match when={previewSvg()}>
                  {(p) => (
                    <div class="overflow-auto max-h-80 flex items-center justify-center p-3 bg-[#0a0a0a]">
                      <img
                        src={p().dataUrl}
                        alt={filename()}
                        class="max-w-full max-h-72 object-contain"
                      />
                    </div>
                  )}
                </Match>

                <Match when={previewMedia()?.mediaType === 'image' && previewMedia()}>
                  {(p) => (
                    <div class="overflow-auto max-h-80 flex items-center justify-center p-2 bg-[#0a0a0a]">
                      <img
                        src={p().assetUrl}
                        alt={filename()}
                        class="max-w-full max-h-72 object-contain rounded"
                        loading="lazy"
                      />
                    </div>
                  )}
                </Match>

                <Match when={previewMedia()?.mediaType === 'video' && previewMedia()}>
                  {(p) => (
                    <div class="overflow-hidden max-h-80 p-2">
                      <video
                        src={p().assetUrl}
                        controls
                        preload="metadata"
                        class="max-w-full max-h-72 rounded"
                      />
                    </div>
                  )}
                </Match>

                <Match when={previewMedia()?.mediaType === 'audio' && previewMedia()}>
                  {(p) => (
                    <div class="px-3 py-4 flex items-center justify-center">
                      <audio
                        src={p().assetUrl}
                        controls
                        preload="metadata"
                        class="w-full"
                      />
                    </div>
                  )}
                </Match>

                <Match when={previewError()}>
                  {(p) => (
                    <div class="px-3 py-4 text-[11px] text-text-dim text-center">
                      {p().error}
                    </div>
                  )}
                </Match>
              </Switch>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  )
}
