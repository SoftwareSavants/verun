import { Component, createSignal, createMemo, For, Show, onCleanup, onMount, createEffect } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { Check, Copy, RotateCcw, Rocket, WifiOff, AlertTriangle } from 'lucide-solid'
import type { PackageManager } from '@better-t-stack/types'
import { Dialog } from './Dialog'
import { PathAutocomplete } from './PathAutocomplete'
import { BtsLogPane } from './BtsLogPane'
import {
  applyOption,
  buildCliArgs,
  buildCommandPreview,
  coerceDependencies,
  defaultVerunConfig,
  diffConfig,
  fullstackLabel,
  isNativeFrontend,
  optionDisabledReason,
  pmRunner,
  resolveForOption,
  validateCompatibility,
  type BtsConfig,
} from '../lib/btsStack'
import { BTS_CATEGORIES, type Category, type CategoryId } from '../lib/btsSchema'
import { scaffoldBetterTStack, killBtsScaffold, defaultBootstrapDir } from '../lib/ipc'

interface Props {
  open: boolean
  onClose: () => void
  onScaffoldComplete: (projectPath: string) => void
  initialParentDir?: string
}

const INITIAL: BtsConfig = {
  frontend: ['tanstack-router'],
  backend: 'hono',
  runtime: 'bun',
  api: 'trpc',
  database: 'sqlite',
  orm: 'drizzle',
  dbSetup: 'none',
  webDeploy: 'none',
  serverDeploy: 'none',
  auth: 'better-auth',
  payments: 'none',
  packageManager: 'bun',
  addons: ['turborepo'],
}
const PARENT_DIR_KEY = 'verun.bts.lastParentDir'
const CONFIG_KEY = 'verun.bts.lastConfig'
const NAME_RE = /^[a-z0-9][a-z0-9-_.]*$/i

const webFrontendOf = (c: BtsConfig): string | undefined =>
  (c.frontend ?? []).find((v) => !isNativeFrontend(v))
const nativeFrontendOf = (c: BtsConfig): string | undefined =>
  (c.frontend ?? []).find((v) => isNativeFrontend(v))

const hypotheticalConfig = (c: BtsConfig, catId: CategoryId, value: string, kind: 'single' | 'multi'): BtsConfig => {
  if (catId === 'webFrontend' || catId === 'nativeFrontend') {
    const current = c.frontend ?? []
    const kept = catId === 'webFrontend'
      ? current.filter((v) => isNativeFrontend(v))
      : current.filter((v) => !isNativeFrontend(v))
    const nextFrontend = value === 'none' ? kept : [...kept, value]
    return { ...c, frontend: nextFrontend } as BtsConfig
  }
  if (catId === 'install') {
    return { ...c, install: value === 'install' } as BtsConfig
  }
  if (catId === 'examples') {
    return { ...c, examples: value === 'none' ? [] : [value] } as BtsConfig
  }
  return applyOption(c, catId as keyof BtsConfig, value, kind)
}

const cloneInitial = (): BtsConfig => structuredClone(INITIAL)

const loadSavedConfig = (): BtsConfig => {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return cloneInitial()
    const parsed = JSON.parse(raw) as BtsConfig
    return { ...cloneInitial(), ...parsed }
  } catch {
    return cloneInitial()
  }
}

export const BtsBuilderDialog: Component<Props> = (props) => {
  const [config, setConfig] = createStore<BtsConfig>(loadSavedConfig())
  const [projectName, setProjectName] = createSignal('')
  const [parentDir, setParentDir] = createSignal(props.initialParentDir ?? '')
  const [running, setRunning] = createSignal(false)
  const [errorText, setErrorText] = createSignal<string | null>(null)
  const [scaffoldId, setScaffoldId] = createSignal<string | null>(null)
  const [startedAt, setStartedAt] = createSignal<number | null>(null)
  const [now, setNow] = createSignal(Date.now())
  const [online, setOnline] = createSignal<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  )
  const [copyFlash, setCopyFlash] = createSignal(false)

  let tickId: ReturnType<typeof setInterval> | null = null
  let dialogRef: HTMLDivElement | undefined

  const onlineListener = () => setOnline(true)
  const offlineListener = () => setOnline(false)
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onlineListener)
    window.addEventListener('offline', offlineListener)
  }

  onCleanup(() => {
    if (tickId) clearInterval(tickId)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onlineListener)
      window.removeEventListener('offline', offlineListener)
    }
  })

  const withTrailingSlash = (p: string) => (p.endsWith('/') ? p : `${p}/`)

  onMount(async () => {
    if (!props.initialParentDir) {
      try {
        const saved = localStorage.getItem(PARENT_DIR_KEY)
        if (saved) setParentDir(withTrailingSlash(saved))
        else setParentDir(withTrailingSlash(await defaultBootstrapDir()))
      } catch {
        setParentDir(withTrailingSlash(await defaultBootstrapDir()))
      }
    } else {
      setParentDir(withTrailingSlash(props.initialParentDir))
    }
  })

  const pm = (): PackageManager => config.packageManager ?? 'pnpm'

  const validation = createMemo(() => validateCompatibility(config))
  const preview = createMemo(() =>
    buildCommandPreview(config, projectName() || 'my-new-app', pm()),
  )

  const nameValid = createMemo(() => {
    const n = projectName().trim()
    return n.length === 0 || NAME_RE.test(n)
  })

  const isSelected = (cat: Category, value: string): boolean => {
    if (cat.id === 'webFrontend') {
      const web = webFrontendOf(config)
      return value === 'none' ? web === undefined : web === value
    }
    if (cat.id === 'nativeFrontend') {
      const nat = nativeFrontendOf(config)
      return value === 'none' ? nat === undefined : nat === value
    }
    if (cat.id === 'install') {
      const v = config.install
      return value === 'install' ? v !== false : v === false
    }
    if (cat.id === 'examples') {
      const arr = (config.examples as string[] | undefined) ?? []
      return value === 'none' ? arr.length === 0 : arr.includes(value)
    }
    const current = config[cat.id as keyof BtsConfig]
    if (cat.kind === 'multi') return Array.isArray(current) && current.includes(value as never)
    return current === value
  }

  const selectionCount = (cat: Category): number => {
    if (cat.id === 'webFrontend') return webFrontendOf(config) ? 1 : 0
    if (cat.id === 'nativeFrontend') return nativeFrontendOf(config) ? 1 : 0
    if (cat.id === 'install') return 0
    if (cat.id === 'examples') {
      const arr = (config.examples as string[] | undefined) ?? []
      return arr.filter((x) => x !== 'none').length
    }
    const v = config[cat.id as keyof BtsConfig]
    if (v === undefined) return 0
    if (Array.isArray(v)) return (v as string[]).filter((x) => x !== 'none').length
    return v === 'none' ? 0 : 1
  }

  const configFieldFor = (catId: CategoryId): keyof BtsConfig | 'frontend' => {
    if (catId === 'webFrontend' || catId === 'nativeFrontend') return 'frontend'
    return catId as keyof BtsConfig
  }

  // Maps a BtsConfig field to its visual category index in BTS_CATEGORIES.
  // 'frontend' resolves to webFrontend's index (the most upstream slot it can occupy).
  const fieldCategoryIndex = (field: keyof BtsConfig | 'frontend'): number => {
    const id: CategoryId = field === 'frontend' ? 'webFrontend' : (field as CategoryId)
    return BTS_CATEGORIES.findIndex((c) => c.id === id)
  }

  const toggle = (cat: Category, value: string) => {
    const next = hypotheticalConfig(config, cat.id, value, cat.kind)
    setConfig(reconcile(coerceDependencies(next)))
  }

  const applyResolved = (resolved: BtsConfig) => {
    setConfig(reconcile(resolved))
  }

  const reset = () => {
    setConfig(reconcile(cloneInitial()))
  }

  const canCreate = createMemo(
    () =>
      projectName().trim().length > 0 &&
      nameValid() &&
      parentDir().trim().length > 0 &&
      validation().valid,
  )

  const handleCreate = async () => {
    if (!canCreate() || running()) return
    if (!online()) {
      setErrorText('You appear to be offline. The scaffolder needs network access.')
      return
    }
    const id = crypto.randomUUID()
    setScaffoldId(id)
    setErrorText(null)
    setRunning(true)
    setStartedAt(Date.now())
    setNow(Date.now())
    tickId = setInterval(() => setNow(Date.now()), 500)

    const name = projectName().trim()
    const selectedPm = pm()
    try {
      localStorage.setItem(PARENT_DIR_KEY, parentDir())
      const path = await scaffoldBetterTStack(
        parentDir(),
        name,
        pmRunner(selectedPm),
        buildCliArgs(config, name),
        defaultVerunConfig(selectedPm) as unknown as Record<string, unknown>,
        id,
      )
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
      } catch {
        // ignore quota errors
      }
      props.onScaffoldComplete(path)
      resetRunState()
    } catch (err) {
      setErrorText(String(err))
      setRunning(false)
      setScaffoldId(null)
      if (tickId) { clearInterval(tickId); tickId = null }
    }
  }

  const resetRunState = () => {
    setRunning(false)
    setScaffoldId(null)
    setErrorText(null)
    setStartedAt(null)
    if (tickId) { clearInterval(tickId); tickId = null }
  }

  const handleCancel = async () => {
    const id = scaffoldId()
    if (id) await killBtsScaffold(id)
    resetRunState()
  }

  const handleClose = () => {
    if (running()) return
    props.onClose()
  }

  createEffect(() => {
    if (!props.open) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        handleCreate()
      }
    }
    window.addEventListener('keydown', handler)
    onCleanup(() => window.removeEventListener('keydown', handler))
  })

  const elapsedLabel = createMemo(() => {
    const t = startedAt()
    if (t === null) return ''
    const secs = Math.max(0, Math.floor((now() - t) / 1000))
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return m > 0 ? `${m}m ${s}s` : `${s}s`
  })

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(preview())
      setCopyFlash(true)
      setTimeout(() => setCopyFlash(false), 1200)
    } catch {
      // ignore
    }
  }

  const handleGridKeyDown = (e: KeyboardEvent, catId: string, count: number) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    const target = e.target as HTMLButtonElement | null
    if (!target?.dataset.optIdx) return
    e.preventDefault()
    const idx = Number(target.dataset.optIdx)
    const cols = 3
    let next = idx
    if (e.key === 'ArrowRight') next = Math.min(idx + 1, count - 1)
    else if (e.key === 'ArrowLeft') next = Math.max(idx - 1, 0)
    else if (e.key === 'ArrowDown') next = Math.min(idx + cols, count - 1)
    else if (e.key === 'ArrowUp') next = Math.max(idx - cols, 0)
    if (next === idx) return
    const selector = `[data-cat-id="${catId}"][data-opt-idx="${next}"]`
    const btn = dialogRef?.querySelector(selector) as HTMLButtonElement | null
    btn?.focus()
  }

  return (
    <Dialog open={props.open} onClose={handleClose} width="64rem">
      <div ref={dialogRef}>
      <Show
        when={!running() || !scaffoldId()}
        fallback={
          <BtsLogPane
            projectName={projectName()}
            elapsedLabel={elapsedLabel()}
            scaffoldId={scaffoldId() ?? ''}
            errorText={errorText()}
            onCancel={handleCancel}
          />
        }
      >
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <Rocket size={16} class="text-accent" />
            <h2 class="text-sm font-semibold text-text-primary">Bootstrap a new project</h2>
          </div>
          <a
            class="text-[10px] text-text-dim hover:text-text-secondary transition-colors"
            href="https://better-t-stack.dev"
            target="_blank"
            rel="noopener noreferrer"
          >
            Powered by Better-T-Stack
          </a>
        </div>

        <Show when={!online()}>
          <div class="mb-3 flex items-center gap-2 text-[11px] text-status-warning bg-status-warning/10 rounded p-2">
            <WifiOff size={12} />
            You're offline. The scaffolder needs network access to fetch packages.
          </div>
        </Show>

        <div class="grid grid-cols-[1fr_1fr] gap-3 mb-4">
          <div>
            <label class="section-title mb-1.5 block">Project name</label>
            <input
              class="input-base font-mono text-[12px]"
              classList={{ 'ring-1 ring-status-error/60': !nameValid() }}
              placeholder="my-new-app"
              value={projectName()}
              spellcheck={false}
              autocapitalize="off"
              onInput={(e) => setProjectName(e.currentTarget.value)}
            />
            <Show when={!nameValid()}>
              <div class="text-[10px] text-status-error mt-1">Use letters, numbers, dash, underscore, dot</div>
            </Show>
          </div>
          <div>
            <label class="section-title mb-1.5 block">Parent folder</label>
            <PathAutocomplete value={parentDir()} onChange={setParentDir} placeholder="~" />
          </div>
        </div>

        <div class="overflow-y-auto px-1 py-1 -mx-1 space-y-5" style={{ 'max-height': '28rem' }}>
          <For each={BTS_CATEGORIES}>
            {(cat) => (
              <section>
                <div class="flex items-baseline justify-between mb-2">
                  <div class="flex items-baseline gap-2">
                    <h3 class="text-xs font-semibold text-text-primary uppercase tracking-wider">{cat.label}</h3>
                    <Show when={cat.description}>
                      <span class="text-[11px] text-text-dim">{cat.description}</span>
                    </Show>
                  </div>
                  <Show when={selectionCount(cat) > 0}>
                    <span class="text-[10px] text-accent">{selectionCount(cat)} selected</span>
                  </Show>
                </div>
                <div
                  class="grid grid-cols-3 gap-1.5"
                  onKeyDown={(e) => handleGridKeyDown(e, cat.id, cat.options.length)}
                >
                  <For each={cat.options}>
                    {(opt, i) => {
                      const selected = () => isSelected(cat, opt.value)
                      const resolution = createMemo(() => {
                        if (selected()) return null
                        if (cat.id === 'install') return null
                        const hyp = hypotheticalConfig(config, cat.id, opt.value, cat.kind)
                        const clickedField = configFieldFor(cat.id) as keyof BtsConfig
                        const reason = optionDisabledReason(hyp, clickedField, opt.value)
                        if (!reason) return null
                        const resolved = resolveForOption(hyp, configFieldFor(cat.id))
                        const fixable = validateCompatibility(resolved).valid
                        const changes = fixable
                          ? diffConfig(config, resolved).filter((c) => c.field !== clickedField)
                          : []
                        // Suppress the red reason when every dependent change lives in a
                        // category below the clicked one. Those fields are "open" picks
                        // the user hasn't visited; let the click silently auto-fix them.
                        const clickedIdx = BTS_CATEGORIES.findIndex((c) => c.id === cat.id)
                        const hasUpstreamChange = changes.some((c) => {
                          const idx = fieldCategoryIndex(c.field)
                          return idx >= 0 && idx < clickedIdx
                        })
                        const showReason = !fixable || hasUpstreamChange
                        return {
                          reason: showReason ? reason : null,
                          resolved: fixable ? resolved : null,
                          changes,
                        }
                      })
                      const disabled = () => {
                        const r = resolution()
                        return r !== null && r.reason !== null
                      }
                      const fixable = () => {
                        const r = resolution()
                        return !!(r && r.resolved && r.changes.length > 0)
                      }
                      const DisplayIcon = () => {
                        if (cat.id === 'backend' && opt.value === 'self') {
                          const web = webFrontendOf(config)
                          const webCat = BTS_CATEGORIES.find((c) => c.id === 'webFrontend')
                          const webOpt = webCat?.options.find((o) => o.value === web)
                          if (webOpt) return <webOpt.Icon size={14} />
                        }
                        return <opt.Icon size={14} />
                      }
                      const displayLabel = () => {
                        if (cat.id === 'backend' && opt.value === 'self') {
                          const fs = fullstackLabel(webFrontendOf(config))
                          return fs ? `Fullstack ${fs}` : 'Fullstack'
                        }
                        return opt.label
                      }
                      return (
                        <button
                          class="relative flex items-start gap-2 px-2.5 py-2 rounded-md text-left transition-all"
                          classList={{
                            'bg-accent/10 ring-1 ring-accent/50': selected(),
                            'bg-surface-1 ring-1 ring-white/5 hover:ring-white/15 hover:bg-surface-3': !selected() && !disabled(),
                            'bg-surface-1/40 ring-1 ring-status-error/30 hover:ring-status-error/60 hover:bg-surface-1/60 cursor-pointer': fixable() && disabled(),
                            'bg-surface-1/40 ring-1 ring-status-error/30 cursor-not-allowed': disabled() && !fixable(),
                          }}
                          aria-pressed={selected()}
                          aria-disabled={disabled() && !fixable()}
                          data-cat-id={cat.id}
                          data-opt-idx={i()}
                          onClick={() => {
                            const r = resolution()
                            if (r && r.resolved) applyResolved(r.resolved)
                            else if (!disabled()) toggle(cat, opt.value)
                          }}
                          title={resolution()?.reason ?? opt.description}
                        >
                          <span
                            class="flex-shrink-0 mt-0.5"
                            classList={{
                              'text-accent': selected(),
                              'text-text-primary': !selected() && !disabled(),
                              'text-text-dim': disabled(),
                            }}
                          >
                            <DisplayIcon />
                          </span>
                          <span class="min-w-0 flex-1">
                            <span class="flex items-center gap-1">
                              <span
                                class="text-xs font-medium truncate"
                                classList={{
                                  'text-text-primary': selected(),
                                  'text-text-secondary': !selected() && !disabled(),
                                  'text-text-dim': disabled(),
                                }}
                              >
                                {displayLabel()}
                              </span>
                              <Show when={selected()}>
                                <Check size={11} class="text-accent flex-shrink-0" />
                              </Show>
                            </span>
                            <Show when={opt.description}>
                              <span
                                class="block text-[10px] leading-tight mt-0.5 line-clamp-2"
                                classList={{
                                  'text-text-dim': !disabled(),
                                }}
                              >
                                {opt.description}
                              </span>
                            </Show>
                            <Show when={resolution()?.reason}>
                              {(reason) => (
                                <span class="block text-[10px] leading-tight mt-1.5 text-status-error line-clamp-2">
                                  {reason()}
                                </span>
                              )}
                            </Show>
                          </span>
                        </button>
                      )
                    }}
                  </For>
                </div>
              </section>
            )}
          </For>
        </div>

        <Show when={!validation().valid}>
          <div class="mt-3 text-[11px] text-status-error bg-status-error/10 rounded p-2">
            <For each={validation().errors}>{(err) => <div>{err}</div>}</For>
          </div>
        </Show>

        <Show when={errorText()}>
          <div class="mt-3 bg-status-error/10 rounded">
            <div class="flex items-center justify-between p-2">
              <div class="flex items-center gap-2 text-[11px] text-status-error">
                <AlertTriangle size={12} />
                <span class="font-medium">Scaffold failed</span>
                <span class="text-text-dim">{errorText()}</span>
              </div>
              <button
                class="btn-primary text-[10px] flex items-center gap-1"
                onClick={handleCreate}
              >
                Retry
              </button>
            </div>
          </div>
        </Show>

        <div class="border-t-1 border-t-solid border-t-white/8 pt-3 mt-3">
          <div class="flex items-stretch gap-2">
            <div
              class="flex-1 text-[11px] font-mono text-text-secondary bg-surface-0 ring-1 ring-white/5 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all"
              data-testid="bts-preview"
            >
              {preview()}
            </div>
            <button
              class="btn-ghost text-[10px] flex items-center justify-center gap-1.5 px-2 min-w-[72px]"
              onClick={handleCopy}
              title="Copy command"
            >
              <Show when={!copyFlash()}>
                <Copy size={12} />
              </Show>
              {copyFlash() ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div class="flex items-center justify-between mt-3">
          <div class="flex items-center gap-3">
            <button
              class="btn-ghost text-xs flex items-center gap-1.5"
              onClick={reset}
              title="Reset all selections"
            >
              <RotateCcw size={12} /> Reset
            </button>
          </div>
          <div class="flex items-center gap-2">
            <button class="btn-ghost text-xs" onClick={props.onClose}>
              Cancel
            </button>
            <button
              class="btn-primary text-xs flex items-center gap-1.5"
              onClick={handleCreate}
              disabled={!canCreate()}
              title="Create project (⌘↵)"
            >
              <Rocket size={12} />
              Create project
              <span class="text-[10px] opacity-60 ml-1 font-mono">⌘↵</span>
            </button>
          </div>
        </div>
      </Show>
      </div>
    </Dialog>
  )
}
