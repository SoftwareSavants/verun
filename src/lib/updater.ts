import { createSignal } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export interface UpdateInfo {
  version: string
  body: string
}

const [updateAvailable, setUpdateAvailable] = createSignal<UpdateInfo | null>(null)
const [updateProgress, setUpdateProgress] = createSignal<number | null>(null)
const [updateReady, setUpdateReady] = createSignal(false)
const [updateError, setUpdateError] = createSignal<string | null>(null)
const [updateChecking, setUpdateChecking] = createSignal(false)
const [updateUpToDate, setUpdateUpToDate] = createSignal(false)

export {
  updateAvailable,
  updateProgress,
  updateReady,
  updateError,
  updateChecking,
  updateUpToDate,
}

let upToDateTimer: number | null = null
let errorTimer: number | null = null

function flashUpToDate() {
  setUpdateUpToDate(true)
  if (upToDateTimer !== null) clearTimeout(upToDateTimer)
  upToDateTimer = setTimeout(() => setUpdateUpToDate(false), 4000) as unknown as number
}

function flashError(message: string) {
  setUpdateError(message)
  if (errorTimer !== null) clearTimeout(errorTimer)
  errorTimer = setTimeout(() => setUpdateError(null), 6000) as unknown as number
}

let currentUpdate: Update | null = null

export function initUpdateListener() {
  listen<UpdateInfo>('update-available', (event) => {
    setUpdateAvailable(event.payload)
  })

  listen('check-updates', () => {
    checkForUpdate()
  })
}

export async function checkForUpdate() {
  if (updateChecking()) return
  try {
    setUpdateError(null)
    setUpdateUpToDate(false)
    setUpdateChecking(true)
    const update = await check()
    if (update) {
      currentUpdate = update
      setUpdateAvailable({
        version: update.version,
        body: update.body ?? '',
      })
    } else {
      flashUpToDate()
    }
  } catch (e) {
    flashError(String(e))
  } finally {
    setUpdateChecking(false)
  }
}

export async function downloadAndInstall() {
  if (!currentUpdate) {
    const update = await check()
    if (!update) return
    currentUpdate = update
  }

  setUpdateProgress(0)
  setUpdateError(null)

  try {
    let totalLength = 0
    let downloaded = 0

    await currentUpdate.downloadAndInstall((event) => {
      if (event.event === 'Started' && event.data.contentLength) {
        totalLength = event.data.contentLength
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength
        if (totalLength > 0) {
          setUpdateProgress(Math.round((downloaded / totalLength) * 100))
        }
      } else if (event.event === 'Finished') {
        setUpdateProgress(100)
        setUpdateReady(true)
      }
    })
  } catch (e) {
    flashError(String(e))
    setUpdateProgress(null)
  }
}

export async function restartApp() {
  await relaunch()
}

export function dismissUpdate() {
  setUpdateAvailable(null)
  setUpdateProgress(null)
  setUpdateReady(false)
  setUpdateError(null)
  setUpdateUpToDate(false)
}
