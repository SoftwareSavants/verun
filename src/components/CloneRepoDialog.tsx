import { Component, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { GitFork, Lock, Loader2, Archive, Search, Star, Copy, Check } from 'lucide-solid'
import { CloneIcon } from './icons/CloneIcon'

const CommandBlock = (props: { command: string }) => {
  const [copied, setCopied] = createSignal(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      addToast(`Copy failed: ${e}`, 'error')
    }
  }
  return (
    <div class="relative">
      <pre class="bg-surface-3 rounded-md p-2 pr-9 text-[11px] font-mono text-text-primary whitespace-pre">{props.command}</pre>
      <button
        type="button"
        class="absolute top-1.5 right-1.5 p-1 rounded text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
        onClick={() => void handleCopy()}
        title={copied() ? 'Copied!' : 'Copy to clipboard'}
        aria-label="Copy command"
      >
        <Show when={copied()} fallback={<Copy size={12} />}>
          <Check size={12} class="text-status-done" />
        </Show>
      </button>
    </div>
  )
}

const GithubMark = (props: { size?: number; class?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={props.size ?? 14}
    height={props.size ?? 14}
    viewBox="0 0 24 24"
    fill="currentColor"
    class={props.class}
    aria-hidden="true"
  >
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
)
import { Dialog } from './Dialog'
import { addToast, setSelectedProjectId } from '../store/ui'
import { setProjects } from '../store/projects'
import { produce } from 'solid-js/store'
import * as ipc from '../lib/ipc'
import type { GhStatus, RemoteRepo, Project } from '../types'
import { clsx } from 'clsx'

interface Props {
  open: boolean
  onClose: () => void
}

type View =
  | { kind: 'checking' }
  | { kind: 'needs-install' }
  | { kind: 'needs-auth' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; repos: RemoteRepo[]; account: string | null }
  | { kind: 'manual' }

export const CloneRepoDialog: Component<Props> = (props) => {
  const [view, setView] = createSignal<View>({ kind: 'checking' })
  const [query, setQuery] = createSignal('')
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [manualInput, setManualInput] = createSignal('')
  const [cloning, setCloning] = createSignal(false)

  let listRef: HTMLDivElement | undefined

  const refresh = async () => {
    setView({ kind: 'checking' })
    try {
      const status: GhStatus = await ipc.ghStatus()
      if (!status.installed) {
        setView({ kind: 'needs-install' })
        return
      }
      if (!status.authenticated) {
        setView({ kind: 'needs-auth' })
        return
      }
      const repos = await ipc.listUserGithubRepos()
      setView({ kind: 'ready', repos, account: status.account })
    } catch (e) {
      setView({ kind: 'error', message: String(e) })
    }
  }

  createEffect(on(() => props.open, (open) => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setManualInput('')
      setCloning(false)
      void refresh()
    }
  }))

  const filtered = createMemo<RemoteRepo[]>(() => {
    const v = view()
    if (v.kind !== 'ready') return []
    const q = query().trim().toLowerCase()
    if (!q) return v.repos
    return v.repos.filter((r) =>
      r.nameWithOwner.toLowerCase().includes(q) ||
      (r.description ?? '').toLowerCase().includes(q),
    )
  })

  createEffect(on(query, () => setSelectedIndex(0)))
  createEffect(on(selectedIndex, (idx) => {
    if (!listRef) return
    const item = listRef.querySelectorAll('button[data-repo]')[idx] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }))

  const promptParentDir = async (): Promise<string | null> => {
    const selected = await openDialog({ directory: true, multiple: false, title: 'Choose where to clone' })
    return (selected as string | null) ?? null
  }

  const completeClone = async (project: Project) => {
    setProjects(produce((p) => p.push(project)))
    setSelectedProjectId(project.id)
    addToast(`Cloned ${project.name}`, 'success')
    props.onClose()
  }

  const cloneByRepo = async (repo: RemoteRepo) => {
    if (cloning()) return
    const parent = await promptParentDir()
    if (!parent) return
    setCloning(true)
    try {
      const project = await ipc.cloneGithubRepoAndAdd({
        nameWithOwner: repo.nameWithOwner,
        parentDir: parent,
      })
      await completeClone(project)
    } catch (e) {
      addToast(`Clone failed: ${e}`, 'error')
    } finally {
      setCloning(false)
    }
  }

  const cloneByUrlOrSlug = async () => {
    const input = manualInput().trim()
    if (!input) {
      addToast('Enter a Git URL or owner/repo', 'error')
      return
    }
    if (cloning()) return
    const parent = await promptParentDir()
    if (!parent) return
    setCloning(true)
    try {
      const isSlug = !input.includes('://') && !input.startsWith('git@') && /^[\w.-]+\/[\w.-]+$/.test(input)
      const args = isSlug
        ? { nameWithOwner: input, parentDir: parent }
        : { remoteUrl: input, parentDir: parent }
      const project = await ipc.cloneGithubRepoAndAdd(args)
      await completeClone(project)
    } catch (e) {
      addToast(`Clone failed: ${e}`, 'error')
    } finally {
      setCloning(false)
    }
  }

  const handleListKeyDown = (e: KeyboardEvent) => {
    const items = filtered()
    if (items.length === 0) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % items.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + items.length) % items.length)
        break
      case 'Enter':
        e.preventDefault()
        void cloneByRepo(items[selectedIndex()])
        break
    }
  }

  // Reset on close
  onCleanup(() => {
    setView({ kind: 'checking' })
  })

  return (
    <Dialog open={props.open} onClose={props.onClose} width="35rem">
      <div class="flex items-center gap-2 mb-3">
        <CloneIcon size={14} class="text-accent" />
        <h2 class="text-base font-semibold text-text-primary">Clone GitHub repo</h2>
        <Show when={view().kind === 'ready' && (view() as { account: string | null }).account}>
          {(account) => (
            <span class="ml-auto text-[11px] text-text-dim">@{account()}</span>
          )}
        </Show>
      </div>

      <Show when={view().kind === 'checking'}>
        <div class="py-10 flex items-center justify-center text-text-dim text-xs gap-2">
          <Loader2 size={14} class="animate-spin" />
          Checking GitHub CLI...
        </div>
      </Show>

      <Show when={view().kind === 'needs-install'}>
        <div class="space-y-3 text-xs text-text-secondary">
          <p>The GitHub CLI (<code class="text-accent">gh</code>) isn't installed or isn't on your PATH.</p>
          <CommandBlock command={'brew install gh\ngh auth login'} />
          <p class="text-text-dim">After installing, click below to retry — or paste a Git URL instead.</p>
          <div class="flex gap-2">
            <button class="btn-primary text-xs px-3 py-1.5" onClick={() => void refresh()}>Retry</button>
            <button class="btn-ghost text-xs px-3 py-1.5" onClick={() => setView({ kind: 'manual' })}>Paste a Git URL</button>
          </div>
        </div>
      </Show>

      <Show when={view().kind === 'needs-auth'}>
        <div class="space-y-3 text-xs text-text-secondary">
          <p>The GitHub CLI is installed but not signed in.</p>
          <CommandBlock command="gh auth login" />
          <div class="flex gap-2">
            <button class="btn-primary text-xs px-3 py-1.5" onClick={() => void refresh()}>Retry</button>
            <button class="btn-ghost text-xs px-3 py-1.5" onClick={() => setView({ kind: 'manual' })}>Paste a Git URL</button>
          </div>
        </div>
      </Show>

      <Show when={view().kind === 'error'}>
        {(_) => {
          const v = view() as { kind: 'error'; message: string }
          return (
            <div class="space-y-3 text-xs">
              <p class="text-red-400">{v.message}</p>
              <div class="flex gap-2">
                <button class="btn-primary text-xs px-3 py-1.5" onClick={() => void refresh()}>Retry</button>
                <button class="btn-ghost text-xs px-3 py-1.5" onClick={() => setView({ kind: 'manual' })}>Paste a Git URL</button>
              </div>
            </div>
          )
        }}
      </Show>

      <Show when={view().kind === 'ready'}>
        <div class="space-y-2">
          <div class="relative">
            <Search size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
            <input
              type="text"
              autofocus
              placeholder="Filter your repositories..."
              class="w-full bg-surface-3 rounded-md pl-7 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={handleListKeyDown}
              disabled={cloning()}
            />
          </div>

          <div ref={listRef} class="border border-border rounded-md h-[28rem] overflow-y-auto bg-surface-1">
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="px-3 py-6 text-center text-[11px] text-text-dim">
                  No repos match "{query()}"
                </div>
              }
            >
              <For each={filtered()}>
                {(repo, i) => (
                  <button
                    data-repo
                    class={clsx(
                      'w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors',
                      selectedIndex() === i()
                        ? 'bg-surface-3 text-text-primary'
                        : 'text-text-secondary hover:bg-surface-2',
                    )}
                    onMouseEnter={() => setSelectedIndex(i())}
                    onClick={() => void cloneByRepo(repo)}
                    disabled={cloning()}
                  >
                    <GithubMark size={14} class="text-text-muted shrink-0 mt-0.5" />
                    <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="text-xs font-medium truncate">{repo.nameWithOwner}</span>
                        <Show when={repo.isPrivate}><Lock size={10} class="text-text-dim shrink-0" /></Show>
                        <Show when={repo.isFork}><GitFork size={10} class="text-text-dim shrink-0" /></Show>
                        <Show when={repo.isArchived}><Archive size={10} class="text-text-dim shrink-0" /></Show>
                        <Show when={repo.starCount > 0}>
                          <span class="ml-auto flex items-center gap-0.5 text-[11px] text-text-dim shrink-0">
                            <Star size={10} />
                            {repo.starCount}
                          </span>
                        </Show>
                      </div>
                      <Show
                        when={repo.description}
                        fallback={<div class="text-[11px] text-text-dim truncate font-mono">{repo.url}</div>}
                      >
                        <div class="text-[11px] text-text-dim truncate">{repo.description}</div>
                      </Show>
                    </div>
                  </button>
                )}
              </For>
            </Show>
          </div>

          <div class="flex items-center justify-between pt-1">
            <button
              class="text-[11px] text-text-dim hover:text-text-secondary"
              onClick={() => setView({ kind: 'manual' })}
              disabled={cloning()}
            >
              ...or paste a Git URL
            </button>
            <Show when={cloning()}>
              <span class="flex items-center gap-1.5 text-[11px] text-text-dim">
                <Loader2 size={11} class="animate-spin" />
                Cloning...
              </span>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={view().kind === 'manual'}>
        <div class="space-y-3">
          <label class="block text-xs text-text-muted">Git URL or owner/repo</label>
          <input
            type="text"
            autofocus
            placeholder="git@github.com:owner/repo.git or owner/repo"
            class="w-full bg-surface-3 rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40"
            value={manualInput()}
            onInput={(e) => setManualInput(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void cloneByUrlOrSlug() }}
            disabled={cloning()}
          />
          <div class="flex justify-between items-center">
            <button
              class="text-[11px] text-text-dim hover:text-text-secondary"
              onClick={() => void refresh()}
              disabled={cloning()}
            >
              ← Back to repo list
            </button>
            <button
              class="btn-primary text-xs px-3 py-1.5 disabled:opacity-40"
              onClick={() => void cloneByUrlOrSlug()}
              disabled={cloning()}
            >
              <Show when={cloning()} fallback="Clone">
                <Loader2 size={12} class="animate-spin mr-1" />
                Cloning...
              </Show>
            </button>
          </div>
        </div>
      </Show>
    </Dialog>
  )
}
