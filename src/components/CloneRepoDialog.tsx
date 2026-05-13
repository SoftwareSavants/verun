import { Component, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { GitFork, Lock, Loader2, Archive, Search, Star, Copy, Check, Building2 } from 'lucide-solid'

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
      <pre class="bg-surface-3 rounded-lg p-2 pr-9 text-[11px] font-mono text-text-primary whitespace-pre">{props.command}</pre>
      <button
        type="button"
        class="absolute top-1.5 right-1.5 p-1 rounded-lg text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors"
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

// GitHub avatar URLs accept an `s` (pixels) query param. Request 2× the
// rendered size so the image stays crisp on retina displays instead of
// upscaling a tiny default thumbnail.
const sizedAvatar = (url: string, px: number): string => {
  try {
    const u = new URL(url)
    u.searchParams.set('s', String(px * 2))
    return u.toString()
  } catch {
    return url
  }
}

const looksLikeUrlOrSlug = (raw: string): boolean => {
  const s = raw.trim()
  if (!s) return false
  return s.includes('://') || s.startsWith('git@') || /^[\w.-]+\/[\w.-]+$/.test(s)
}

export const CloneRepoDialog: Component<Props> = (props) => {
  const [view, setView] = createSignal<View>({ kind: 'checking' })
  const [query, setQuery] = createSignal('')
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [cloning, setCloning] = createSignal(false)

  let listRef: HTMLDivElement | undefined
  let searchInputRef: HTMLInputElement | undefined

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
      setCloning(false)
      void refresh()
    }
  }))

  const filtered = createMemo<RemoteRepo[]>(() => {
    const v = view()
    if (v.kind !== 'ready') return []
    const q = query().trim().toLowerCase()
    if (!q) return v.repos
    return v.repos.filter((r) => {
      const name = r.nameWithOwner.toLowerCase()
      // Plain-text search: name/description contains the query.
      // URL/slug paste: query contains the name (e.g. pasting
      // https://github.com/owner/repo.git matches "owner/repo").
      return (
        name.includes(q) ||
        q.includes(name) ||
        (r.description ?? '').toLowerCase().includes(q)
      )
    })
  })

  // Focus the search input as soon as the ready view mounts. Solid's
  // `autofocus` attribute is unreliable inside a portal-mounted modal — the
  // input element exists for ~1 frame before the dialog finishes its enter
  // animation, so the browser drops the implicit focus. Re-asserting via the
  // ref after the view flips guarantees the user can type immediately.
  createEffect(on(() => view().kind, (kind) => {
    if (kind === 'ready') {
      queueMicrotask(() => searchInputRef?.focus())
    }
  }))

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

  const cloneFromQuery = async () => {
    const input = query().trim()
    if (!input || cloning()) return
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
    switch (e.key) {
      case 'ArrowDown':
        if (items.length > 0) {
          e.preventDefault()
          setSelectedIndex((i) => (i + 1) % items.length)
        }
        break
      case 'ArrowUp':
        if (items.length > 0) {
          e.preventDefault()
          setSelectedIndex((i) => (i - 1 + items.length) % items.length)
        }
        break
      case 'Enter':
        if (items.length > 0) {
          e.preventDefault()
          void cloneByRepo(items[selectedIndex()])
        } else if (looksLikeUrlOrSlug(query())) {
          e.preventDefault()
          void cloneFromQuery()
        }
        break
    }
  }

  // Reset on close
  onCleanup(() => {
    setView({ kind: 'checking' })
  })

  return (
    <Dialog open={props.open} onClose={props.onClose} width="34rem" class="!p-4 !border-border-active !shadow-[0_16px_50px_-12px_rgba(0,0,0,0.55)]">
      <div class="flex flex-col gap-5">
        <div class="flex items-start justify-between">
          <h2 class="m-0 text-[13px] font-semibold leading-tight text-text-primary">Clone GitHub repo</h2>
          <Show when={view().kind === 'ready' && (view() as { account: string | null }).account}>
            {(account) => (
              <span class="text-[11px] text-text-dim">@{account()}</span>
            )}
          </Show>
        </div>

        <Show when={view().kind === 'checking'}>
          <div class="py-3 flex items-center justify-center text-text-dim text-xs gap-2">
            <Loader2 size={14} class="animate-spin" />
            Checking GitHub CLI...
          </div>
        </Show>

        <Show when={view().kind === 'needs-install'}>
          <div class="space-y-3 text-xs text-text-secondary">
            <p>The GitHub CLI (<code class="text-accent">gh</code>) isn't installed or isn't on your PATH.</p>
            <CommandBlock command={'brew install gh\ngh auth login'} />
            <p class="text-text-dim">After installing, click Retry.</p>
            <button class="btn-primary text-xs px-3 py-1.5" onClick={() => void refresh()}>Retry</button>
          </div>
        </Show>

        <Show when={view().kind === 'needs-auth'}>
          <div class="space-y-3 text-xs text-text-secondary">
            <p>The GitHub CLI is installed but not signed in.</p>
            <CommandBlock command="gh auth login" />
            <button class="btn-primary text-xs px-3 py-1.5" onClick={() => void refresh()}>Retry</button>
          </div>
        </Show>

        <Show when={view().kind === 'error'}>
          {(_) => {
            const v = view() as { kind: 'error'; message: string }
            return (
              <div class="space-y-3 text-xs">
                <p class="text-red-400">{v.message}</p>
                <button class="btn-primary text-xs px-3 py-1.5" onClick={() => void refresh()}>Retry</button>
              </div>
            )
          }}
        </Show>

        <Show when={view().kind === 'ready'}>
          <div class="flex flex-col gap-5">
            <div class="relative">
              <Search size={15} class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-dim" />
              <input
                ref={searchInputRef}
                type="text"
                autofocus
                placeholder="Search repos, paste a Git URL, or owner/repo..."
                class="w-full rounded-lg bg-surface-3 py-2.5 pl-9 pr-3.5 text-sm text-text-primary placeholder:text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={handleListKeyDown}
                disabled={cloning()}
              />
            </div>

            <div ref={listRef} class="max-h-[46vh] overflow-y-auto rounded-lg bg-surface-1 p-2 ring-1 ring-border-active">
              <Show
                when={filtered().length > 0}
                fallback={
                  <div class="space-y-1.5 py-3 text-center text-[11px] text-text-dim">
                    <div>No repos match "{query()}"</div>
                    <Show when={looksLikeUrlOrSlug(query())}>
                      <div class="text-text-secondary">
                        Press <kbd class="rounded-lg bg-surface-3 px-1 py-0.5 text-[10px] font-mono">Enter</kbd> to clone <span class="font-mono">{query().trim()}</span>
                      </div>
                    </Show>
                  </div>
                }
              >
                <div class="space-y-0.5">
                  <For each={filtered()}>
                    {(repo, i) => (
                      <button
                        data-repo
                        class={clsx(
                          'flex w-full items-center gap-4 rounded p-2 text-left transition-colors',
                          selectedIndex() === i()
                            ? 'bg-surface-3 text-text-primary'
                            : 'text-text-secondary hover:bg-surface-2/70',
                        )}
                        onMouseEnter={() => setSelectedIndex(i())}
                        onClick={() => void cloneByRepo(repo)}
                        disabled={cloning()}
                      >
                        <Show
                          when={repo.ownerAvatarUrl}
                          fallback={(
                            <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm ring-1 ring-outline/10 bg-surface-3 text-text-muted">
                              <Building2 size={16} />
                            </span>
                          )}
                        >
                          {(src) => (
                            <img
                              src={sizedAvatar(src(), 24)}
                              alt=""
                              width={24}
                              height={24}
                              class="h-6 w-6 shrink-0 rounded-sm object-cover ring-1 ring-outline/10"
                            />
                          )}
                        </Show>
                        <div class="min-w-0 flex-1">
                          <div class="flex min-w-0 items-center gap-2">
                            <span class="truncate text-[13px] font-medium text-text-primary">{repo.nameWithOwner}</span>
                            <Show when={repo.isPrivate}><Lock size={11} class="shrink-0 text-text-dim" /></Show>
                            <Show when={repo.isFork}><GitFork size={11} class="shrink-0 text-text-dim" /></Show>
                            <Show when={repo.isArchived}><Archive size={11} class="shrink-0 text-text-dim" /></Show>
                            <Show when={repo.starCount > 0}>
                              <span class="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-text-dim">
                                <Star size={11} />
                                {repo.starCount}
                              </span>
                            </Show>
                          </div>
                          <Show
                            when={repo.description}
                            fallback={<div class="mt-0.5 truncate font-mono text-[11px] text-text-dim/80">{repo.url}</div>}
                          >
                            <div class="mt-0.5 truncate text-[12px] text-text-muted">{repo.description}</div>
                          </Show>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <div class="flex items-center gap-5 text-[11px] text-text-dim">
              <span class="flex items-center gap-1.5">
                <span class="flex items-center gap-0.5">
                  <kbd class="rounded-lg bg-surface-3 px-1 py-0.5 font-mono text-text-muted">↑</kbd>
                  <kbd class="rounded-lg bg-surface-3 px-1 py-0.5 font-mono text-text-muted">↓</kbd>
                </span>
                Navigate
              </span>
              <span class="flex items-center gap-1.5">
                <kbd class="rounded-lg bg-surface-3 px-1 py-0.5 font-mono text-text-muted">Enter</kbd>
                Select
              </span>
              <span class="flex items-center gap-1.5">
                <kbd class="rounded-lg bg-surface-3 px-1 py-0.5 font-mono text-text-muted">Esc</kbd>
                Close
              </span>
              <Show when={cloning()}>
                <span class="ml-auto flex items-center gap-1.5 text-text-muted">
                  <Loader2 size={11} class="animate-spin" />
                  Cloning...
                </span>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
