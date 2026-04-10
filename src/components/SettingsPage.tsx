import { Component, createSignal, createEffect, on, For, Show } from 'solid-js'
import { ChevronDown, X, Settings, FolderGit2, Loader2, Sparkles, Download, Upload } from 'lucide-solid'
import { ACCENT_THEMES, getActiveTheme, setActiveTheme, type AccentTheme } from '../lib/theme'
import { setShowSettings, setSelectedTaskId, setSelectedSessionId, defaultWrapLines, setDefaultWrapLinesAndPersist, defaultHideWhitespace, setDefaultHideWhitespaceAndPersist } from '../store/ui'
import { notificationsEnabled, setNotificationsEnabledAndPersist } from '../lib/notifications'
import { projects, updateHooks, updateStoreHooks } from '../store/projects'
import { createTask, tasksForProject } from '../store/tasks'
import { sendMessage, setSessions, setOutputItems } from '../store/sessions'
import * as ipc from '../lib/ipc'
import { Popover } from './Popover'
import { hasOverlayTitlebar } from '../lib/platform'
import { Toggle } from './Toggle'
import { CodeTextarea } from './CodeTextarea'
import { addToast } from '../store/ui'
import { AUTODETECT_PROMPT } from '../lib/autodetect-prompt'
import { produce } from 'solid-js/store'

type SettingsSection = 'general' | string // project id

// Module-level signals so Layout can drive section switching and save via keyboard shortcuts
const [activeSection, setActiveSection] = createSignal<SettingsSection>('general')
const [editSetupHook, setEditSetupHook] = createSignal('')
const [editDestroyHook, setEditDestroyHook] = createSignal('')
const [editStartCommand, setEditStartCommand] = createSignal('')
export const [settingsSaveRequested, setSettingsSaveRequested] = createSignal(0)

export function selectSettingsSection(section: SettingsSection) {
  setActiveSection(section)
  if (section === 'general') return
  const p = projects.find(pr => pr.id === section)
  if (p) {
    setEditSetupHook(p.setupHook)
    setEditDestroyHook(p.destroyHook)
    setEditStartCommand(p.startCommand)
  }
}

export const SettingsPage: Component = () => {
  const [activeTheme, setActiveThemeSignal] = createSignal(getActiveTheme().name)
  const [dropdownOpen, setDropdownOpen] = createSignal(false)

  const [saving, setSaving] = createSignal(false)
  const [suggesting, setSuggesting] = createSignal(false)

  // Populate edit fields from active project on mount
  const section = activeSection()
  if (section !== 'general') {
    const p = projects.find(pr => pr.id === section)
    if (p) {
      setEditSetupHook(p.setupHook)
      setEditDestroyHook(p.destroyHook)
      setEditStartCommand(p.startCommand)
    }
  }

  const hasChanges = () => {
    const p = selectedProject()
    if (!p) return false
    return editSetupHook() !== p.setupHook
      || editDestroyHook() !== p.destroyHook
      || editStartCommand() !== p.startCommand
  }

  const current = () => ACCENT_THEMES.find(t => t.name === activeTheme()) ?? ACCENT_THEMES[0]

  const pickTheme = (t: AccentTheme) => {
    setActiveTheme(t)
    setActiveThemeSignal(t.name)
    setDropdownOpen(false)
  }

  const selectedProject = () => {
    const section = activeSection()
    if (section === 'general') return null
    return projects.find(p => p.id === section) ?? null
  }


  const saveHooks = async () => {
    const p = selectedProject()
    if (!p) return
    setSaving(true)
    try {
      await updateHooks(p.id, editSetupHook(), editDestroyHook(), editStartCommand())
      addToast('Hooks saved', 'success')
    } catch (e) {
      addToast(String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  // Trigger save from keyboard shortcut (CMD+S)
  createEffect(on(settingsSaveRequested, (count) => {
    if (count > 0) saveHooks()
  }, { defer: true }))

  const runAutoDetect = async () => {
    const p = selectedProject()
    if (!p) return
    setSuggesting(true)
    try {
      const { task, session } = await createTask(p.id)
      setSessions(produce((s: any[]) => s.push(session)))
      setOutputItems(session.id, [])

      setSelectedTaskId(task.id)
      setSelectedSessionId(session.id)
      setShowSettings(false)

      const prompt = AUTODETECT_PROMPT
        .replace('{REPO_PATH}', p.repoPath)
        .replace('{PROJECT_NAME}', p.name)
      await sendMessage(session.id, prompt)

      addToast(`Created auto-detect task for ${p.name}`, 'success')
    } catch (e) {
      addToast(String(e), 'error')
    } finally {
      setSuggesting(false)
    }
  }

  const handleExport = async () => {
    const p = selectedProject()
    if (!p) return
    const projectTasks = tasksForProject(p.id)
    if (projectTasks.length === 0) {
      addToast('Create a task first to export config into its worktree', 'error')
      return
    }
    try {
      await ipc.exportProjectConfig(p.id, projectTasks[0].id)
      addToast('Exported .verun.json to worktree — commit it to share', 'success')
    } catch (e) {
      addToast(String(e), 'error')
    }
  }

  const handleImport = async () => {
    const p = selectedProject()
    if (!p) return
    try {
      const hooks = await ipc.importProjectConfig(p.id)
      updateStoreHooks(p.id, hooks.setupHook, hooks.destroyHook, hooks.startCommand)
      setEditSetupHook(hooks.setupHook)
      setEditDestroyHook(hooks.destroyHook)
      setEditStartCommand(hooks.startCommand)
      addToast('Imported config from .verun.json', 'success')
    } catch (e) {
      addToast(String(e), 'error')
    }
  }

  return (
    <div class="flex-1 h-full bg-surface-0 flex">
      {/* Sidebar nav */}
      <div class="w-48 shrink-0 border-r border-border-subtle flex flex-col">
        <Show when={hasOverlayTitlebar}><div class="h-10 shrink-0 drag-region" data-tauri-drag-region /></Show>

        <div class="px-3 pt-4 pb-2">
          <div class="text-[10px] font-medium text-text-dim uppercase tracking-wider">Settings</div>
        </div>

        {/* General */}
        <button
          class={`flex items-center gap-2 mx-2 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
            activeSection() === 'general'
              ? 'bg-surface-3 text-text-secondary'
              : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
          }`}
          onClick={() => setActiveSection('general')}
        >
          <Settings size={13} />
          <span>General</span>
        </button>

        {/* Projects header */}
        <Show when={projects.length > 0}>
          <div class="px-3 pt-4 pb-2">
            <div class="text-[10px] font-medium text-text-dim uppercase tracking-wider">Projects</div>
          </div>
        </Show>

        <div class="flex-1 overflow-y-auto">
          <For each={projects}>
            {(p) => (
              <button
                class={`flex items-center gap-2 mx-2 px-2.5 py-1.5 rounded-md text-xs transition-colors w-[calc(100%-16px)] text-left ${
                  activeSection() === p.id
                    ? 'bg-surface-3 text-text-secondary'
                    : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
                }`}
                onClick={() => selectSettingsSection(p.id)}
                title={p.repoPath}
              >
                <FolderGit2 size={13} class="shrink-0" />
                <span class="truncate">{p.name}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Content pane */}
      <div class="flex-1 h-full overflow-y-auto">
        <Show when={hasOverlayTitlebar}><div class="h-10 shrink-0 drag-region" data-tauri-drag-region /></Show>

        <div class="max-w-lg mx-auto px-6 py-4">
          {/* Header with close button */}
          <div class="flex items-center justify-between mb-6">
            <h1 class="text-lg font-semibold text-text-primary">
              {activeSection() === 'general' ? 'General' : selectedProject()?.name ?? 'Settings'}
            </h1>
            <button
              class="p-1.5 rounded-lg text-text-dim hover:text-text-secondary border border-border hover:border-border-active transition-colors"
              onClick={() => setShowSettings(false)}
              title="Close (Esc)"
            >
              <X size={16} />
            </button>
          </div>

          {/* General section */}
          <Show when={activeSection() === 'general'}>
            {/* Appearance section */}
            <div class="mb-8">
              <h2 class="section-title mb-4">Appearance</h2>

              <div class="flex items-center justify-between">
                <div>
                  <div class="text-sm text-text-primary">Accent color</div>
                  <div class="text-xs text-text-dim mt-0.5">Used for buttons, links, and highlights</div>
                </div>

                <div class="relative">
                  <button
                    class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-2 border border-border hover:border-border-active transition-colors text-sm min-w-[140px]"
                    onClick={() => setDropdownOpen(!dropdownOpen())}
                  >
                    <div
                      class="w-3 h-3 rounded-full shrink-0"
                      style={{ background: current().accent }}
                    />
                    <span class="text-text-secondary flex-1 text-left">{current().name}</span>
                    <ChevronDown size={12} class="text-text-dim" />
                  </button>

                  <Popover open={dropdownOpen()} onClose={() => setDropdownOpen(false)} class="py-1 max-h-64 overflow-y-auto w-48 absolute right-0 top-full mt-1 bg-surface-2 border-border-active">
                    <For each={ACCENT_THEMES}>
                      {(t) => (
                        <button
                          class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors hover:bg-surface-3"
                          style={{
                            color: activeTheme() === t.name ? t.accent : "#a1a1aa",
                            background: activeTheme() === t.name ? t.muted : undefined,
                          }}
                          onClick={() => pickTheme(t)}
                        >
                          <div
                            class="w-3 h-3 rounded-full shrink-0"
                            style={{ background: t.accent }}
                          />
                          <span>{t.name}</span>
                        </button>
                      )}
                    </For>
                  </Popover>
                </div>
              </div>
            </div>

            {/* Code Changes section */}
            <div class="mb-8">
              <h2 class="section-title mb-4">Code Changes</h2>

              <div class="space-y-4">
                <div class="flex items-center justify-between">
                  <div>
                    <div class="text-sm text-text-primary">Wrap lines by default</div>
                    <div class="text-xs text-text-dim mt-0.5">Wrap long lines in diff views</div>
                  </div>
                  <Toggle checked={defaultWrapLines()} onChange={(v) => setDefaultWrapLinesAndPersist(v)} />
                </div>

                <div class="flex items-center justify-between">
                  <div>
                    <div class="text-sm text-text-primary">Hide whitespace by default</div>
                    <div class="text-xs text-text-dim mt-0.5">Ignore whitespace changes in diffs</div>
                  </div>
                  <Toggle checked={defaultHideWhitespace()} onChange={(v) => setDefaultHideWhitespaceAndPersist(v)} />
                </div>
              </div>
            </div>

            {/* Notifications section */}
            <div class="mb-8">
              <h2 class="section-title mb-4">Notifications</h2>
              <div class="flex items-center justify-between">
                <div>
                  <div class="text-sm text-text-primary">Desktop notifications</div>
                  <div class="text-xs text-text-dim mt-0.5">Notify when tasks complete, fail, or need approval</div>
                </div>
                <Toggle checked={notificationsEnabled()} onChange={(v) => setNotificationsEnabledAndPersist(v)} />
              </div>
            </div>
          </Show>

          {/* Per-project hooks section */}
          <Show when={activeSection() !== 'general' && selectedProject()}>
            <div class="mb-8">
              <div class="flex items-center justify-between mb-4">
                <h2 class="section-title">Lifecycle Hooks</h2>
                <button
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-surface-2 border border-border hover:border-border-active text-text-muted hover:text-text-secondary transition-colors disabled:opacity-40"
                  onClick={runAutoDetect}
                  disabled={suggesting()}
                >
                  <Show when={suggesting()} fallback={<Sparkles size={12} />}>
                    <Loader2 size={12} class="animate-spin" />
                  </Show>
                  Auto-detect
                </button>
              </div>

              <div class="space-y-5">
                <div>
                  <label class="block text-sm text-text-primary mb-1.5">Setup hook</label>
                  <div class="text-xs text-text-dim mb-2">Runs after worktree creation</div>
                  <CodeTextarea
                    value={editSetupHook()}
                    onInput={setEditSetupHook}
                    onSave={saveHooks}
                    placeholder='cp "$VERUN_REPO_PATH/.env" .env && pnpm install'
                    minRows={2}
                  />
                </div>

                <div>
                  <label class="block text-sm text-text-primary mb-1.5">Destroy hook</label>
                  <div class="text-xs text-text-dim mb-2">Runs before worktree deletion</div>
                  <CodeTextarea
                    value={editDestroyHook()}
                    onInput={setEditDestroyHook}
                    onSave={saveHooks}
                    placeholder="cleanup commands"
                    minRows={1}
                  />
                </div>

                <div>
                  <label class="block text-sm text-text-primary mb-1.5">Start command</label>
                  <div class="text-xs text-text-dim mb-2">Auto-runs in terminal for each new task</div>
                  <CodeTextarea
                    value={editStartCommand()}
                    onInput={setEditStartCommand}
                    onSave={saveHooks}
                    placeholder="pnpm dev"
                    minRows={1}
                  />
                </div>
              </div>

              <div class="mt-6 flex items-center justify-between">
                <button
                  class="btn-primary text-xs px-4 py-1.5 disabled:opacity-40"
                  onClick={saveHooks}
                  disabled={saving() || !hasChanges()}
                >
                  <Show when={saving()} fallback="Save">
                    <Loader2 size={12} class="animate-spin" />
                  </Show>
                </button>

                <div class="flex items-center gap-2">
                  <button
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-surface-2 border border-border hover:border-border-active text-text-muted hover:text-text-secondary transition-colors"
                    onClick={handleImport}
                    title="Import from .verun.json in repo"
                  >
                    <Download size={12} />
                    Import
                  </button>
                  <button
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-surface-2 border border-border hover:border-border-active text-text-muted hover:text-text-secondary transition-colors"
                    onClick={handleExport}
                    title="Export to .verun.json in a task worktree"
                  >
                    <Upload size={12} />
                    Export
                  </button>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
