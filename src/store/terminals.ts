import { batch, createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import type { TerminalInstance, PtyOutputEvent, PtyExitedEvent } from '../types'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import { activeTerminalForTask, setActiveTerminalForTaskContext } from './taskContext'

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const [terminals, setTerminals] = createStore<TerminalInstance[]>([])

// Tasks being deleted — suppress auto-spawn for these
const deletingTasks = new Set<string>()

// Terminal exit status: terminalId → exit code (undefined = still running, null = unknown)
const [terminalExitCodes, setTerminalExitCodes] = createSignal<Record<string, number | null>>({})

// Tasks that have completed hydration (fetched existing PTYs from Rust). Used by
// TerminalPanel to suppress auto-spawn until we know whether any PTYs already exist.
const [hydratedTaskIds, setHydratedTaskIds] = createSignal<Set<string>>(new Set())

export interface XtermEntry {
  term: XTerm
  fitAddon: FitAddon
  searchAddon?: SearchAddon
}
const xtermInstances = new Map<string, XtermEntry>()

const ptyWriteBuffers = new Map<string, string[]>()
const ptyRafIds = new Map<string, number>()

// Highest seq already written to an xterm (either via replay or live). Events
// with seq <= this are duplicates and dropped.
const lastSeqWritten = new Map<string, number>()

// Live events received before ShellTerminal has registered an xterm for the
// terminal. Flushed on register. Seq-tagged so stale entries (covered by a
// later snapshot replay) can be filtered out.
interface PendingChunk { data: string; seq: number }
const pendingChunks = new Map<string, PendingChunk[]>()

function flushPtyBuffer(terminalId: string) {
  const buf = ptyWriteBuffers.get(terminalId)
  const entry = xtermInstances.get(terminalId)
  if (buf && buf.length > 0 && entry) {
    entry.term.write(buf.join(''))
    buf.length = 0
  }
  ptyRafIds.delete(terminalId)
}

function cleanupPtyBuffer(terminalId: string) {
  const rafId = ptyRafIds.get(terminalId)
  if (rafId != null) cancelAnimationFrame(rafId)
  ptyRafIds.delete(terminalId)
  ptyWriteBuffers.delete(terminalId)
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export { terminals, terminalExitCodes }

export function terminalsForTask(taskId: string): TerminalInstance[] {
  return terminals.filter(t => t.taskId === taskId)
}

export function activeTerminalId(taskId: string): string | null {
  return activeTerminalForTask(taskId)
}

export function setActiveTerminalForTask(taskId: string, terminalId: string | null) {
  setActiveTerminalForTaskContext(taskId, terminalId)
}

// ---------------------------------------------------------------------------
// xterm instance registry
// ---------------------------------------------------------------------------

/** Consume any replay scrollback attached to this terminal. Called exactly once
 *  by ShellTerminal.onMount: returns the data to write into xterm and clears
 *  the store entry so a re-mount doesn't double-replay. */
export function consumeInitialReplay(terminalId: string): { data: string; seq: number } | null {
  const idx = terminals.findIndex(t => t.id === terminalId)
  if (idx < 0) return null
  const replay = terminals[idx].initialReplay
  if (!replay) return null
  setTerminals(idx, 'initialReplay', undefined)
  return replay
}

/** Record the highest seq already written to xterm for this terminal — live
 *  events with seq <= this are dropped as duplicates of the replay. */
export function markSeqWritten(terminalId: string, seq: number) {
  const prev = lastSeqWritten.get(terminalId) ?? 0
  if (seq > prev) lastSeqWritten.set(terminalId, seq)
}

export function registerXterm(terminalId: string, term: XTerm, fitAddon: FitAddon, searchAddon?: SearchAddon) {
  xtermInstances.set(terminalId, { term, fitAddon, searchAddon })
  // Drain any live chunks that arrived after the snapshot was taken but before
  // this xterm was mounted. Stale chunks (seq <= last written) are skipped.
  const pending = pendingChunks.get(terminalId)
  if (pending && pending.length > 0) {
    const last = lastSeqWritten.get(terminalId) ?? 0
    const fresh = pending.filter(c => c.seq > last)
    if (fresh.length > 0) {
      term.write(fresh.map(c => c.data).join(''))
      lastSeqWritten.set(terminalId, fresh[fresh.length - 1].seq)
    }
  }
  pendingChunks.delete(terminalId)
}

export function getXtermEntry(terminalId: string): XtermEntry | undefined {
  return xtermInstances.get(terminalId)
}

// ---------------------------------------------------------------------------
// Focus & refit
// ---------------------------------------------------------------------------

/** Refit + refresh a terminal entry (e.g. after becoming visible) */
function refitEntry(entry: XtermEntry) {
  entry.fitAddon.fit()
  entry.term.refresh(0, entry.term.rows - 1)
}

export function focusActiveTerminal(taskId: string) {
  const tid = activeTerminalId(taskId)
  if (!tid) return
  const entry = xtermInstances.get(tid)
  if (!entry) return
  refitEntry(entry)
  entry.term.focus()
}

export function refitActiveTerminal(taskId: string) {
  const tid = activeTerminalId(taskId)
  if (!tid) return
  const entry = xtermInstances.get(tid)
  if (entry) refitEntry(entry)
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Inject fake running start-command terminals for demo/screenshot mode. */
export function seedDemoStartCommands(taskIds: string[]) {
  setTerminals(produce(t => {
    for (const taskId of taskIds) {
      t.push({ id: `demo-pty-${taskId}`, taskId, name: 'Dev Server', isStartCommand: true })
    }
  }))
}

export async function spawnTerminal(taskId: string, rows: number, cols: number, initialCommand?: string, isStartCommand?: boolean): Promise<TerminalInstance> {
  // `directCommand` controls how the shell is invoked (login vs. sh -c). For
  // start commands we pass both so Rust can label the handle correctly.
  const result = await ipc.ptySpawn(taskId, rows, cols, initialCommand, isStartCommand || undefined, isStartCommand || undefined)
  const name = isStartCommand ? 'Dev Server' : result.shellName
  const instance: TerminalInstance = { id: result.terminalId, taskId, name, isStartCommand }
  // Batch so the <For> in TerminalPanel mounts the new ShellTerminal with
  // activeId already pointing at it — otherwise xterm.js initializes inside
  // a display:none wrapper and never refits when the wrapper later flips visible.
  batch(() => {
    if (isStartCommand) {
      setTerminals(produce(t => t.unshift(instance)))
    } else {
      setTerminals(produce(t => t.push(instance)))
    }
    setActiveTerminalForTask(taskId, result.terminalId)
  })
  return instance
}

export const isTaskHydrated = (taskId: string) => hydratedTaskIds().has(taskId)

/** Fetch the Rust-side PTY snapshot for this task and reconcile the store:
 *  add PTYs that are new to this window (carrying a replay buffer so xterm can
 *  redraw scrollback on mount) and remove PTYs that no longer exist (e.g.
 *  closed in another window). Idempotent; safe to call on every task switch
 *  and whenever a sibling window closes. */
export async function hydrateTerminalsForTask(taskId: string): Promise<void> {
  let entries: Awaited<ReturnType<typeof ipc.ptyListForTask>> = []
  try {
    entries = await ipc.ptyListForTask(taskId)
  } catch (err) {
    console.error('hydrateTerminalsForTask failed:', err)
    // Bail out: without a snapshot we can't tell stale from live, so leaving
    // the store untouched is safer than pruning.
    setHydratedTaskIds(prev => {
      if (prev.has(taskId)) return prev
      const next = new Set(prev)
      next.add(taskId)
      return next
    })
    return
  }

  const backendIds = new Set(entries.map(e => e.terminalId))
  // Prune: terminals in our store for this task that the backend no longer
  // knows about (closed in another window, or backend process ended).
  // suppressAutoSpawn: re-hydration should never materialize a brand-new shell
  // just because every PTY we were tracking turned out to be gone — the live
  // entries below (or TerminalPanel's own gate) will handle that.
  const stale = terminals.filter(t => t.taskId === taskId && !backendIds.has(t.id))
  for (const t of stale) removeTerminal(t.id, { suppressAutoSpawn: true })

  for (const e of entries) {
    if (terminals.find(t => t.id === e.terminalId)) continue
    const hookType = e.hookType === 'setup' || e.hookType === 'destroy' ? e.hookType : undefined
    const instance: TerminalInstance = {
      id: e.terminalId,
      taskId: e.taskId,
      name: e.name,
      isStartCommand: e.isStartCommand || undefined,
      hookType,
      initialReplay: e.bufferedOutput ? { data: e.bufferedOutput, seq: e.seq } : undefined,
    }
    // Drop any pending chunks already covered by this snapshot so ShellTerminal
    // doesn't double-write them after replay.
    const pending = pendingChunks.get(e.terminalId)
    if (pending) {
      const fresh = pending.filter(c => c.seq > e.seq)
      if (fresh.length > 0) pendingChunks.set(e.terminalId, fresh)
      else pendingChunks.delete(e.terminalId)
    }
    if (e.isStartCommand || hookType) {
      setTerminals(produce(t => t.unshift(instance)))
    } else {
      setTerminals(produce(t => t.push(instance)))
    }
    if (!activeTerminalForTask(taskId)) {
      setActiveTerminalForTask(taskId, e.terminalId)
    }
  }

  setHydratedTaskIds(prev => {
    if (prev.has(taskId)) return prev
    const next = new Set(prev)
    next.add(taskId)
    return next
  })
}

/** Check if a start command terminal exists for this task */
export function startCommandTerminalId(taskId: string): string | null {
  const t = terminals.find(t => t.taskId === taskId && t.isStartCommand)
  return t?.id ?? null
}

/** Whether a terminal has exited (exit code tracked) */
export function isTerminalStopped(terminalId: string): boolean {
  return terminalId in terminalExitCodes()
}

/** Whether the start command for a task is currently running (exists and not exited) */
export function isStartCommandRunning(taskId: string): boolean {
  const tid = startCommandTerminalId(taskId)
  return tid != null && !isTerminalStopped(tid)
}

/** Spawn the start command in a new terminal, removing any dead previous one first.
 *  Wraps the command so the shell exits when it finishes — this way pty-exited fires
 *  and the terminal correctly transitions to stopped state (e.g. on Ctrl+C or crash). */
export async function spawnStartCommand(taskId: string, command: string): Promise<TerminalInstance> {
  // Remove any existing (stopped) start command terminal
  const existing = startCommandTerminalId(taskId)
  if (existing) {
    if (!isTerminalStopped(existing)) {
      // Still running — close it first
      await closeTerminal(existing)
    } else {
      removeTerminal(existing)
    }
  }
  return spawnTerminal(taskId, 24, 80, command, true)
}

/** Stop a running start command terminal (keeps it visible in stopped state) */
export async function stopStartCommand(taskId: string) {
  const tid = startCommandTerminalId(taskId)
  if (tid && !isTerminalStopped(tid)) {
    await ipc.ptyClose(tid)
    // Don't call removeTerminal — the pty-exited handler will mark it as stopped
  }
}

/** Register a hook terminal (PTY already spawned by backend via run_hook). Inserts at position 0. */
export function registerHookTerminal(taskId: string, terminalId: string, hookType: 'setup' | 'destroy') {
  // Remove any existing hook terminal of the same type for this task
  setTerminals(prev => prev.filter(t => !(t.taskId === taskId && t.hookType === hookType)))
  const name = hookType === 'setup' ? 'Setup' : 'Destroy'
  const instance: TerminalInstance = { id: terminalId, taskId, name, hookType }
  setTerminals(produce(t => t.unshift(instance)))
  setActiveTerminalForTask(taskId, terminalId)
}

export async function closeTerminal(terminalId: string) {
  await ipc.ptyClose(terminalId)
  removeTerminal(terminalId)
}

function removeTerminal(terminalId: string, opts: { suppressAutoSpawn?: boolean } = {}) {
  cleanupPtyBuffer(terminalId)
  pendingChunks.delete(terminalId)
  lastSeqWritten.delete(terminalId)
  const term = terminals.find(t => t.id === terminalId)
  const taskId = term?.taskId
  const isSpecial = !!term?.hookType || !!term?.isStartCommand

  // Clean up exit code tracking
  setTerminalExitCodes(prev => { const next = { ...prev }; delete next[terminalId]; return next })

  setTerminals(prev => prev.filter(t => t.id !== terminalId))
  xtermInstances.get(terminalId)?.term.dispose()
  xtermInstances.delete(terminalId)

  if (taskId && activeTerminalId(taskId) === terminalId) {
    const remaining = terminals.filter(t => t.taskId === taskId && t.id !== terminalId)
    if (remaining.length > 0) {
      setActiveTerminalForTask(taskId, remaining[remaining.length - 1].id)
    } else if (!deletingTasks.has(taskId) && !isSpecial && !opts.suppressAutoSpawn) {
      spawnTerminal(taskId, 24, 80)
    }
  }
}

/** Clean up all terminals for a task being deleted */
export function closeTerminalsForTask(taskId: string) {
  deletingTasks.add(taskId)
  const ids = terminals.filter(t => t.taskId === taskId).map(t => t.id)
  for (const id of ids) {
    cleanupPtyBuffer(id)
    pendingChunks.delete(id)
    lastSeqWritten.delete(id)
    xtermInstances.get(id)?.term.dispose()
    xtermInstances.delete(id)
  }
  setTerminals(prev => prev.filter(t => t.taskId !== taskId))
  setHydratedTaskIds(prev => {
    if (!prev.has(taskId)) return prev
    const next = new Set(prev)
    next.delete(taskId)
    return next
  })
  // deletingTasks cleanup delayed to let async pty-exited events arrive
  setTimeout(() => deletingTasks.delete(taskId), 2000)
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

export async function initTerminalListeners() {
  await listen<PtyOutputEvent>('pty-output', (event) => {
    const { terminalId, data, seq } = event.payload
    // Dedupe: a snapshot replay has already covered anything with seq <= last.
    const last = lastSeqWritten.get(terminalId) ?? 0
    if (seq <= last) return

    const entry = xtermInstances.get(terminalId)
    if (!entry) {
      // xterm not mounted yet — stash until registerXterm flushes.
      let pending = pendingChunks.get(terminalId)
      if (!pending) {
        pending = []
        pendingChunks.set(terminalId, pending)
      }
      pending.push({ data, seq })
      return
    }

    lastSeqWritten.set(terminalId, seq)
    let buf = ptyWriteBuffers.get(terminalId)
    if (!buf) {
      buf = []
      ptyWriteBuffers.set(terminalId, buf)
    }
    buf.push(data)
    if (!ptyRafIds.has(terminalId)) {
      ptyRafIds.set(terminalId, requestAnimationFrame(() => flushPtyBuffer(terminalId)))
    }
  })

  await listen<PtyExitedEvent>('pty-exited', (event) => {
    const { terminalId, exitCode } = event.payload
    const term = terminals.find(t => t.id === terminalId)
    // Keep hook and start command terminals alive after exit (read-only logs)
    if (term?.hookType || term?.isStartCommand) {
      setTerminalExitCodes(prev => ({ ...prev, [terminalId]: exitCode ?? null }))
      return
    }
    removeTerminal(terminalId)
  })
}
