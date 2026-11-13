import { Component, For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { Toggle } from './Toggle'
import { ConfirmDialog } from './ConfirmDialog'
import { FnConflictHint, MIC_DENIED_HELP, ModelDownload, SMALL_BUTTON, stableKeys } from './DictationParts'
import {
  voiceStatus, openDictationSetup, refreshVoiceStatus, setDictationEnabled, setDictationLanguage,
  setDictationHoldKey, deleteDictationModel, requestMicrophone, openAccessibilitySettings, watchVoiceStatusOnFocus,
} from '../store/voice'
import { LANGUAGE_NAMES } from '../lib/voiceLanguages'
import { holdKeyName } from '../lib/holdKeyName'
import { formatDownloadSize } from '../lib/format'
import { useDismissable } from '../lib/dismissable'
import type { HoldKey, Language, ModelId, VoiceStatus } from '../types/voice'

const HOLD_KEYS: HoldKey[] = ['fn', 'right-option', 'right-command']
const SELECT = 'bg-surface-1 ring-1 ring-outline/8 rounded-lg px-2 py-1 text-xs text-text-secondary outline-none focus:ring-accent/40'
const ROW_CARD = 'rounded-lg bg-surface-1 ring-1 ring-outline/8 px-3 py-2.5 flex items-center justify-between gap-3'

/**
 * Settings -> Dictation. Shown only where dictation is supported (SettingsPage
 * hides it otherwise). Turning it on before setup is done goes through the setup
 * dialog, so the permissions and the model are asked for there, in order.
 */
export const DictationSettings: Component = () => {
  // Permissions change in System Settings; look again on arrival and on return.
  onMount(() => {
    void refreshVoiceStatus()
    onCleanup(watchVoiceStatusOnFocus())
  })

  return (
    <Show when={voiceStatus()?.supported ? voiceStatus() : null}>
      {(status) => <Body status={status()} />}
    </Show>
  )
}

const Body: Component<{ status: VoiceStatus }> = (props) => {
  const [deletingId, setDeletingId] = createSignal<ModelId | null>(null)
  const modelById = (id: ModelId) => props.status.models.find(m => m.id === id)
  const deleting = () => {
    const id = deletingId()
    return id ? modelById(id) ?? null : null
  }
  // Rows keyed by model id, so a status event does not remount them (and drop focus).
  const modelIds = stableKeys(() => props.status.models.map(m => m.id))
  const languageCodes = stableKeys(() => props.status.languages.map(l => l.code))
  // Escape closes the question, not Settings behind it.
  useDismissable(() => deleting() !== null, () => setDeletingId(null))

  const installed = (code: Language) => props.status.languages.find(l => l.code === code)?.installed ?? false
  const setupDone = () => props.status.microphone === 'granted' && installed(props.status.language)

  const toggle = (on: boolean) => {
    if (!on) return void setDictationEnabled(false)
    if (setupDone()) void setDictationEnabled(true)
    else openDictationSetup({ reason: 'enable' })
  }

  const chooseLanguage = (select: HTMLSelectElement) => {
    const code = select.value as Language
    if (installed(code)) return void setDictationLanguage(code)
    // The language changes once its model is there; until then the select shows the current one.
    select.value = props.status.language
    openDictationSetup({ reason: 'language', language: code })
  }

  const remove = () => {
    const model = deleting()
    setDeletingId(null)
    if (model) void deleteDictationModel(model.id)
  }

  return (
    <>
      <section class="mb-8">
        <div class="flex items-center justify-between gap-4">
          <div>
            <div class="text-sm text-text-primary">Dictation</div>
            <div class="text-xs text-text-dim mt-0.5">Audio is transcribed on this Mac and never saved or sent anywhere.</div>
          </div>
          <Toggle label="Dictation" checked={props.status.enabled} onChange={toggle} />
        </div>

        <div class="space-y-4 mt-6">
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-sm text-text-primary">Language</div>
              <div class="text-xs text-text-dim mt-0.5">The language you speak. Each one needs its speech model.</div>
            </div>
            <select aria-label="Language" class={SELECT} value={props.status.language} onChange={(e) => chooseLanguage(e.currentTarget)}>
              <For each={languageCodes()}>
                {(code) => <option value={code}>{LANGUAGE_NAMES[code]}</option>}
              </For>
            </select>
          </div>

          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-sm text-text-primary">Hold key</div>
              <div class="text-xs text-text-dim mt-0.5">Hold it to talk, let go to insert the text.</div>
            </div>
            <select
              aria-label="Hold key"
              class={SELECT}
              value={props.status.holdKey}
              onChange={(e) => void setDictationHoldKey(e.currentTarget.value as HoldKey)}
            >
              <For each={HOLD_KEYS}>{(key) => <option value={key}>{holdKeyName(key)}</option>}</For>
            </select>
          </div>
          <FnConflictHint status={props.status} class="text-xs text-status-waiting -mt-2" />
        </div>
      </section>

      <section class="mb-8">
        <h2 id="dictation-permissions" class="section-title mb-3">Permissions</h2>
        <ul aria-labelledby="dictation-permissions" class="list-none m-0 p-0 space-y-2">
          <li class={ROW_CARD}>
            <div class="min-w-0">
              <div class="text-sm text-text-primary">Microphone</div>
              <div class="text-xs text-text-muted">
                {props.status.microphone === 'granted' ? 'Ready' : props.status.microphone === 'denied' ? MIC_DENIED_HELP : 'Not allowed yet'}
              </div>
            </div>
            <Show when={props.status.microphone === 'undetermined'}>
              <button type="button" class={SMALL_BUTTON} aria-label="Allow microphone" onClick={() => void requestMicrophone()}>Allow</button>
            </Show>
          </li>
          <li class={ROW_CARD}>
            <div class="min-w-0">
              <div class="text-sm text-text-primary">Hold key</div>
              <div class="text-xs text-text-muted">{props.status.accessibility ? 'Ready' : 'Needs Accessibility permission'}</div>
            </div>
            <Show when={!props.status.accessibility}>
              <button type="button" class={SMALL_BUTTON} onClick={openAccessibilitySettings}>Open System Settings</button>
            </Show>
          </li>
        </ul>
      </section>

      <section class="mb-8">
        <h2 id="dictation-models" class="section-title mb-3">Models</h2>
        <ul aria-labelledby="dictation-models" class="list-none m-0 p-0 space-y-2">
          <For each={modelIds()}>
            {(id) => (
              <Show when={modelById(id)}>
                {(model) => (
                  <li class={ROW_CARD}>
                    <div class="min-w-0 shrink-0">
                      <div class="text-sm text-text-primary">{model().displayName}</div>
                      <div class="text-xs text-text-muted">
                        <span>{formatDownloadSize(model().bytes)}</span> · <span>{model().installed ? 'Installed' : 'Not installed'}</span>
                      </div>
                    </div>
                    <Show
                      when={model().installed}
                      fallback={<div class="flex-1 min-w-0 flex justify-end"><ModelDownload model={model()} /></div>}
                    >
                      <button
                        type="button"
                        class="px-2.5 py-1 rounded-md text-xs text-text-muted hover:text-status-error hover:bg-status-error/10 transition-colors"
                        aria-label={`Delete ${model().displayName}`}
                        onClick={() => setDeletingId(id)}
                      >
                        Delete
                      </button>
                    </Show>
                  </li>
                )}
              </Show>
            )}
          </For>
        </ul>
      </section>

      <ConfirmDialog
        open={deleting() !== null}
        danger
        title={`Delete ${deleting()?.displayName}?`}
        message="Dictation needs it to work. You can download it again here."
        confirmLabel="Delete"
        onConfirm={remove}
        onCancel={() => setDeletingId(null)}
      />
    </>
  )
}
