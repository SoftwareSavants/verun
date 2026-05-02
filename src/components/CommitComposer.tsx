import { Component, createEffect, createSignal, on, Show } from 'solid-js'
import { ChevronDown, Loader2 } from 'lucide-solid'

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
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [amendMode, setAmendMode] = createSignal(false)

  createEffect(on(() => props.taskId, (id) => {
    setMsg(localStorage.getItem(KEY(id)) ?? '')
    setAmendMode(false)
  }))

  createEffect(on(msg, (m) => {
    if (m) localStorage.setItem(KEY(props.taskId), m)
    else localStorage.removeItem(KEY(props.taskId))
  }))

  const submitDisabled = () => busy() || !msg().trim() || !props.canCommit
  const buttonLabel = () => amendMode() ? 'Commit (amend)' : 'Commit'

  const runWith = async (op: 'commit' | 'push' | 'amend') => {
    if (submitDisabled() && op !== 'amend') return
    if (op === 'amend' && (busy() || !msg().trim())) return
    setBusy(true)
    try {
      const m = msg()
      if (op === 'commit') await props.onCommit(m)
      else if (op === 'push') await props.onCommitAndPush(m)
      else await props.onAmend(m)
      setMsg('')
      setAmendMode(false)
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (amendMode()) runWith('amend')
      else runWith('commit')
    }
  }

  const enterAmendMode = () => {
    if (!props.canAmend) return
    setAmendMode(true)
    setOpen(false)
    if (!msg().trim()) setMsg(props.amendDefaultMessage)
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
            class="flex items-center px-1.5 hover:bg-surface-2"
            onClick={() => setOpen(!open())}
          >
            <ChevronDown size={11} />
          </button>
        </div>
        <span class="text-[10px] text-text-dim ml-auto">⌘↵</span>

        <Show when={open()}>
          <div class="absolute bottom-7 left-0 z-50 bg-surface-2 ring-1 ring-outline/8 rounded shadow-xl py-1 min-w-44">
            <button
              class="menu-item w-full text-left disabled:opacity-40"
              disabled={!props.canAmend}
              onClick={enterAmendMode}
            >
              Amend last commit
            </button>
            <button
              class="menu-item w-full text-left disabled:opacity-40"
              disabled={submitDisabled()}
              onClick={() => runWith('push')}
            >
              Commit & Push
            </button>
            <button
              class="menu-item w-full text-left disabled:opacity-40"
              disabled={submitDisabled()}
              onClick={() => runWith('commit')}
            >
              Stage All & Commit
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}
