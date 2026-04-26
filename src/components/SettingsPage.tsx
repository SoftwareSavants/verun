import { Component, createSignal, createEffect, on, For, Show, type JSX } from 'solid-js'
import { ChevronDown, ChevronRight, X, Check, Settings, FolderGit2, Loader2, Sparkles, Download, Upload, GitBranch, Palette, ArrowUp, RotateCcw, ListChecks } from 'lucide-solid'
import {
  appearance, setAppearance,
  THEME_PRESETS, findThemePreset,
  UI_FONT_PRESETS, CODE_FONT_PRESETS,
  resolveMode, resolvePalette,
  type ThemeMode, type Density, type ThemePreset, type PaletteOverrides,
} from '../lib/theme'
import { setShowSettings, setSelectedTaskId, setSelectedSessionIdForTask, defaultWrapLines, setDefaultWrapLinesAndPersist, defaultHideWhitespace, setDefaultHideWhitespaceAndPersist, sidebarWidth } from '../store/ui'
import { notificationsEnabled, setNotificationsEnabledAndPersist } from '../lib/notifications'
import { projects, updateHooks, updateStoreHooks, updateBaseBranch } from '../store/projects'
import { createTask, activeTasksForProject } from '../store/tasks'
import { sendMessage, setSessions, setOutputItems } from '../store/sessions'
import * as ipc from '../lib/ipc'
import { Popover } from './Popover'
import { hasOverlayTitlebar } from '../lib/platform'
import { Toggle } from './Toggle'
import { CodeTextarea } from './CodeTextarea'
import { QuantityStepper } from './QuantityStepper'
import { StorageSettings } from './StorageSettings'
import { ColorPicker } from './ColorPicker'
import { addToast } from '../store/ui'
import { AUTODETECT_PROMPT } from '../lib/autodetect-prompt'
import { produce } from 'solid-js/store'

type SettingsSection = 'general' | 'appearance' | string // project id

// Module-level signals so Layout can drive section switching and save via keyboard shortcuts
const [activeSection, setActiveSection] = createSignal<SettingsSection>('general')
const [editSetupHook, setEditSetupHook] = createSignal('')
const [editDestroyHook, setEditDestroyHook] = createSignal('')
const [editStartCommand, setEditStartCommand] = createSignal('')
const [editAutoStart, setEditAutoStart] = createSignal(false)
export const [settingsSaveRequested, setSettingsSaveRequested] = createSignal(0)

export function selectSettingsSection(section: SettingsSection) {
  setActiveSection(section)
  if (section === 'general') return
  const p = projects.find(pr => pr.id === section)
  if (p) {
    setEditSetupHook(p.setupHook)
    setEditDestroyHook(p.destroyHook)
    setEditStartCommand(p.startCommand)
    setEditAutoStart(p.autoStart)
  }
}

export const SettingsPage: Component = () => {
  const [saving, setSaving] = createSignal(false)
  const [suggesting, setSuggesting] = createSignal(false)
  const [branchDropdownOpen, setBranchDropdownOpen] = createSignal(false)
  const [branchOptions, setBranchOptions] = createSignal<string[]>([])
  const [loadingBranches, setLoadingBranches] = createSignal(false)
  const [uiFontDropdownOpen, setUiFontDropdownOpen] = createSignal(false)
  const [codeFontDropdownOpen, setCodeFontDropdownOpen] = createSignal(false)
  const [uiFontCustom, setUiFontCustom] = createSignal('')
  const [codeFontCustom, setCodeFontCustom] = createSignal('')
  const [importDropdownOpen, setImportDropdownOpen] = createSignal(false)
  const [exportDropdownOpen, setExportDropdownOpen] = createSignal(false)

  // Populate edit fields from active project on mount
  const section = activeSection()
  if (section !== 'general') {
    const p = projects.find(pr => pr.id === section)
    if (p) {
      setEditSetupHook(p.setupHook)
      setEditDestroyHook(p.destroyHook)
      setEditStartCommand(p.startCommand)
      setEditAutoStart(p.autoStart)
    }
  }

  const hasChanges = () => {
    const p = selectedProject()
    if (!p) return false
    return editSetupHook() !== p.setupHook
      || editDestroyHook() !== p.destroyHook
      || editStartCommand() !== p.startCommand
      || editAutoStart() !== p.autoStart
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
      await updateHooks(p.id, editSetupHook(), editDestroyHook(), editStartCommand(), editAutoStart())
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
      setSelectedSessionIdForTask(task.id, session.id)
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

  const handleExport = async (taskId?: string) => {
    const p = selectedProject()
    if (!p) return
    try {
      await ipc.exportProjectConfig(p.id, taskId)
      const source = taskId ? 'task worktree' : 'main repo'
      addToast(`Exported .verun.json (${source}) - commit it to share`, 'success')
    } catch (e) {
      addToast(String(e), 'error')
    }
  }

  const handleImport = async (taskId?: string) => {
    const p = selectedProject()
    if (!p) return
    try {
      const hooks = await ipc.importProjectConfig(p.id, taskId)
      updateStoreHooks(p.id, hooks.setupHook, hooks.destroyHook, hooks.startCommand)
      setEditSetupHook(hooks.setupHook)
      setEditDestroyHook(hooks.destroyHook)
      setEditStartCommand(hooks.startCommand)
      const source = taskId ? 'task worktree' : 'main repo'
      addToast(`Imported config from .verun.json (${source})`, 'success')
    } catch (e) {
      addToast(String(e), 'error')
    }
  }

  return (
    <div class="flex-1 h-full bg-surface-0 flex">
      {/* Sidebar nav */}
      <div style={{ width: `${sidebarWidth()}px` }} class="shrink-0 border-r border-border-subtle bg-surface-1 flex flex-col">
        <div class="px-2 pt-10 pb-1.5 drag-region" data-tauri-drag-region>
          <span class="text-[10px] font-semibold uppercase tracking-wider text-text-muted px-1 no-drag">Settings</span>
        </div>

        {/* General */}
        <button
          class={`flex items-center gap-2.5 mx-2 px-3 py-2 rounded-md text-sm transition-colors ${
            activeSection() === 'general'
              ? 'bg-surface-3 text-text-secondary'
              : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
          }`}
          onClick={() => setActiveSection('general')}
        >
          <Settings size={15} />
          <span>General</span>
        </button>

        {/* Appearance */}
        <button
          class={`flex items-center gap-2.5 mx-2 mt-0.5 px-3 py-2 rounded-md text-sm transition-colors ${
            activeSection() === 'appearance'
              ? 'bg-surface-3 text-text-secondary'
              : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
          }`}
          onClick={() => setActiveSection('appearance')}
        >
          <Palette size={15} />
          <span>Appearance</span>
        </button>

        {/* Projects header */}
        <Show when={projects.length > 0}>
          <div class="px-3 pt-4 pb-2">
            <div class="text-[11px] font-medium text-text-dim uppercase tracking-wider">Projects</div>
          </div>
        </Show>

        <div class="flex-1 overflow-y-auto">
          <For each={projects}>
            {(p) => (
              <button
                class={`flex items-center gap-2.5 mx-2 px-3 py-2 rounded-md text-sm transition-colors w-[calc(100%-16px)] text-left ${
                  activeSection() === p.id
                    ? 'bg-surface-3 text-text-secondary'
                    : 'text-text-muted hover:text-text-secondary hover:bg-surface-2'
                }`}
                onClick={() => selectSettingsSection(p.id)}
                title={p.repoPath}
              >
                <FolderGit2 size={15} class="shrink-0" />
                <span class="truncate">{p.name}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Content pane */}
      <div class="flex-1 h-full overflow-y-auto">
        <Show when={hasOverlayTitlebar}><div class="h-10 shrink-0 drag-region" data-tauri-drag-region /></Show>

        <div class="max-w-2xl mx-auto px-6 py-4">
          {/* Header with close button */}
          <div class="flex items-center justify-between mb-6">
            <h1 class="text-lg font-semibold text-text-primary">
              {activeSection() === 'general' ? 'General' : activeSection() === 'appearance' ? 'Appearance' : selectedProject()?.name ?? 'Settings'}
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

            <StorageSettings />
          </Show>

          {/* Appearance section */}
          <Show when={activeSection() === 'appearance'}>
            <AppearanceSettings
              uiFontDropdownOpen={uiFontDropdownOpen}
              setUiFontDropdownOpen={setUiFontDropdownOpen}
              codeFontDropdownOpen={codeFontDropdownOpen}
              setCodeFontDropdownOpen={setCodeFontDropdownOpen}
              uiFontCustom={uiFontCustom}
              setUiFontCustom={setUiFontCustom}
              codeFontCustom={codeFontCustom}
              setCodeFontCustom={setCodeFontCustom}
            />
          </Show>

          {/* Per-project settings */}
          <Show when={activeSection() !== 'general' && activeSection() !== 'appearance' && selectedProject()}>
            {/* Repository section */}
            <div class="mb-8">
              <h2 class="section-title mb-4">Repository</h2>

              <div class="flex items-center justify-between">
                <div>
                  <div class="text-sm text-text-primary">Base branch</div>
                  <div class="text-xs text-text-dim mt-0.5">New tasks branch off from this</div>
                </div>

                <div class="relative">
                  <button
                    class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-2 border border-border hover:border-border-active transition-colors text-sm min-w-[140px] max-w-[220px]"
                    onClick={async () => {
                      const p = selectedProject()
                      if (!p) return
                      if (!branchDropdownOpen()) {
                        setLoadingBranches(true)
                        setBranchDropdownOpen(true)
                        try {
                          const info = await ipc.getRepoInfo(p.repoPath)
                          setBranchOptions(info.branches)
                        } catch {
                          setBranchOptions([p.baseBranch])
                        } finally {
                          setLoadingBranches(false)
                        }
                      } else {
                        setBranchDropdownOpen(false)
                      }
                    }}
                  >
                    <GitBranch size={13} class="text-text-dim shrink-0" />
                    <span class="text-text-secondary flex-1 text-left truncate" title={selectedProject()!.baseBranch}>{selectedProject()!.baseBranch}</span>
                    <Show when={loadingBranches()} fallback={<ChevronDown size={12} class="text-text-dim" />}>
                      <Loader2 size={12} class="text-text-dim animate-spin" />
                    </Show>
                  </button>

                  <Popover open={branchDropdownOpen()} onClose={() => setBranchDropdownOpen(false)} class="py-1 max-h-64 overflow-y-auto w-56 absolute right-0 top-full mt-1 bg-surface-2 border-border-active">
                    <For each={branchOptions()}>
                      {(branch) => (
                        <button
                          class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors hover:bg-surface-3"
                          style={{
                            color: selectedProject()!.baseBranch === branch ? "var(--accent)" : "#a1a1aa",
                            background: selectedProject()!.baseBranch === branch ? "var(--accent-muted)" : undefined,
                          }}
                          onClick={async () => {
                            const p = selectedProject()
                            if (p) {
                              await updateBaseBranch(p.id, branch)
                              addToast(`Base branch set to ${branch}`, 'success')
                            }
                            setBranchDropdownOpen(false)
                          }}
                        >
                          <GitBranch size={13} class="shrink-0" />
                          <span class="truncate" title={branch}>{branch}</span>
                        </button>
                      )}
                    </For>
                  </Popover>
                </div>
              </div>
            </div>

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
                  <div class="text-xs text-text-dim mb-2">Runs in a read-only terminal tab via the Start button or auto-start</div>
                  <CodeTextarea
                    value={editStartCommand()}
                    onInput={setEditStartCommand}
                    onSave={saveHooks}
                    placeholder="pnpm dev"
                    minRows={1}
                  />
                </div>

                <div class="flex items-center justify-between">
                  <div>
                    <label class="block text-sm text-text-primary">Auto-start</label>
                    <div class="text-xs text-text-dim mt-0.5">Automatically run the start command when a new task is created</div>
                  </div>
                  <Toggle checked={editAutoStart()} onChange={setEditAutoStart} />
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
                  <div class="relative">
                    <button
                      class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-surface-2 border border-border hover:border-border-active text-text-muted hover:text-text-secondary transition-colors"
                      onClick={() => setImportDropdownOpen(!importDropdownOpen())}
                      title="Import from .verun.json in the main repo or a task worktree"
                    >
                      <Download size={12} />
                      Import
                      <ChevronDown size={12} class="text-text-dim" />
                    </button>
                    <Popover
                      open={importDropdownOpen()}
                      onClose={() => setImportDropdownOpen(false)}
                      class="py-1 max-h-64 overflow-y-auto w-56 absolute right-0 bottom-full mb-1 bg-surface-2 border-border-active"
                    >
                      <button
                        class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 transition-colors"
                        onClick={() => {
                          setImportDropdownOpen(false)
                          handleImport()
                        }}
                      >
                        <FolderGit2 size={13} class="shrink-0" />
                        <span class="truncate" title={selectedProject()?.repoPath}>Main repo</span>
                      </button>
                      <Show when={activeTasksForProject(selectedProject()?.id ?? '').length > 0}>
                        <div class="border-t border-border-subtle my-1" />
                        <div class="px-3 py-1 text-[10px] uppercase tracking-wider text-text-dim">Tasks</div>
                        <For each={activeTasksForProject(selectedProject()?.id ?? '')}>
                          {(t) => (
                            <button
                              class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 transition-colors"
                              onClick={() => {
                                setImportDropdownOpen(false)
                                handleImport(t.id)
                              }}
                            >
                              <GitBranch size={13} class="shrink-0" />
                              <span class="truncate" title={t.worktreePath}>{t.name ?? t.branch}</span>
                            </button>
                          )}
                        </For>
                      </Show>
                    </Popover>
                  </div>
                  <div class="relative">
                    <button
                      class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-surface-2 border border-border hover:border-border-active text-text-muted hover:text-text-secondary transition-colors"
                      onClick={() => setExportDropdownOpen(!exportDropdownOpen())}
                      title="Export to .verun.json in the main repo or a task worktree"
                    >
                      <Upload size={12} />
                      Export
                      <ChevronDown size={12} class="text-text-dim" />
                    </button>
                    <Popover
                      open={exportDropdownOpen()}
                      onClose={() => setExportDropdownOpen(false)}
                      class="py-1 max-h-64 overflow-y-auto w-56 absolute right-0 bottom-full mb-1 bg-surface-2 border-border-active"
                    >
                      <button
                        class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 transition-colors"
                        onClick={() => {
                          setExportDropdownOpen(false)
                          handleExport()
                        }}
                      >
                        <FolderGit2 size={13} class="shrink-0" />
                        <span class="truncate" title={selectedProject()?.repoPath}>Main repo</span>
                      </button>
                      <Show when={activeTasksForProject(selectedProject()?.id ?? '').length > 0}>
                        <div class="border-t border-border-subtle my-1" />
                        <div class="px-3 py-1 text-[10px] uppercase tracking-wider text-text-dim">Tasks</div>
                        <For each={activeTasksForProject(selectedProject()?.id ?? '')}>
                          {(t) => (
                            <button
                              class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 transition-colors"
                              onClick={() => {
                                setExportDropdownOpen(false)
                                handleExport(t.id)
                              }}
                            >
                              <GitBranch size={13} class="shrink-0" />
                              <span class="truncate" title={t.worktreePath}>{t.name ?? t.branch}</span>
                            </button>
                          )}
                        </For>
                      </Show>
                    </Popover>
                  </div>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Appearance settings — broken out so SettingsPage stays scannable
// ---------------------------------------------------------------------------

interface SegmentedOption<T extends string> { value: T; label: string }
function Segmented<T extends string>(props: { value: T; options: SegmentedOption<T>[]; onChange: (v: T) => void }): JSX.Element {
  return (
    <div class="inline-flex bg-surface-2 ring-1 ring-outline/8 rounded-lg p-0.5">
      <For each={props.options}>
        {(opt) => {
          const active = () => props.value === opt.value
          return (
            <button
              class="px-3 py-1 text-xs rounded-md transition-colors"
              classList={{
                'bg-surface-3 text-text-primary': active(),
                'text-text-dim hover:text-text-secondary': !active(),
              }}
              onClick={() => props.onChange(opt.value)}
            >
              {opt.label}
            </button>
          )
        }}
      </For>
    </div>
  )
}

interface AppearancePropsLocal {
  uiFontDropdownOpen: () => boolean
  setUiFontDropdownOpen: (v: boolean) => void
  codeFontDropdownOpen: () => boolean
  setCodeFontDropdownOpen: (v: boolean) => void
  uiFontCustom: () => string
  setUiFontCustom: (v: string) => void
  codeFontCustom: () => string
  setCodeFontCustom: (v: string) => void
}

const AppearanceSettings: Component<AppearancePropsLocal> = (props) => {
  const prefs = appearance

  const isCustomFont = (name: string, presets: { name: string }[]) =>
    !presets.some(p => p.name === name)

  const setLightOverrides = (next: PaletteOverrides) => setAppearance({ lightOverrides: next })
  const setDarkOverrides  = (next: PaletteOverrides) => setAppearance({ darkOverrides:  next })

  return (
    <>
      {/* Live preview */}
      <AppearancePreview />

      {/* Theme — mode first, then preset */}
      <div class="mb-8">
        <h2 class="section-title mb-4">Theme</h2>
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-text-primary">Mode</div>
              <div class="text-xs text-text-dim mt-0.5">System follows your OS setting</div>
            </div>
            <Segmented
              value={prefs().mode}
              options={[
                { value: 'system' as ThemeMode, label: 'System' },
                { value: 'light'  as ThemeMode, label: 'Light' },
                { value: 'dark'   as ThemeMode, label: 'Dark' },
              ]}
              onChange={(v) => setAppearance({ mode: v })}
            />
          </div>
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-text-primary">Preset</div>
              <div class="text-xs text-text-dim mt-0.5">Bundles accent, surface, and foreground</div>
            </div>
            <ThemePresetPicker
              value={prefs().themePreset}
              onChange={(name) => setAppearance({ themePreset: name })}
            />
          </div>
        </div>
      </div>

      {/* Custom colors — only meaningful when the user has explicitly opted
          into the Custom preset. Other presets stay tweak-free so users don't
          accidentally drift from a curated palette. */}
      <Show when={prefs().themePreset === 'Custom'}>
        <div class="mb-8">
          <h2 class="section-title mb-4">Custom colors</h2>
          <div class="space-y-6">
            <Show when={prefs().mode !== 'dark'}>
              <PaletteOverrideGroup
                title={prefs().mode === 'system' ? 'Light' : undefined}
                mode="light"
                preset={findThemePreset(prefs().themePreset)}
                overrides={prefs().lightOverrides}
                onChange={setLightOverrides}
              />
            </Show>
            <Show when={prefs().mode !== 'light'}>
              <PaletteOverrideGroup
                title={prefs().mode === 'system' ? 'Dark' : undefined}
                mode="dark"
                preset={findThemePreset(prefs().themePreset)}
                overrides={prefs().darkOverrides}
                onChange={setDarkOverrides}
              />
            </Show>
          </div>
        </div>
      </Show>

      {/* Typography */}
      <div class="mb-8">
        <h2 class="section-title mb-4">Typography</h2>
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-text-primary">UI font</div>
              <div class="text-xs text-text-dim mt-0.5">Sidebar, menus, settings</div>
            </div>
            <FontDropdown
              open={props.uiFontDropdownOpen}
              setOpen={props.setUiFontDropdownOpen}
              custom={props.uiFontCustom}
              setCustom={props.setUiFontCustom}
              value={prefs().uiFont}
              presets={UI_FONT_PRESETS}
              onChange={(v) => setAppearance({ uiFont: v })}
              isCustom={isCustomFont(prefs().uiFont, UI_FONT_PRESETS)}
            />
          </div>

          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-text-primary">Code font</div>
              <div class="text-xs text-text-dim mt-0.5">Code blocks and terminals</div>
            </div>
            <FontDropdown
              open={props.codeFontDropdownOpen}
              setOpen={props.setCodeFontDropdownOpen}
              custom={props.codeFontCustom}
              setCustom={props.setCodeFontCustom}
              value={prefs().codeFont}
              presets={CODE_FONT_PRESETS}
              onChange={(v) => setAppearance({ codeFont: v })}
              isCustom={isCustomFont(prefs().codeFont, CODE_FONT_PRESETS)}
            />
          </div>

          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-text-primary">UI font size</div>
              <div class="text-xs text-text-dim mt-0.5">Base size for the app</div>
            </div>
            <QuantityStepper
              value={prefs().uiFontSize}
              min={11}
              max={16}
              onChange={(v) => setAppearance({ uiFontSize: v })}
            />
          </div>

          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-text-primary">Code font size</div>
              <div class="text-xs text-text-dim mt-0.5">Code blocks and terminals</div>
            </div>
            <QuantityStepper
              value={prefs().codeFontSize}
              min={10}
              max={20}
              onChange={(v) => setAppearance({ codeFontSize: v })}
            />
          </div>
        </div>
      </div>

      {/* Layout */}
      <div class="mb-8">
        <h2 class="section-title mb-4">Layout</h2>
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm text-text-primary">Density</div>
            <div class="text-xs text-text-dim mt-0.5">Spacing of buttons and lists</div>
          </div>
          <Segmented
            value={prefs().density}
            options={[
              { value: 'compact'     as Density, label: 'Compact' },
              { value: 'normal'      as Density, label: 'Normal' },
              { value: 'comfortable' as Density, label: 'Comfortable' },
            ]}
            onChange={(v) => setAppearance({ density: v })}
          />
        </div>
      </div>

      {/* Terminal */}
      <div class="mb-8">
        <h2 class="section-title mb-4">Terminal</h2>
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm text-text-primary">Cursor blink</div>
            <div class="text-xs text-text-dim mt-0.5">Blink the terminal cursor</div>
          </div>
          <Toggle checked={prefs().cursorBlink} onChange={(v) => setAppearance({ cursorBlink: v })} />
        </div>
      </div>

      {/* Motion */}
      <div class="mb-8">
        <h2 class="section-title mb-4">Motion</h2>
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm text-text-primary">Reduced motion</div>
            <div class="text-xs text-text-dim mt-0.5">Disable animations and transitions</div>
          </div>
          <Toggle checked={prefs().reducedMotion} onChange={(v) => setAppearance({ reducedMotion: v })} />
        </div>
      </div>
    </>
  )
}

// Theme preset dropdown showing a mini palette swatch (surface / accent / foreground)
const ThemeSwatch: Component<{ palette: { surface: string; accent: string; foreground: string } }> = (p) => (
  <div class="flex items-center">
    <span class="w-3.5 h-3.5 rounded-full ring-1 ring-outline/8" style={{ background: p.palette.surface }} />
    <span class="w-3.5 h-3.5 rounded-full ring-1 ring-outline/8 -ml-1.5" style={{ background: p.palette.accent }} />
    <span class="w-3.5 h-3.5 rounded-full ring-1 ring-outline/8 -ml-1.5" style={{ background: p.palette.foreground }} />
  </div>
)

// For the Custom preset, the swatch should reflect the user's tweaks (not the
// hardcoded base palette), so you can see at a glance what your custom theme
// looks like. Other presets always show their canonical colors.
function previewPalette(presetName: string): { surface: string; accent: string; foreground: string } {
  const preset = findThemePreset(presetName)
  if (presetName !== 'Custom') return preset.dark
  const prefs = appearance()
  const mode = resolveMode(prefs.mode)
  return resolvePalette(prefs, mode)
}

const ThemePresetPicker: Component<{ value: string; onChange: (name: string) => void }> = (p) => {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="relative">
      <button
        class="flex items-center gap-2.5 px-3 py-1.5 rounded-lg bg-surface-2 border border-border hover:border-border-active transition-colors text-sm min-w-[180px]"
        onClick={() => setOpen(!open())}
      >
        <ThemeSwatch palette={previewPalette(p.value)} />
        <span class="text-text-secondary flex-1 text-left">{p.value}</span>
        <ChevronDown size={12} class="text-text-dim" />
      </button>
      <Popover
        open={open()}
        onClose={() => setOpen(false)}
        class="py-1 w-56 absolute right-0 top-full mt-1 bg-surface-2 border-border-active"
      >
        <For each={THEME_PRESETS}>
          {(preset) => {
            const active = () => p.value === preset.name
            return (
              <button
                class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs hover:bg-surface-3 transition-colors"
                onClick={() => { p.onChange(preset.name); setOpen(false) }}
              >
                <ThemeSwatch palette={previewPalette(preset.name)} />
                <span class="flex-1 text-left text-text-secondary">{preset.name}</span>
                <Show when={active()}>
                  <Check size={12} class="text-accent" />
                </Show>
              </button>
            )
          }}
        </For>
      </Popover>
    </div>
  )
}

// One palette-override group (3 color rows) for one mode
interface OverrideGroupProps {
  title?: string
  mode: 'light' | 'dark'
  preset: ThemePreset
  overrides: PaletteOverrides
  onChange: (next: PaletteOverrides) => void
}

const PaletteOverrideGroup: Component<OverrideGroupProps> = (p) => {
  const setKey = (key: keyof PaletteOverrides, hex: string) => {
    p.onChange({ ...p.overrides, [key]: hex })
  }
  const resetKey = (key: keyof PaletteOverrides) => {
    const next = { ...p.overrides }
    delete next[key]
    p.onChange(next)
  }
  const row = (key: keyof PaletteOverrides, label: string) => (
    <PaletteOverrideRow
      label={label}
      presetHex={p.preset[p.mode][key]}
      overrideHex={p.overrides[key]}
      onSet={(hex) => setKey(key, hex)}
      onReset={() => resetKey(key)}
    />
  )
  return (
    <div class="space-y-3">
      <Show when={p.title}>
        <div class="text-[10px] font-medium uppercase tracking-wider text-text-muted">{p.title}</div>
      </Show>
      {row('accent',     'Accent')}
      {row('surface',    'Surface')}
      {row('foreground', 'Foreground')}
    </div>
  )
}

const PaletteOverrideRow: Component<{
  label: string
  presetHex: string
  overrideHex: string | undefined
  onSet: (hex: string) => void
  onReset: () => void
}> = (p) => {
  const resolved = () => p.overrideHex ?? p.presetHex
  const [open, setOpen] = createSignal(false)
  return (
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-3 min-w-0">
        <div class="relative">
          <button
            class="w-8 h-8 rounded-lg ring-1 ring-outline/8 hover:ring-outline/20 transition-shadow"
            style={{ background: resolved() }}
            title="Pick a color"
            onClick={() => setOpen(!open())}
          />
          <Popover
            open={open()}
            onClose={() => setOpen(false)}
            class="absolute left-0 top-full mt-2 w-64 p-3 bg-surface-2 border-border-active"
          >
            <ColorPicker value={resolved()} onChange={p.onSet} />
          </Popover>
        </div>
        <div class="min-w-0">
          <div class="text-sm text-text-primary">{p.label}</div>
          <div class="text-[11px] text-text-dim font-mono mt-0.5">{resolved()}</div>
        </div>
      </div>
      <Show when={p.overrideHex !== undefined}>
        <button
          class="flex items-center gap-1 text-[11px] text-text-muted hover:text-text-secondary transition-colors"
          onClick={p.onReset}
          title="Reset to preset"
        >
          <RotateCcw size={11} />
          Reset
        </button>
      </Show>
    </div>
  )
}

interface FontDropdownProps {
  open: () => boolean
  setOpen: (v: boolean) => void
  custom: () => string
  setCustom: (v: string) => void
  value: string
  presets: { name: string; stack: string }[]
  onChange: (name: string) => void
  isCustom: boolean
}

const FontDropdown: Component<FontDropdownProps> = (props) => {
  const label = () => props.isCustom ? `Custom (${props.value})` : props.value

  const pickPreset = (name: string) => {
    props.onChange(name)
    props.setOpen(false)
  }

  const applyCustom = (val: string) => {
    props.setCustom(val)
    if (val.trim()) props.onChange(val.trim())
  }

  return (
    <div class="relative">
      <button
        class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-2 border border-border hover:border-border-active transition-colors text-sm min-w-[180px]"
        onClick={() => props.setOpen(!props.open())}
      >
        <span class="text-text-secondary flex-1 text-left truncate">{label()}</span>
        <ChevronDown size={12} class="text-text-dim" />
      </button>
      <Popover
        open={props.open()}
        onClose={() => props.setOpen(false)}
        class="py-1 w-56 absolute right-0 top-full mt-1 bg-surface-2 border-border-active"
      >
        <For each={props.presets}>
          {(preset) => {
            const active = () => !props.isCustom && props.value === preset.name
            return (
              <button
                class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors hover:bg-surface-3"
                style={{
                  color: active() ? 'var(--accent)' : '#a1a1aa',
                  background: active() ? 'var(--accent-muted)' : undefined,
                  'font-family': preset.stack,
                }}
                onClick={() => pickPreset(preset.name)}
              >
                <span class="flex-1 text-left">{preset.name}</span>
              </button>
            )
          }}
        </For>
        <div class="border-t border-border-subtle my-1" />
        <div class="px-3 py-2">
          <div class="text-[10px] uppercase tracking-wider text-text-dim mb-1.5">Custom</div>
          <input
            type="text"
            class="w-full bg-surface-1 ring-1 ring-outline/8 rounded px-2 py-1 text-xs text-text-secondary outline-none focus:ring-accent/40"
            value={props.isCustom ? props.value : props.custom()}
            placeholder="Font family name"
            onInput={(e) => applyCustom(e.currentTarget.value)}
          />
        </div>
      </Popover>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Live preview — a faux Verun window that exercises the parts of the UI most
// affected by the appearance settings (surfaces, accent, status colors, fonts,
// density, both font families). Everything reads from the live CSS vars, so it
// re-renders instantly on every change — no signal wiring needed.
// ---------------------------------------------------------------------------

const AppearancePreview: Component = () => {
  return (
    <div class="mb-8">
      <h2 class="section-title mb-3">Preview</h2>
      <div class="rounded-xl ring-1 ring-outline/8 overflow-hidden bg-surface-0 select-none">
        {/* Chat */}
        <div class="px-5 py-5 flex flex-col gap-3">
          {/* User bubble */}
          <div class="self-end max-w-[75%] rounded-2xl rounded-br-md bg-accent/15 ring-1 ring-accent/20 px-3 py-2 text-[12px] text-text-primary leading-snug">
            Add a light theme to the app
          </div>
          {/* Thinking */}
          <div class="flex items-center gap-1 text-[11px] text-text-muted">
            <ChevronRight class="w-3 h-3" />
            <span>Thought for 4s</span>
          </div>
          {/* Assistant text */}
          <div class="text-[12px] text-text-primary leading-relaxed">
            Sure - I'll wire up <span class="font-mono text-syntax-function bg-surface-1 px-1 rounded">applyAppearance</span> so the choice persists.
          </div>
          {/* Inline code-change block (single-file diff with real syntax highlighting) */}
          <div class="rounded-lg ring-1 ring-outline/8 bg-surface-1 overflow-hidden">
            <div class="flex items-center justify-between px-3 py-2 bg-surface-2">
              <span class="font-mono text-[11px] text-text-secondary">src/lib/theme.ts</span>
              <span class="flex items-center gap-2 font-mono text-[11px]">
                <span class="text-status-running">+4</span>
                <span class="text-status-error">-1</span>
              </span>
            </div>
            <div class="font-mono leading-relaxed py-2" style={{ 'font-size': 'var(--font-code-size)' }}>
              <CodeLine kind="del">
                <Kw>const</Kw> <Fn>applyTheme</Fn> <Op>=</Op> <Pn>(</Pn>mode<Pn>)</Pn> <Op>=&gt;</Op> <Pn>{'{'}</Pn>
              </CodeLine>
              <CodeLine kind="add">
                <Kw>const</Kw> <Fn>applyAppearance</Fn> <Op>=</Op> <Pn>(</Pn>prefs<Pn>)</Pn> <Op>=&gt;</Op> <Pn>{'{'}</Pn>
              </CodeLine>
              <CodeLine kind="ctx">
                {'  '}<Cm>{'// Resolve light / dark / system'}</Cm>
              </CodeLine>
              <CodeLine kind="add">
                {'  '}<Kw>const</Kw> mode <Op>=</Op> <Fn>resolveMode</Fn><Pn>(</Pn>prefs.mode<Pn>)</Pn>
              </CodeLine>
              <CodeLine kind="add">
                {'  '}root.dataset.theme <Op>=</Op> <St>"dark"</St>
              </CodeLine>
              <CodeLine kind="add">
                {'  '}<Fn>applyPalette</Fn><Pn>(</Pn><Fn>resolvePalette</Fn><Pn>(</Pn>prefs<Pn>,</Pn> mode<Pn>))</Pn>
              </CodeLine>
              <CodeLine kind="ctx">
                <Pn>{'}'}</Pn>
              </CodeLine>
            </div>
          </div>
        </div>
        {/* Composer */}
        <div class="px-3 pb-3">
          <div class="rounded-xl bg-surface-1 ring-1 ring-outline/8 px-3 py-2.5 flex flex-col gap-2">
            <div class="text-[12px] text-text-dim">Reply to Claude...</div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-1">
                {/* Model chip — mirrors MessageInput's layout/hierarchy */}
                <span class="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-text-secondary hover:bg-surface-2 transition-colors">
                  <Sparkles class="w-3 h-3 text-accent" />
                  <span>Claude Opus 4.7</span>
                </span>
                {/* Plan toggle, shown active so the accent color is visible */}
                <span class="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-accent">
                  <ListChecks class="w-3 h-3" />
                  <span>Plan</span>
                </span>
              </div>
              <button class="w-6 h-6 rounded-md bg-accent hover:bg-accent-hover flex items-center justify-center transition-colors">
                <ArrowUp class="w-3 h-3 text-accent-foreground" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Diff line with consistent gutter and full-width tinted background.
const CodeLine: Component<{ kind: 'add' | 'del' | 'ctx'; children: JSX.Element }> = (p) => {
  const bg  = p.kind === 'add' ? 'bg-status-running/10' : p.kind === 'del' ? 'bg-status-error/10' : ''
  const sym = p.kind === 'add' ? '+' : p.kind === 'del' ? '-' : ' '
  const symColor = p.kind === 'add' ? 'text-status-running' : p.kind === 'del' ? 'text-status-error' : 'text-text-dim'
  return (
    <div class={`flex items-baseline ${bg}`}>
      <span class={`w-7 text-center shrink-0 ${symColor}`}>{sym}</span>
      <span class="text-text-primary whitespace-pre">{p.children}</span>
    </div>
  )
}

// Tiny named spans so the JSX above stays readable - one per syntax token type.
const Kw: Component<{ children: JSX.Element }> = (p) => <span class="text-syntax-keyword">{p.children}</span>
const Fn: Component<{ children: JSX.Element }> = (p) => <span class="text-syntax-function">{p.children}</span>
const St: Component<{ children: JSX.Element }> = (p) => <span class="text-syntax-string">{p.children}</span>
const Cm: Component<{ children: JSX.Element }> = (p) => <span class="text-syntax-comment italic">{p.children}</span>
const Op: Component<{ children: JSX.Element }> = (p) => <span class="text-text-secondary">{p.children}</span>
const Pn: Component<{ children: JSX.Element }> = (p) => <span class="text-text-muted">{p.children}</span>
