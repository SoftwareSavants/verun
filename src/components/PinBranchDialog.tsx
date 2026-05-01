import { Component, Show, For, createSignal, createMemo, createEffect } from 'solid-js'
import * as ipc from '../lib/ipc'
import { projectById } from '../store/projects'
import { GitBranch, Search, Pin, Loader2 } from 'lucide-solid'
import { Dialog } from './Dialog'
import { DialogFooter } from './DialogFooter'

interface Props {
  open: boolean
  projectId: string | null
  onClose: () => void
}

// Pre-canonicalize preview of the worktree path. Rust calls
// std::fs::canonicalize on the result of `git worktree add`, so if repoPath
// is a symlink the stored task.worktreePath will be the resolved form, not
// the literal string shown here.
function previewWorktreePath(repoPath: string, branch: string): string {
  return `${repoPath}/.verun/worktrees/${branch}`
}

export const PinBranchDialog: Component<Props> = (props) => {
  const [branches, setBranches] = createSignal<string[]>([])
  const [branch, setBranch] = createSignal('')
  const [filter, setFilter] = createSignal('')
  const [loadingList, setLoadingList] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [listError, setListError] = createSignal<string | null>(null)

  const project = () => (props.projectId ? projectById(props.projectId) : undefined)

  createEffect(() => {
    if (props.open && props.projectId) {
      setError(null)
      setListError(null)
      setBranches([])
      setBranch('')
      setFilter('')
      setLoadingList(true)
      ipc.listLocalBranches(props.projectId)
        .then((list) => {
          setBranches(list)
          if (list.length > 0) setBranch(list[0])
        })
        .catch((e) => setListError(String(e)))
        .finally(() => setLoadingList(false))
    }
  })

  const filteredBranches = createMemo(() => {
    const q = filter().trim().toLowerCase()
    if (!q) return branches()
    return branches().filter((b) => b.toLowerCase().includes(q))
  })

  // Keep a valid selected branch when filter narrows the list.
  createEffect(() => {
    const list = filteredBranches()
    if (list.length === 0) return
    if (!list.includes(branch())) setBranch(list[0])
  })

  const handlePin = async () => {
    if (!props.projectId || !branch() || loading()) return
    setLoading(true)
    setError(null)
    try {
      await ipc.pinBranch(props.projectId, branch())
      props.onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const showFilter = () => branches().length > 6

  return (
    <Dialog open={props.open} onClose={props.onClose} onConfirm={handlePin} width="26rem">
      <div class="flex items-center gap-2 mb-2">
        <div class="w-7 h-7 rounded-md bg-accent/12 flex items-center justify-center text-accent">
          <Pin size={14} />
        </div>
        <h2 class="text-base font-semibold text-text-primary">Pin Branch</h2>
      </div>
      <p class="text-sm text-text-muted mb-4">
        Attach a worktree to an existing branch. Pinned workspaces appear above regular tasks and skip the archive, merge, and PR flow.
      </p>

      <Show when={showFilter()}>
        <div class="mb-2">
          <div class="relative">
            <Search size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none" />
            <input
              type="text"
              placeholder="Filter branches…"
              class="input-base pl-7 pr-3 text-xs"
              style={{ outline: 'none' }}
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          </div>
        </div>
      </Show>

      <div class="mb-2">
        <label class="text-xs text-text-dim mb-1.5 block">Branch</label>
        <div class="relative">
          <GitBranch size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none" />
          <Show when={loadingList()}>
            <Loader2 size={12} class="absolute right-3 top-1/2 -translate-y-1/2 text-text-dim animate-spin pointer-events-none" />
          </Show>
          <select
            class="input-base pl-8 pr-3 appearance-none cursor-pointer"
            style={{ outline: 'none' }}
            value={branch()}
            onChange={(e) => setBranch(e.currentTarget.value)}
            disabled={filteredBranches().length === 0 || loadingList()}
            aria-label="Branch"
          >
            <Show
              when={filteredBranches().length > 0}
              fallback={
                <option value="">
                  {loadingList()
                    ? 'Loading…'
                    : branches().length === 0
                      ? 'No eligible branches'
                      : 'No matches'}
                </option>
              }
            >
              <For each={filteredBranches()}>
                {(b) => <option value={b}>{b}</option>}
              </For>
            </Show>
          </select>
        </div>
        <Show when={branches().length > 0 && filteredBranches().length > 0}>
          <p class="text-[10px] text-text-dim mt-1.5">
            {filteredBranches().length === branches().length
              ? `${branches().length} branch${branches().length === 1 ? '' : 'es'} available`
              : `${filteredBranches().length} of ${branches().length} match`}
          </p>
        </Show>
      </div>

      <Show when={branch() && project()}>
        <div class="mb-3 px-3 py-2 rounded-md bg-surface-3 ring-1 ring-outline/8">
          <div class="text-[10px] uppercase tracking-wider text-text-dim mb-1">Worktree path</div>
          <code class="text-[11px] text-text-secondary break-all font-mono">
            {previewWorktreePath(project()!.repoPath, branch())}
          </code>
        </div>
      </Show>

      <Show when={!loadingList() && branches().length === 0 && !listError()}>
        <div class="mb-3 px-3 py-2 rounded-md bg-surface-3 ring-1 ring-outline/8 text-xs text-text-muted">
          Every local branch is already pinned. Create or check out another branch first.
        </div>
      </Show>

      <Show when={listError()}>
        <div class="mb-3 px-3 py-2 rounded-md bg-status-error/8 ring-1 ring-status-error/30 text-xs text-status-error">
          Could not list branches. {listError()}
        </div>
      </Show>

      <Show when={error()}>
        <div class="mb-3 px-3 py-2 rounded-md bg-status-error/8 ring-1 ring-status-error/30 text-xs text-status-error">
          {error()}
        </div>
      </Show>

      <DialogFooter
        onCancel={props.onClose}
        onConfirm={handlePin}
        confirmLabel="Pin Branch"
        loadingLabel="Pinning..."
        loading={loading()}
        disabled={!branch() || filteredBranches().length === 0 || loadingList()}
      />
    </Dialog>
  )
}
