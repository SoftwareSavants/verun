import { Component, createMemo, createResource, onCleanup, JSX, Show } from 'solid-js'
import * as ipc from '../lib/ipc'

interface Props {
  hash: string
  mimeType: string
  class?: string
  alt?: string
  onClick?: JSX.EventHandlerUnion<HTMLImageElement, MouseEvent>
}

// Process-local cache: hash → bytes. Lives for the window lifetime so the
// same image rendered in multiple places (preview, viewer, chat history)
// hits IPC at most once.
const blobCache = new Map<string, Uint8Array>()

async function loadBlob(hash: string): Promise<Uint8Array> {
  const cached = blobCache.get(hash)
  if (cached) return cached
  const bytes = await ipc.getBlob(hash)
  blobCache.set(hash, bytes)
  return bytes
}

export const BlobImage: Component<Props> = (props) => {
  const [data] = createResource(() => props.hash, loadBlob)
  const url = createMemo(() => {
    const bytes = data()
    if (!bytes) return ''
    const blob = new Blob([bytes], { type: props.mimeType })
    const u = URL.createObjectURL(blob)
    onCleanup(() => URL.revokeObjectURL(u))
    return u
  })
  return (
    <Show when={url()} fallback={<div class={props.class} style={{ background: 'rgba(255,255,255,0.04)' }} />}>
      <img src={url()} alt={props.alt ?? ''} class={props.class} onClick={props.onClick} />
    </Show>
  )
}
