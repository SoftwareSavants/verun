import { createEffect, createMemo, createRoot, createSignal, on } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import type { KeepAwakeStatus } from '../lib/keepAwake'
import { isMainWindow } from '../lib/windowContext'
import { workingTaskCount } from './taskStatus'

const AUTO_KEY = 'verun:keepAwakeWhileWorking'
const readAuto = () => { try { return localStorage.getItem(AUTO_KEY) !== 'false' } catch { return true } }

export const [keepAwakeStatus, setKeepAwakeStatus] = createSignal<KeepAwakeStatus>({
  agentsWorking: false, manualUntil: null, manualForever: false, active: false, keepsScreenOn: false,
})
export const [keepAwakeAuto, setKeepAwakeAutoSignal] = createSignal(readAuto())
export function setKeepAwakeAuto(on: boolean) {
  setKeepAwakeAutoSignal(on)
  try { localStorage.setItem(AUTO_KEY, String(on)) } catch { /* ignore */ }
}

export async function initKeepAwake() {
  await listen<KeepAwakeStatus>('keep-awake-changed', e => setKeepAwakeStatus(e.payload))
  setKeepAwakeStatus(await ipc.keepAwakeStatus())
  // Only the main window sees every task, so only it reports "agents working".
  if (!isMainWindow) return
  createRoot(() => {
    // "Working", not "process alive": idle, paused and waiting sessions let the Mac sleep.
    const working = createMemo(() => keepAwakeAuto() && workingTaskCount() > 0)
    createEffect(on(working, w => { ipc.keepAwakeSetAgentsWorking(w).catch(e => console.error('keep awake:', e)) }))
  })
}
