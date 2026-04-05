import { Component, Show, createSignal } from 'solid-js'
import { open } from '@tauri-apps/plugin-dialog'
import { addProject } from '../store/projects'
import { setSelectedProjectId } from '../store/ui'
import { addToast } from '../store/ui'
import { FolderOpen } from 'lucide-solid'

interface Props {
  open: boolean
  onClose: () => void
}

export const AddProjectDialog: Component<Props> = (props) => {
  const [path, setPath] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false })
    if (selected) {
      setPath(selected as string)
      setError(null)
    }
  }

  const handleSubmit = async () => {
    if (!path()) return
    setLoading(true)
    setError(null)
    try {
      const project = await addProject(path())
      setSelectedProjectId(project.id)
      addToast(`Added ${project.name}`, 'success')
      setPath('')
      props.onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose()
    if (e.key === 'Enter' && path()) handleSubmit()
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        onClick={(e) => { if (e.target === e.currentTarget) props.onClose() }}
        onKeyDown={handleKeyDown}
      >
        <div class="bg-surface-1 border border-border rounded-lg shadow-xl w-96 p-5">
          <h2 class="text-lg font-semibold text-gray-200 mb-4">Add Project</h2>

          <div class="mb-4">
            <label class="text-xs text-gray-400 mb-1 block">Repository Path</label>
            <div class="flex gap-2">
              <input
                class="flex-1 bg-surface-0 border border-border rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent"
                value={path()}
                onInput={(e) => setPath(e.currentTarget.value)}
                placeholder="/path/to/repo"
                readOnly
              />
              <button class="btn-ghost p-2 rounded" onClick={pickFolder} title="Browse">
                <FolderOpen size={16} />
              </button>
            </div>
          </div>

          <Show when={error()}>
            <div class="text-xs text-status-error mb-3">{error()}</div>
          </Show>

          <div class="flex justify-end gap-2">
            <button class="btn-ghost" onClick={props.onClose}>Cancel</button>
            <button
              class="btn-primary"
              onClick={handleSubmit}
              disabled={!path() || loading()}
            >
              {loading() ? 'Adding...' : 'Add Project'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
