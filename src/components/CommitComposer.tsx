import { Component, createEffect, createSignal, on, Show } from 'solid-js'
import { ChevronDown, Loader2, History, ArrowUpFromLine } from 'lucide-solid'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

interface Props {
  taskId: string
  canCommit: boolean      // there is at least one staged/unstaged/untracked file
  canAmend: boolean       // at least one commit on the branch
  amendDefaultMessage: string
  onCommit: (message: string) => Promise<void>
  onCommitAndPush: (message: string) => Promise<void>
  onAmend: (message: string) => Promise<void>
}

const KEY = (taskId: string) => `verun:changes:msg:${taskId}`

export const CommitComposer: Component<Props> = (props) => {
  const [msg, setMsg] = createSignal(localStorage.getItem(KEY(props.taskId)) ?? '')
  const [menuPos, setMenuPos] = createSignal<{ x: number; y: number } | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [amendMode, setAmendMode] = createSignal(false)
  // Snapshot of the draft taken when entering amend mode, so Cancel can restore it.
  let preAmendDraft = ''
  let chevronRef: HTMLButtonElement | undefined

  createEffect(on(() => props.taskId, (id) => {
    setMsg(localStorage.getItem(KEY(id)) ?? '')
    setAmendMode(false)
  }))

  createEffect(on(msg, (m) => {
    if (m) localStorage.setItem(KEY(props.taskId), m)
    else localStorage.removeItem(KEY(props.taskId))
  }))

  const submitDisabled = () => busy() || !msg().trim() || !props.canCommit
  const buttonLabel = () => amendMode() ? 'Amend' : 'Commit'

  const runWith = async (op: 'commit' | 'push' | 'amend') => {
    if (submitDisabled() && op !== 'amend') return
    if (op === 'amend' && (busy() || !msg().trim())) return
    setBusy(true)
    let succeeded = false
    try {
      const m = msg()
      if (op === 'commit') await props.onCommit(m)
      else if (op === 'push') await props.onCommitAndPush(m)
      else await props.onAmend(m)
      succeeded = true
    } catch {
      // Toast already surfaced by changesActions; preserve the draft.
    } finally {
      setBusy(false)
    }
    if (succeeded) {
      setMsg('')
      setAmendMode(false)
      setMenuPos(undefined)
    }
  }

  const toggleMenu = () => {
    if (menuPos()) { setMenuPos(undefined); return }
    if (!chevronRef) return
    const r = chevronRef.getBoundingClientRect()
    const menuWidth = 180
    const menuHeight = 60
    setMenuPos({ x: r.right - menuWidth, y: r.top - menuHeight - 4 })
  }

  const enterAmendMode = () => {
    if (!props.canAmend) return
    preAmendDraft = msg()
    setAmendMode(true)
    setMenuPos(undefined)
    setMsg(props.amendDefaultMessage)
  }

  const menuItems = (): ContextMenuItem[] => [
    {
      label: 'Amend last commit',
      icon: History,
      disabled: !props.canAmend,
      action: enterAmendMode,
    },
    {
      label: 'Commit & Push',
      icon: ArrowUpFromLine,
      disabled: submitDisabled(),
      action: () => runWith('push'),
    },
  ]

  const cancelAmend = () => {
    setAmendMode(false)
    setMsg(preAmendDraft)
  }

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (amendMode()) runWith('amend')
      else runWith('commit')
    } else if (e.key === 'Escape' && amendMode()) {
      e.preventDefault()
      cancelAmend()
    }
  }

  return (
    <div class="shrink-0 border-t-1 border-t-solid border-t-outline/8 bg-surface-1 p-2 flex flex-col gap-1.5">
      <textarea
        class="w-full bg-surface-2 text-text-primary text-xs rounded px-2 py-1.5 resize-none ring-1 ring-outline/8 focus:ring-accent/40 outline-none"
        rows={Math.min(6, Math.max(1, msg().split('\n').length))}
        placeholder="Commit message…"
        value={msg()}
        onInput={(e) => setMsg(e.currentTarget.value)}
        onKeyDown={handleKey}
      />
      <div class="flex items-center gap-1 relative">
        <div class="flex items-stretch toolbar-chrome shrink-0 overflow-hidden">
          <button
            class="flex items-center gap-1 px-2 h-6 text-[11px] hover:bg-surface-2 disabled:opacity-40"
            disabled={amendMode() ? (!msg().trim() || busy()) : submitDisabled()}
            onClick={() => runWith(amendMode() ? 'amend' : 'commit')}
          >
            <Show when={busy()} fallback={null}>
              <Loader2 size={11} class="animate-spin" />
            </Show>
            {buttonLabel()}
          </button>
          <span class="w-px self-stretch bg-outline/8" />
          <button
            ref={chevronRef}
            class="flex items-center px-1.5 hover:bg-surface-2"
            onClick={toggleMenu}
          >
            <ChevronDown size={11} />
          </button>
        </div>
        <Show when={amendMode()}>
          <button
            class="h-6 px-2 text-[11px] text-text-dim hover:text-text-secondary hover:bg-surface-2 rounded"
            onClick={cancelAmend}
            title="Cancel amend (Esc)"
          >
            Cancel
          </button>
        </Show>
        <span class="text-[10px] text-text-dim ml-auto">⌘↵</span>
      </div>

      <ContextMenu
        open={!!menuPos()}
        pos={menuPos()}
        items={menuItems()}
        onClose={() => setMenuPos(undefined)}
        minWidth="min-w-44"
      />
    </div>
  )
}
