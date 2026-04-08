import { Component, Show, createSignal } from 'solid-js'
import { open } from '@tauri-apps/plugin-dialog'
import { addProject } from '../store/projects'
import { setSelectedProjectId } from '../store/ui'
import { addToast } from '../store/ui'
import { FolderOpen } from 'lucide-solid'
import { Dialog } from './Dialog'

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

  return (
    <Dialog open={props.open} onClose={props.onClose} onConfirm={() => path() && handleSubmit()} width="24rem">
      <h2 class="text-base font-semibold text-text-primary mb-4">Add Project</h2>

      <div class="mb-4">
        <label class="text-[11px] text-text-muted mb-1.5 block uppercase tracking-wider">Repository Path</label>
        <div class="flex gap-2">
          <input
            class="flex-1 bg-surface-0 border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors"
            value={path()}
            onInput={(e) => setPath(e.currentTarget.value)}
            placeholder="/path/to/repo"
            readOnly
          />
          <button
            class="p-2 rounded-lg text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors border border-border"
            onClick={pickFolder}
            title="Browse"
          >
            <FolderOpen size={16} />
          </button>
        </div>
      </div>

      <Show when={error()}>
        <div class="text-xs text-status-error mb-3 bg-status-error/5 border border-status-error/10 rounded-lg px-3 py-2">{error()}</div>
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
    </Dialog>
  )
}
