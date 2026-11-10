import { createSignal, createEffect, on, type Accessor } from 'solid-js'
import * as ipc from '../lib/ipc'
import { getCachedContent, setCachedContent, setCachedOriginal } from '../store/files'
import { reloadNonce } from '../store/fileSync'

/**
 * A preview's file content (markdown, SVG): loaded when the path changes and
 * again whenever fileSync refreshes the file after an edit made outside Verun.
 */
export function createPreviewContent(taskId: Accessor<string>, relativePath: Accessor<string>) {
  const [content, setContent] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  const load = async (rp: string) => {
    setError(null)
    const cached = getCachedContent(taskId(), rp)
    if (cached !== undefined) {
      // Cached: no loading state, so a live refresh does not flicker.
      setContent(cached)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const text = await ipc.readWorktreeFile(taskId(), rp)
      setContent(text)
      setCachedContent(taskId(), rp, text)
      setCachedOriginal(taskId(), rp, text)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  createEffect(on([relativePath, () => reloadNonce(taskId(), relativePath())], ([rp]) => { void load(rp) }))

  return { content, setContent, loading, error }
}
