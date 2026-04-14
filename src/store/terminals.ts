import { createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import type { TerminalInstance, PtyOutputEvent, PtyExitedEvent } from '../types'
import type { Terminal as XTerm } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const [terminals, setTerminals] = createStore<TerminalInstance[]>([])
const [activeTerminalIds, setActiveTerminalIds] = createSignal<Record<string, string>>({})

// Tasks being deleted — suppress auto-spawn for these
const deletingTasks = new Set<string>()

// Terminal exit status: terminalId → exit code (undefined = still running, null = unknown)
const [terminalExitCodes, setTerminalExitCodes] = createSignal<Record<string, number | null>>({})

export interface XtermEntry {
  term: XTerm
  fitAddon: FitAddon
}
const xtermInstances = new Map<string, XtermEntry>()

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export { terminals, terminalExitCodes }

export function terminalsForTask(taskId: string): TerminalInstance[] {
  return terminals.filter(t => t.taskId === taskId)
}

export function activeTerminalId(taskId: string): string | null {
  return activeTerminalIds()[taskId] ?? null
}

export function setActiveTerminalForTask(taskId: string, terminalId: string | null) {
  setActiveTerminalIds(prev => ({ ...prev, [taskId]: terminalId! }))
}

// ---------------------------------------------------------------------------
// xterm instance registry
// ---------------------------------------------------------------------------

export function registerXterm(terminalId: string, term: XTerm, fitAddon: FitAddon) {
  xtermInstances.set(terminalId, { term, fitAddon })
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
  const result = await ipc.ptySpawn(taskId, rows, cols, initialCommand, isStartCommand || undefined)
  const name = isStartCommand ? 'Dev Server' : result.shellName
  const instance: TerminalInstance = { id: result.terminalId, taskId, name, isStartCommand }
  if (isStartCommand) {
    setTerminals(produce(t => t.unshift(instance)))
  } else {
    setTerminals(produce(t => t.push(instance)))
  }
  setActiveTerminalForTask(taskId, result.terminalId)
  return instance
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

function removeTerminal(terminalId: string) {
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
    } else if (!deletingTasks.has(taskId) && !isSpecial) {
      spawnTerminal(taskId, 24, 80)
    }
  }
}

/** Clean up all terminals for a task being deleted */
export function closeTerminalsForTask(taskId: string) {
  deletingTasks.add(taskId)
  const ids = terminals.filter(t => t.taskId === taskId).map(t => t.id)
  for (const id of ids) {
    xtermInstances.get(id)?.term.dispose()
    xtermInstances.delete(id)
  }
  setTerminals(prev => prev.filter(t => t.taskId !== taskId))
  // deletingTasks cleanup delayed to let async pty-exited events arrive
  setTimeout(() => deletingTasks.delete(taskId), 2000)
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

export async function initTerminalListeners() {
  await listen<PtyOutputEvent>('pty-output', (event) => {
    const { terminalId, data } = event.payload
    xtermInstances.get(terminalId)?.term.write(data)
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
