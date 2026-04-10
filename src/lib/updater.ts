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

export { updateAvailable, updateProgress, updateReady, updateError }

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
  try {
    setUpdateError(null)
    const update = await check()
    if (update) {
      currentUpdate = update
      setUpdateAvailable({
        version: update.version,
        body: update.body ?? '',
      })
    }
  } catch (e) {
    setUpdateError(String(e))
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
    setUpdateError(String(e))
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
}
