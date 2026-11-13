import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import { listen } from '@tauri-apps/api/event'
import * as ipc from '../lib/ipc'
import { windowContext } from '../lib/windowContext'
import type {
  HoldKey, Language, ModelId, VoiceError, VoiceErrorEvent, VoiceLevelEvent, VoiceModelProgressEvent,
  VoiceState, VoiceStateEvent, VoiceStatus, VoiceTakeDroppedEvent, VoiceTranscriptEvent,
} from '../types/voice'
import { sessionById } from './sessions'
import { projectById } from './projects'
import { appendToDraft, newTaskDraftProject } from './sessionDrafts'
import { addToast } from './ui'

export interface DictationTarget {
  /** Stable id: `session:<sid>` or `new-task:<projectId>`. */
  id: string
  /**
   * The draft a take begun here is pinned to (the backend carries it in the
   * take's events). The take goes to the live target with this draft, or to the
   * draft itself once none is registered (see `sessionDrafts`).
   */
  draftId: string
  insert(take: string): void
}

const [status, setStatus] = createSignal<VoiceStatus | null>(null)
const [level, setLevel] = createSignal(0)
/** The take this window is recording right now. */
const [recordingTake, setRecordingTake] = createSignal<number | null>(null)
/** Takes of this window still waiting for their terminal event. Replaced on change so reads are reactive. */
const [takesOut, setTakesOut] = createSignal<ReadonlySet<number>>(new Set<number>())

export const voiceStatus: Accessor<VoiceStatus | null> = status

/** Dictation exists on this Mac (Apple Silicon); everything about it is hidden otherwise. */
export const dictationAvailable: Accessor<boolean> = () => status()?.supported === true

/** A model download this app has seen, from `voice-model-progress`. */
export interface ModelDownload {
  received: number
  total: number
  done: boolean
  error: string | null
}
const [downloads, setDownloads] = createSignal<Partial<Record<ModelId, ModelDownload>>>({})
/** Per model: the running download, or how the last one ended until the model shows installed. */
export const modelDownloads: Accessor<Partial<Record<ModelId, ModelDownload>>> = downloads

function setDownload(model: ModelId, d: ModelDownload) {
  setDownloads({ ...downloads(), [model]: d })
  forgetInstalled()
  // A failed download ends the choice that was waiting for it.
  if (d.done && d.error && pendingModel() === model) setPendingLanguage(null)
}

/** A cancelled download is forgotten (the download button comes back), with any choice waiting for it. */
function forgetDownload(model: ModelId) {
  const next = { ...downloads() }
  delete next[model]
  setDownloads(next)
  if (pendingModel() === model) setPendingLanguage(null)
}

/** A finished download is done with once the status shows its model installed. */
function forgetInstalled() {
  const installed = new Set(status()?.models.filter(m => m.installed).map(m => m.id))
  const current = downloads()
  const stale = (Object.keys(current) as ModelId[]).filter(id => {
    const d = current[id]
    return d?.done && !d.error && installed.has(id)
  })
  if (stale.length === 0) return
  const next = { ...current }
  for (const id of stale) delete next[id]
  setDownloads(next)
}

/**
 * The user's latest language choice, made in setup, whose model was not
 * installed yet; set once it is. Only ever the latest choice with its download
 * in play: a newer choice, a failed download, or leaving setup before the
 * download runs drops it.
 */
const [pendingLanguage, setPendingLanguage] = createSignal<Language | null>(null)
export const pendingDictationLanguage: Accessor<Language | null> = pendingLanguage

function pendingModel(): ModelId | null {
  const pending = pendingLanguage()
  return (pending && status()?.languages.find(l => l.code === pending)?.model) || null
}

function applyStatus(s: VoiceStatus) {
  setStatus(s)
  watchAccessibility(s)
  forgetInstalled()
  const pending = pendingLanguage()
  if (pending && s.languages.find(l => l.code === pending)?.installed) {
    setPendingLanguage(null)
    if (s.language !== pending) void setDictationLanguage(pending)
  }
}

/** A rejected voice command as text: errors come as a string or `{ engine }`. */
function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'engine' in e) return String((e as { engine: unknown }).engine)
  return String(e)
}

/** Runs a status-returning command and shows its result; a failure is a toast. */
async function act(run: () => Promise<VoiceStatus>): Promise<void> {
  try {
    applyStatus(await run())
  } catch (e) {
    addToast(`Dictation: ${errorText(e)}`, 'error')
  }
}

/** Re-reads the status (permissions may have changed in System Settings). */
export const refreshVoiceStatus = () => act(ipc.voiceStatus)
export const setDictationEnabled = (enabled: boolean) => act(() => ipc.voiceSetEnabled(enabled))
/** The language a `voice_set_language` call is on its way to set, so it is not sent twice. */
let languageInFlight: Language | null = null

/** Sets the language now (a newer choice than any pending one, which it drops). */
export async function setDictationLanguage(language: Language): Promise<void> {
  setPendingLanguage(null)
  languageInFlight = language
  try {
    await act(() => ipc.voiceSetLanguage(language))
  } finally {
    if (languageInFlight === language) languageInFlight = null
  }
}

/**
 * The user picked `language`: set it now if its model is installed, else when
 * the model shows installed, so dictation keeps working in the old one meanwhile.
 */
export async function chooseDictationLanguage(language: Language): Promise<void> {
  if (languageInFlight === language) {
    setPendingLanguage(null)
    return
  }
  const s = status()
  if (s?.languages.find(l => l.code === language)?.installed) {
    if (s.language !== language) await setDictationLanguage(language)
    else setPendingLanguage(null)
  } else {
    setPendingLanguage(language)
  }
}
export const setDictationHoldKey = (key: HoldKey) => act(() => ipc.voiceSetHoldKey(key))
/** Refused by the backend (status unchanged) while that model is downloading. */
export const deleteDictationModel = (model: ModelId) => act(() => ipc.voiceDeleteModel(model))

/** Shows the system prompt if the user was never asked, then re-reads the status. */
export async function requestMicrophone(): Promise<void> {
  try {
    await ipc.voiceRequestMicrophone()
  } catch (e) {
    console.error('voice request microphone:', e)
  }
  await refreshVoiceStatus()
}

// One window `focus` listener however many views want the status re-read on focus.
let focusWatchers = 0
/** Bumped by the test reset, so a stop function from before it does nothing. */
let focusGeneration = 0
const onWindowFocus = () => { void refreshVoiceStatus() }

/**
 * Re-reads the status each time the window regains focus (permissions change in
 * System Settings) while at least one caller watches. Returns the stop function.
 */
export function watchVoiceStatusOnFocus(): () => void {
  if (focusWatchers++ === 0) window.addEventListener('focus', onWindowFocus)
  const generation = focusGeneration
  let stopped = false
  return () => {
    if (stopped || generation !== focusGeneration) return
    stopped = true
    if (--focusWatchers === 0) window.removeEventListener('focus', onWindowFocus)
  }
}

/** The watcher kept while the hold key waits for Accessibility, which the user may grant after skipping it in setup. */
let accessibilityWatch: (() => void) | null = null

function watchAccessibility(s: VoiceStatus) {
  const waiting = s.supported && s.enabled && !s.accessibility
  if (waiting && !accessibilityWatch) accessibilityWatch = watchVoiceStatusOnFocus()
  else if (!waiting && accessibilityWatch) {
    accessibilityWatch()
    accessibilityWatch = null
  }
}

export function openAccessibilitySettings(): void {
  ipc.voiceOpenAccessibilitySettings().catch(e => console.error('voice open accessibility settings:', e))
}

/** Starts a download; progress arrives as events. A running one is left alone, without asking again. */
export function downloadDictationModel(model: ModelId): void {
  const current = downloads()[model]
  if (current && !current.done) return
  const bytes = status()?.models.find(m => m.id === model)?.bytes ?? 0
  setDownload(model, { received: 0, total: bytes, done: false, error: null })
  ipc.voiceDownloadModel(model).catch(e => {
    const d = downloads()[model]
    setDownload(model, { received: d?.received ?? 0, total: d?.total ?? 0, done: true, error: errorText(e) })
  })
}

/** Stops a running download at its next chunk; the backend removes the partial file. */
export function cancelDictationDownload(model: ModelId): void {
  ipc.voiceCancelDownload(model).catch(e => console.error('voice cancel download:', e))
}

export const voiceState: Accessor<VoiceState> = () =>
  recordingTake() !== null ? 'recording' : takesOut().size > 0 ? 'transcribing' : 'idle'

export const voiceLevel: Accessor<number> = () => (voiceState() === 'recording' ? level() : 0)

/**
 * Why setup opened, which decides its steps and its finish:
 * - `enable`: turn dictation on (mic button or Settings switch while off, a `disabled` error)
 * - `model-missing`: dictation is on but the current language's model is gone
 * - `add-language`: the composer switcher's "Add language..."
 * - `language`: Settings picked `language`, whose model is not installed
 */
export type SetupReason = 'enable' | 'model-missing' | 'add-language' | 'language'
export interface DictationSetupRequest {
  reason: SetupReason
  language?: Language
}

const [setupRequest, setSetupRequest] = createSignal<DictationSetupRequest | null>(null)
export const dictationSetupRequest: Accessor<DictationSetupRequest | null> = setupRequest
/**
 * Closes setup. A pending language stays only while its model's download runs
 * (the dialog says it continues in the background); otherwise it is dropped.
 */
export function clearDictationSetupRequest(): void {
  setSetupRequest(null)
  const model = pendingModel()
  const download = model ? downloads()[model] : undefined
  if (!download || download.done) setPendingLanguage(null)
}
/** Opens the setup dialog (mounted in every window). */
export function openDictationSetup(request: DictationSetupRequest = { reason: 'enable' }): void {
  setSetupRequest({ ...request })
}

// Registered targets, oldest first; the last one is the visible composer.
let targets: DictationTarget[] = []

const label = () => windowContext.windowLabel

/** The visible target's draft, which a take begun now is for; null with none. */
const visibleDraft = (): string | null => targets[targets.length - 1]?.draftId ?? null

/** The draft the backend was last told this window shows; undefined before the first report. */
let reportedDraft: string | null | undefined
let reportQueued = false

/** Counted as reported while the call is out, so it is not sent twice; a failed one is forgotten and sent again on the next change. */
function sendTarget(draft: string | null) {
  reportedDraft = draft
  ipc.voiceSetTarget(label(), draft).catch(e => {
    if (reportedDraft === draft) reportedDraft = undefined
    console.error('voice set target:', e)
  })
}

/**
 * Tells the backend the draft of this window's visible target once the
 * current changes settle (a chat switch swaps targets in one go), and only
 * when it changed. A hold-key take is pinned to it when it begins, and a hold
 * in a window without one opens no microphone.
 */
function reportTarget() {
  if (reportQueued) return
  reportQueued = true
  queueMicrotask(() => {
    reportQueued = false
    const draft = visibleDraft()
    if (draft !== reportedDraft) sendTarget(draft)
  })
}

export function registerDictationTarget(t: DictationTarget): () => void {
  targets.push(t)
  reportTarget()
  return () => {
    const i = targets.indexOf(t)
    if (i >= 0) targets.splice(i, 1)
    reportTarget()
  }
}

/** The take is over: it had its terminal event. */
function release(take: number) {
  if (recordingTake() === take) setRecordingTake(null)
  if (!takesOut().has(take)) return
  const next = new Set(takesOut())
  next.delete(take)
  setTakesOut(next)
}

function handleError(error: VoiceError) {
  if (error === 'disabled') return openDictationSetup({ reason: 'enable' })
  // The model may have been deleted outside the app: read the status before showing it.
  if (error === 'model-missing') {
    void refreshVoiceStatus().then(() => openDictationSetup({ reason: 'model-missing' }))
    return
  }
  if (error === 'no-target') addToast('Dictation works in the chat box and the new task box.', 'info')
  else if (error === 'busy') addToast('Dictation is already recording in another window.', 'info')
  else if (error === 'mic-denied') addToast('Microphone access is off for Verun. Turn it on in System Settings.', 'error')
  else if (error === 'mic-unavailable') addToast('No microphone found, or it stopped responding.', 'error')
  else addToast('Dictation failed. Try again.', 'error')
}

function onState({ state, window, take }: VoiceStateEvent) {
  // Any state event supersedes a recording this window had; only a recording event for us restarts it.
  setRecordingTake(null)
  if (state === 'idle' && window === null) setTakesOut(new Set<number>())
  if (state !== 'recording' || window !== label() || take === null) return
  if (targets.length > 0) {
    setTakesOut(new Set(takesOut()).add(take))
    // The meter starts from silence, not from the last take's final level.
    setLevel(0)
    setRecordingTake(take)
  } else {
    // The composer went away as the take began: the backend pinned it to nothing.
    ipc.voiceCancel().catch(e => console.error('voice cancel:', e))
    addToast('Dictation works in the chat box and the new task box.', 'info')
  }
}

/**
 * The backend sends a transcript to exactly one window: the one the take began
 * in, or the main window once that closed. It goes to the live target of the
 * take's draft in this window, else to that draft.
 */
function onTranscript({ window, take, text, draft }: VoiceTranscriptEvent) {
  if (window !== label()) return
  release(take)
  // Nothing to insert. Every target and draft comes through here, so none can
  // turn a blank take into a deleted selection (an empty insertText does that).
  if (!text.trim()) return
  // A remounted composer for the same chat has a new object with the same draft.
  const live = draft !== null && [...targets].reverse().find(t => t.draftId === draft)
  if (live) return live.insert(text)
  // Its box is hidden, unmounted or sending, or the take is from a window that
  // closed (sent to this one): it goes to that box's draft.
  if (draft !== null && draftExists(draft)) {
    appendToDraft(draft, text)
    addToast(newTaskDraftProject(draft) !== null
      ? 'Dictation saved to the new task draft.'
      : 'Dictation saved to the draft of the chat you were in.', 'info')
  } else {
    addToast('Dictation dropped: that chat is gone.', 'info')
  }
}

/** The chat, or the project of a new-task box, a draft belongs to still exists. */
function draftExists(draftId: string): boolean {
  const projectId = newTaskDraftProject(draftId)
  return projectId !== null ? !!projectById(projectId) : !!sessionById(draftId)
}

let initialized = false
let unlisteners: Array<() => void> = []
let statusEventSeen = false

export async function initVoice(): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    const results = await Promise.allSettled([
      listen<VoiceStateEvent>('voice-state', e => onState(e.payload)),
      listen<VoiceLevelEvent>('voice-level', e => { setLevel(e.payload.level) }),
      listen<VoiceTranscriptEvent>('voice-transcript', e => onTranscript(e.payload)),
      listen<VoiceErrorEvent>('voice-error', e => {
        if (e.payload.window !== label()) return
        if (e.payload.take !== null) release(e.payload.take)
        handleError(e.payload.error)
      }),
      listen<VoiceTakeDroppedEvent>('voice-take-dropped', e => {
        if (e.payload.window === label()) release(e.payload.take)
      }),
      listen<VoiceStatus>('voice-status-changed', e => { statusEventSeen = true; applyStatus(e.payload) }),
      listen<VoiceModelProgressEvent>('voice-model-progress', e => {
        const { model, received, total, done, error, cancelled } = e.payload
        if (done && cancelled) forgetDownload(model)
        else setDownload(model, { received, total, done, error })
      }),
    ])
    unlisteners = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
    const failure = results.find(r => r.status === 'rejected')
    if (failure) throw (failure as PromiseRejectedResult).reason
    // The backend may know an older page of this window (a reload): report afresh.
    sendTarget(visibleDraft())
    const initial = await ipc.voiceStatus()
    if (!statusEventSeen) applyStatus(initial)
  } catch (e) {
    unlisteners.forEach(u => u())
    unlisteners = []
    initialized = false
    throw e
  }
}

/** A `voice_begin` on its way, so a second click does not end or repeat it. */
let beginInFlight = false

export function toggleDictation(): void {
  if (beginInFlight) return
  const s = status()
  if (!s || !s.enabled) return openDictationSetup({ reason: 'enable' })
  if (recordingTake() !== null) {
    ipc.voiceEnd().catch(e => console.error('voice end:', e))
    return
  }
  beginInFlight = true
  ipc.voiceBegin(label(), visibleDraft())
    .catch((e: VoiceError) => handleError(e))
    .finally(() => { beginInFlight = false })
}

/** Test-only: drop all module state so tests never leak into each other. */
export function __resetVoiceForTests(): void {
  unlisteners.forEach(u => u())
  unlisteners = []
  initialized = false
  statusEventSeen = false
  targets = []
  reportedDraft = undefined
  reportQueued = false
  setStatus(null)
  setLevel(0)
  setRecordingTake(null)
  setTakesOut(new Set<number>())
  setSetupRequest(null)
  setDownloads({})
  setPendingLanguage(null)
  languageInFlight = null
  beginInFlight = false
  accessibilityWatch = null
  if (focusWatchers > 0) window.removeEventListener('focus', onWindowFocus)
  focusWatchers = 0
  focusGeneration++
}
