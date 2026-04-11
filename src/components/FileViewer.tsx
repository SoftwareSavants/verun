import { Component, Switch, Match, Show, createSignal, createEffect, on } from 'solid-js'
import { convertFileSrc } from '@tauri-apps/api/core'
import { marked } from 'marked'
import { Image, Film, Music, Eye, Code2, Loader2, AlertCircle } from 'lucide-solid'
import { CodeEditor } from './CodeEditor'
import { BreadcrumbBar } from './BreadcrumbBar'
import { getPreviewType } from '../lib/fileTypes'
import * as ipc from '../lib/ipc'
import { getCachedContent, setCachedContent, setCachedOriginal } from '../store/files'

interface Props {
  taskId: string
  relativePath: string
}

// ── FileViewer — routes to the correct sub-viewer by file type ─────────

export const FileViewer: Component<Props> = (props) => {
  const type = () => getPreviewType(props.relativePath)

  return (
    <Switch fallback={
      <div class="flex flex-col h-full">
        <div class="flex items-center px-3 py-1 bg-[#1e1e1e] border-b border-border-subtle shrink-0">
          <BreadcrumbBar taskId={props.taskId} currentPath={props.relativePath} />
        </div>
        <div class="flex-1 overflow-hidden">
          <CodeEditor taskId={props.taskId} relativePath={props.relativePath} />
        </div>
      </div>
    }>
      <Match when={type() === 'image'}>
        <ImageViewer taskId={props.taskId} relativePath={props.relativePath} />
      </Match>
      <Match when={type() === 'video'}>
        <VideoViewer taskId={props.taskId} relativePath={props.relativePath} />
      </Match>
      <Match when={type() === 'audio'}>
        <AudioViewer taskId={props.taskId} relativePath={props.relativePath} />
      </Match>
      <Match when={type() === 'markdown'}>
        <MarkdownViewer taskId={props.taskId} relativePath={props.relativePath} />
      </Match>
      <Match when={type() === 'svg'}>
        <SvgViewer taskId={props.taskId} relativePath={props.relativePath} />
      </Match>
    </Switch>
  )
}

// ── Shared toolbar for viewers ─────────────────────────────────────────

const ViewerToolbar: Component<{
  taskId: string
  relativePath: string
  icon?: Component<{ size: number; class?: string }>
  children?: any
}> = (props) => (
  <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-1 shrink-0">
    <Show when={props.icon}>
      {(() => { const I = props.icon!; return <I size={14} class="text-text-dim shrink-0" /> })()}
    </Show>
    <BreadcrumbBar taskId={props.taskId} currentPath={props.relativePath} />
    <div class="flex-1" />
    {props.children}
  </div>
)

// ── Shared hook: resolve absolute path → asset:// URL ──────────────────

function useAssetUrl(taskId: () => string, relativePath: () => string) {
  const [url, setUrl] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)

  createEffect(on([taskId, relativePath], async ([tid, rp]) => {
    setLoading(true)
    setError(null)
    try {
      const absPath = await ipc.resolveWorktreeFilePath(tid, rp)
      setUrl(convertFileSrc(absPath))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }))

  return { url, error, loading }
}

// ── ImageViewer ────────────────────────────────────────────────────────

const ImageViewer: Component<Props> = (props) => {
  const { url, error, loading } = useAssetUrl(() => props.taskId, () => props.relativePath)
  const filename = () => props.relativePath.split('/').pop() ?? props.relativePath
  const [dimensions, setDimensions] = createSignal<{ w: number; h: number } | null>(null)

  return (
    <div class="flex flex-col h-full">
      <ViewerToolbar taskId={props.taskId} relativePath={props.relativePath} icon={Image}>
        <Show when={dimensions()}>
          <span class="text-[11px] text-text-dim">{dimensions()!.w} × {dimensions()!.h}</span>
        </Show>
      </ViewerToolbar>
      <div class="flex-1 overflow-auto flex items-center justify-center bg-[#0a0a0a]" style="background-image: url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22><rect width=%228%22 height=%228%22 fill=%22%23111%22/><rect x=%228%22 y=%228%22 width=%228%22 height=%228%22 fill=%22%23111%22/></svg>'); background-size: 16px 16px;">
        <Show when={loading()}>
          <Loader2 size={24} class="animate-spin text-text-dim" />
        </Show>
        <Show when={error()}>
          <div class="flex flex-col items-center gap-2 text-text-dim">
            <AlertCircle size={24} />
            <span class="text-xs">{error()}</span>
          </div>
        </Show>
        <Show when={url()}>
          <img
            src={url()!}
            alt={filename()}
            class="max-w-full max-h-full object-contain"
            onLoad={(e) => {
              const img = e.currentTarget
              setDimensions({ w: img.naturalWidth, h: img.naturalHeight })
            }}
          />
        </Show>
      </div>
    </div>
  )
}

// ── VideoViewer ────────────────────────────────────────────────────────

const VideoViewer: Component<Props> = (props) => {
  const { url, error, loading } = useAssetUrl(() => props.taskId, () => props.relativePath)

  return (
    <div class="flex flex-col h-full">
      <ViewerToolbar taskId={props.taskId} relativePath={props.relativePath} icon={Film} />
      <div class="flex-1 overflow-auto flex items-center justify-center bg-[#0a0a0a]">
        <Show when={loading()}>
          <Loader2 size={24} class="animate-spin text-text-dim" />
        </Show>
        <Show when={error()}>
          <div class="flex flex-col items-center gap-2 text-text-dim">
            <AlertCircle size={24} />
            <span class="text-xs">{error()}</span>
          </div>
        </Show>
        <Show when={url()}>
          <video
            src={url()!}
            controls
            preload="metadata"
            class="max-w-full max-h-full"
          />
        </Show>
      </div>
    </div>
  )
}

// ── AudioViewer ────────────────────────────────────────────────────────

const AudioViewer: Component<Props> = (props) => {
  const { url, error, loading } = useAssetUrl(() => props.taskId, () => props.relativePath)
  const filename = () => props.relativePath.split('/').pop() ?? props.relativePath

  return (
    <div class="flex flex-col h-full">
      <ViewerToolbar taskId={props.taskId} relativePath={props.relativePath} icon={Music} />
      <div class="flex-1 flex flex-col items-center justify-center gap-4 bg-surface-0">
        <Show when={loading()}>
          <Loader2 size={24} class="animate-spin text-text-dim" />
        </Show>
        <Show when={error()}>
          <div class="flex flex-col items-center gap-2 text-text-dim">
            <AlertCircle size={24} />
            <span class="text-xs">{error()}</span>
          </div>
        </Show>
        <Show when={url()}>
          <Music size={48} class="text-text-dim" />
          <span class="text-sm text-text-secondary font-mono">{filename()}</span>
          <audio src={url()!} controls preload="metadata" class="w-80" />
        </Show>
      </div>
    </div>
  )
}

// ── MarkdownViewer — preview/edit toggle ───────────────────────────────

const MarkdownViewer: Component<Props> = (props) => {
  const [mode, setMode] = createSignal<'preview' | 'edit'>('preview')
  const [content, setContent] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  let previewScrollFraction = 0
  let previewEl: HTMLDivElement | undefined
  let editorWrapperEl: HTMLDivElement | undefined

  const loadContent = async (rp: string) => {
    setLoading(true)
    setError(null)
    try {
      const cached = getCachedContent(props.taskId, rp)
      if (cached !== undefined) {
        setContent(cached)
      } else {
        const text = await ipc.readWorktreeFile(props.taskId, rp)
        setContent(text)
        setCachedContent(props.taskId, rp, text)
        setCachedOriginal(props.taskId, rp, text)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  createEffect(on(() => props.relativePath, loadContent))

  const saveScroll = () => {
    if (previewEl) {
      const max = previewEl.scrollHeight - previewEl.clientHeight
      previewScrollFraction = max > 0 ? previewEl.scrollTop / max : 0
    }
  }

  const restoreScroll = () => {
    if (previewEl) {
      requestAnimationFrame(() => {
        if (!previewEl) return
        const max = previewEl.scrollHeight - previewEl.clientHeight
        previewEl.scrollTop = max * previewScrollFraction
      })
    }
  }

  const focusEditor = () => {
    requestAnimationFrame(() => {
      const cm = editorWrapperEl?.querySelector('.cm-content') as HTMLElement | null
      cm?.focus()
    })
  }

  const switchToPreview = () => {
    const cached = getCachedContent(props.taskId, props.relativePath)
    if (cached !== undefined) setContent(cached)
    setMode('preview')
    restoreScroll()
  }

  const switchToEdit = () => {
    saveScroll()
    setMode('edit')
    focusEditor()
  }

  const renderedHtml = () => {
    try {
      return marked.parse(content(), { async: false }) as string
    } catch {
      return content()
    }
  }

  return (
    <div class="flex flex-col h-full">
      <ViewerToolbar taskId={props.taskId} relativePath={props.relativePath}>
        <div class="flex items-center bg-surface-2 rounded-md p-0.5 gap-0.5">
          <button
            class={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
              mode() === 'preview' ? 'bg-surface-3 text-text-secondary' : 'text-text-dim hover:text-text-muted'
            }`}
            onClick={switchToPreview}
          >
            <Eye size={12} />
            Preview
          </button>
          <button
            class={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
              mode() === 'edit' ? 'bg-surface-3 text-text-secondary' : 'text-text-dim hover:text-text-muted'
            }`}
            onClick={switchToEdit}
          >
            <Code2 size={12} />
            Edit
          </button>
        </div>
      </ViewerToolbar>

      <Show when={loading()}>
        <div class="flex-1 flex items-center justify-center">
          <Loader2 size={24} class="animate-spin text-text-dim" />
        </div>
      </Show>

      <Show when={error()}>
        <div class="flex-1 flex items-center justify-center">
          <div class="flex flex-col items-center gap-2 text-text-dim">
            <AlertCircle size={24} />
            <span class="text-xs">{error()}</span>
          </div>
        </div>
      </Show>

      <Show when={!loading() && !error()}>
        <div
          ref={previewEl}
          class="flex-1 overflow-auto px-6 py-4 text-sm text-text-primary leading-relaxed prose-verun select-text"
          style={{ display: mode() === 'preview' ? '' : 'none' }}
          innerHTML={renderedHtml()}
        />
        <div ref={editorWrapperEl} class="flex-1 overflow-hidden" style={{ display: mode() === 'edit' ? '' : 'none' }}>
          <CodeEditor taskId={props.taskId} relativePath={props.relativePath} />
        </div>
      </Show>
    </div>
  )
}

// ── SvgViewer — preview/edit toggle ────────────────────────────────────

const SvgViewer: Component<Props> = (props) => {
  const [mode, setMode] = createSignal<'preview' | 'edit'>('preview')
  const [content, setContent] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const filename = () => props.relativePath.split('/').pop() ?? props.relativePath

  let previewScrollFraction = 0
  let previewEl: HTMLDivElement | undefined
  let editorWrapperEl: HTMLDivElement | undefined

  const loadContent = async (rp: string) => {
    setLoading(true)
    setError(null)
    try {
      const cached = getCachedContent(props.taskId, rp)
      if (cached !== undefined) {
        setContent(cached)
      } else {
        const text = await ipc.readWorktreeFile(props.taskId, rp)
        setContent(text)
        setCachedContent(props.taskId, rp, text)
        setCachedOriginal(props.taskId, rp, text)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  createEffect(on(() => props.relativePath, loadContent))

  const saveScroll = () => {
    if (previewEl) {
      const max = previewEl.scrollHeight - previewEl.clientHeight
      previewScrollFraction = max > 0 ? previewEl.scrollTop / max : 0
    }
  }

  const restoreScroll = () => {
    if (previewEl) {
      requestAnimationFrame(() => {
        if (!previewEl) return
        const max = previewEl.scrollHeight - previewEl.clientHeight
        previewEl.scrollTop = max * previewScrollFraction
      })
    }
  }

  const focusEditor = () => {
    requestAnimationFrame(() => {
      const cm = editorWrapperEl?.querySelector('.cm-content') as HTMLElement | null
      cm?.focus()
    })
  }

  const switchToPreview = () => {
    const cached = getCachedContent(props.taskId, props.relativePath)
    if (cached !== undefined) setContent(cached)
    setMode('preview')
    restoreScroll()
  }

  const switchToEdit = () => {
    saveScroll()
    setMode('edit')
    focusEditor()
  }

  const svgDataUrl = () => {
    const svg = content()
    if (!svg) return ''
    return `data:image/svg+xml,${encodeURIComponent(svg)}`
  }

  return (
    <div class="flex flex-col h-full">
      <ViewerToolbar taskId={props.taskId} relativePath={props.relativePath} icon={Image}>
        <div class="flex items-center bg-surface-2 rounded-md p-0.5 gap-0.5">
          <button
            class={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
              mode() === 'preview' ? 'bg-surface-3 text-text-secondary' : 'text-text-dim hover:text-text-muted'
            }`}
            onClick={switchToPreview}
          >
            <Eye size={12} />
            Preview
          </button>
          <button
            class={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
              mode() === 'edit' ? 'bg-surface-3 text-text-secondary' : 'text-text-dim hover:text-text-muted'
            }`}
            onClick={switchToEdit}
          >
            <Code2 size={12} />
            Edit
          </button>
        </div>
      </ViewerToolbar>

      <Show when={loading()}>
        <div class="flex-1 flex items-center justify-center">
          <Loader2 size={24} class="animate-spin text-text-dim" />
        </div>
      </Show>

      <Show when={error()}>
        <div class="flex-1 flex items-center justify-center">
          <div class="flex flex-col items-center gap-2 text-text-dim">
            <AlertCircle size={24} />
            <span class="text-xs">{error()}</span>
          </div>
        </div>
      </Show>

      <Show when={!loading() && !error()}>
        <div
          ref={previewEl}
          class="flex-1 overflow-auto flex items-center justify-center bg-[#0a0a0a]"
          style={`background-image: url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22><rect width=%228%22 height=%228%22 fill=%22%23111%22/><rect x=%228%22 y=%228%22 width=%228%22 height=%228%22 fill=%22%23111%22/></svg>'); background-size: 16px 16px; display: ${mode() === 'preview' ? '' : 'none'}`}
        >
          <Show when={svgDataUrl()}>
            <img
              src={svgDataUrl()}
              alt={filename()}
              class="max-w-full max-h-full object-contain p-4"
            />
          </Show>
        </div>
        <div ref={editorWrapperEl} class="flex-1 overflow-hidden" style={{ display: mode() === 'edit' ? '' : 'none' }}>
          <CodeEditor taskId={props.taskId} relativePath={props.relativePath} />
        </div>
      </Show>
    </div>
  )
}
