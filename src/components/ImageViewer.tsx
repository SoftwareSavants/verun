import { Component, Show, createEffect, createResource, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import { Copy, Download, X } from 'lucide-solid'
import { save } from '@tauri-apps/plugin-dialog'
import * as ipc from '../lib/ipc'
import { addToast } from '../store/ui'
import { BlobImage } from './BlobImage'

interface Props {
  open: boolean
  hash: string
  mimeType: string
  name?: string
  onClose: () => void
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function defaultFileName(name: string | undefined, mimeType: string): string {
  if (name && name.trim().length > 0) return name
  const ext = EXT_BY_MIME[mimeType] ?? 'png'
  return `image.${ext}`
}

export const ImageViewer: Component<Props> = (props) => {
  // Pulled lazily so copy/download don't fire IPC until the user acts.
  const [bytes] = createResource(() => props.open ? props.hash : null, (h) => h ? ipc.getBlob(h) : null)

  createEffect(() => {
    if (!props.open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('keydown', handler)
    onCleanup(() => window.removeEventListener('keydown', handler))
  })

  const handleCopy = async () => {
    try {
      const data = bytes()
      if (!data) return
      await ipc.copyImageToClipboard(props.mimeType, data)
      addToast('Image copied', 'success', { duration: 2000 })
    } catch (e) {
      addToast(`Copy failed: ${e}`, 'error', { duration: 4000 })
    }
  }

  const handleDownload = async () => {
    try {
      const data = bytes()
      if (!data) return
      const ext = EXT_BY_MIME[props.mimeType] ?? 'png'
      const path = await save({
        defaultPath: defaultFileName(props.name, props.mimeType),
        filters: [{ name: 'Image', extensions: [ext] }],
      })
      if (!path) return
      await ipc.writeBinaryFile(path, data)
      addToast('Image saved', 'success', { duration: 2000 })
    } catch (e) {
      addToast(`Save failed: ${e}`, 'error', { duration: 4000 })
    }
  }

  return (
    <Show when={props.open}>
      <Portal>
      <div
        class="fixed inset-0 z-[1000] flex items-center justify-center bg-black/85"
        onClick={(e) => { if (e.target === e.currentTarget) props.onClose() }}
      >
        <div class="absolute top-3 right-3 flex items-center gap-1 bg-surface-2/90 backdrop-blur border border-border rounded-lg px-1 py-1 shadow-lg">
          <button
            class="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
            onClick={handleCopy}
            title="Copy image"
          >
            <Copy size={15} />
          </button>
          <button
            class="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
            onClick={handleDownload}
            title="Download"
          >
            <Download size={15} />
          </button>
          <button
            class="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
            onClick={props.onClose}
            title="Close (Esc)"
          >
            <X size={15} />
          </button>
        </div>
        <BlobImage
          hash={props.hash}
          mimeType={props.mimeType}
          alt={props.name ?? ''}
          class="max-w-[95vw] max-h-[95vh] object-contain rounded-md shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      </Portal>
    </Show>
  )
}
