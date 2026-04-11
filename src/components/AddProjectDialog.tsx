import { Component, createSignal, createEffect, on, Show } from 'solid-js'
import { Dialog } from './Dialog'
import { CodeTextarea } from './CodeTextarea'
import { Loader2, Sparkles } from 'lucide-solid'
import { addProject, updateHooks } from '../store/projects'
import { createTask } from '../store/tasks'
import { sendMessage, setSessions, setOutputItems } from '../store/sessions'
import { addToast, setSelectedProjectId, setSelectedTaskId, setSelectedSessionId, setShowSettings } from '../store/ui'
import { AUTODETECT_PROMPT } from '../lib/autodetect-prompt'
import { produce } from 'solid-js/store'
import * as ipc from '../lib/ipc'

interface Props {
  open: boolean
  repoPath: string | null
  onClose: () => void
  onAdded: (projectId: string) => void
}

export const AddProjectDialog: Component<Props> = (props) => {
  const [setupHook, setSetupHook] = createSignal('')
  const [destroyHook, setDestroyHook] = createSignal('')
  const [startCommand, setStartCommand] = createSignal('')
  const [adding, setAdding] = createSignal(false)
  const [autoDetecting, setAutoDetecting] = createSignal(false)

  // Pre-populate hooks from .verun.json if it exists
  createEffect(on(() => props.repoPath, (path) => {
    if (!path) return
    ipc.readTextFile(`${path}/.verun.json`).then((content) => {
      try {
        const config = JSON.parse(content)
        if (config.hooks?.setup) setSetupHook(config.hooks.setup)
        if (config.hooks?.destroy) setDestroyHook(config.hooks.destroy)
        if (config.startCommand) setStartCommand(config.startCommand)
      } catch { /* ignore invalid JSON */ }
    }).catch(() => { /* no config file, leave fields empty */ })
  }))

  const projectName = () => {
    if (!props.repoPath) return ''
    const parts = props.repoPath.split('/')
    return parts[parts.length - 1] || ''
  }

  const handleAutoDetect = async () => {
    if (!props.repoPath) return
    setAutoDetecting(true)
    try {
      // Add the project first
      const project = await addProject(props.repoPath)
      setSelectedProjectId(project.id)

      // Create a task for auto-detection
      const { task, session } = await createTask(project.id)
      setSessions(produce((s: any[]) => s.push(session)))
      setOutputItems(session.id, [])

      // Navigate to the task and close dialog immediately
      setSelectedTaskId(task.id)
      setSelectedSessionId(session.id)
      setShowSettings(false)
      handleClose()

      // Send the auto-detect prompt (runs in background after dialog closes)
      const prompt = AUTODETECT_PROMPT
        .replace('{REPO_PATH}', props.repoPath!)
        .replace('{PROJECT_NAME}', project.name)
      await sendMessage(session.id, prompt)

      addToast('Hooks will be saved automatically when analysis completes', 'success')
    } catch (e) {
      addToast(String(e), 'error')
      setAutoDetecting(false)
    }
  }

  const handleAdd = async () => {
    if (!props.repoPath) return
    setAdding(true)
    try {
      const project = await addProject(props.repoPath)
      const sh = setupHook()
      const dh = destroyHook()
      const sc = startCommand()
      if (sh || dh || sc) {
        await updateHooks(project.id, sh, dh, sc)
      }
      addToast(`Added ${project.name}`, 'success')
      props.onAdded(project.id)
      handleClose()
    } catch (e) {
      addToast(String(e), 'error')
    } finally {
      setAdding(false)
    }
  }

  const handleClose = () => {
    setSetupHook('')
    setDestroyHook('')
    setStartCommand('')
    props.onClose()
  }

  return (
    <Dialog open={props.open} onClose={handleClose} width="28rem">
      <h2 class="text-base font-semibold text-text-primary mb-1">Add Project</h2>
      <p class="text-xs text-text-dim mb-4 truncate" title={props.repoPath ?? ''}>{projectName()}</p>

      {/* Auto-detect option */}
      <div class="mb-5 p-3 rounded-lg bg-surface-2 border border-border">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-xs font-medium text-text-secondary">Auto-detect with Claude</div>
            <div class="text-[11px] text-text-dim mt-0.5">Creates a task that analyzes your project, detects env files, ports, and generates hooks</div>
          </div>
          <button
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs btn-primary disabled:opacity-40 shrink-0 ml-3"
            onClick={handleAutoDetect}
            disabled={autoDetecting()}
          >
            <Show when={autoDetecting()} fallback={<Sparkles size={12} />}>
              <Loader2 size={12} class="animate-spin" />
            </Show>
            Detect
          </button>
        </div>
      </div>

      {/* Manual hooks */}
      <div class="space-y-4">
        <div class="text-xs font-medium text-text-muted">Or configure manually</div>

        <div>
          <label class="block text-xs text-text-muted mb-1">Setup hook</label>
          <CodeTextarea
            value={setupHook()}
            onInput={setSetupHook}
            onSave={handleAdd}
            placeholder='cp "$VERUN_REPO_PATH/.env" .env && pnpm install'
            minRows={2}
            maxRows={6}
          />
        </div>

        <div>
          <label class="block text-xs text-text-muted mb-1">Destroy hook</label>
          <CodeTextarea
            value={destroyHook()}
            onInput={setDestroyHook}
            onSave={handleAdd}
            placeholder="cleanup commands"
            minRows={1}
            maxRows={4}
          />
        </div>

        <div>
          <label class="block text-xs text-text-muted mb-1">Start command</label>
          <CodeTextarea
            value={startCommand()}
            onInput={setStartCommand}
            onSave={handleAdd}
            placeholder="pnpm dev"
            minRows={1}
            maxRows={4}
          />
        </div>
      </div>

      <div class="flex justify-end gap-2 mt-5">
        <button class="btn-ghost text-xs" onClick={handleClose}>Cancel</button>
        <button
          class="btn-primary text-xs px-4 py-1.5 disabled:opacity-40"
          onClick={handleAdd}
          disabled={adding()}
        >
          <Show when={adding()} fallback="Add Project">
            <Loader2 size={12} class="animate-spin mr-1" />
            Adding...
          </Show>
        </button>
      </div>
    </Dialog>
  )
}
