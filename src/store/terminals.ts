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

export interface XtermEntry {
  term: XTerm
  fitAddon: FitAddon
}
const xtermInstances = new Map<string, XtermEntry>()

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export { terminals }

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

export async function spawnTerminal(taskId: string, rows: number, cols: number): Promise<TerminalInstance> {
  const result = await ipc.ptySpawn(taskId, rows, cols)
  const instance: TerminalInstance = { id: result.terminalId, taskId, name: result.shellName }
  setTerminals(produce(t => t.push(instance)))
  setActiveTerminalForTask(taskId, result.terminalId)
  return instance
}

export async function closeTerminal(terminalId: string) {
  await ipc.ptyClose(terminalId)
  removeTerminal(terminalId)
}

function removeTerminal(terminalId: string) {
  const term = terminals.find(t => t.id === terminalId)
  const taskId = term?.taskId

  setTerminals(prev => prev.filter(t => t.id !== terminalId))
  xtermInstances.get(terminalId)?.term.dispose()
  xtermInstances.delete(terminalId)

  if (taskId && activeTerminalId(taskId) === terminalId) {
    const remaining = terminals.filter(t => t.taskId === taskId && t.id !== terminalId)
    if (remaining.length > 0) {
      setActiveTerminalForTask(taskId, remaining[remaining.length - 1].id)
    } else if (!deletingTasks.has(taskId)) {
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
    removeTerminal(event.payload.terminalId)
  })
}
