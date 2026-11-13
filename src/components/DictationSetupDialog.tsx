import { Component, For, Match, Show, Switch, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import { Dialog } from './Dialog'
import { DownloadProgress, MIC_DENIED_HELP, ModelDownload, downloadPhase, focusOnMount, stableKeys } from './DictationParts'
import {
  voiceStatus, dictationSetupRequest, clearDictationSetupRequest, refreshVoiceStatus, requestMicrophone,
  chooseDictationLanguage, pendingDictationLanguage, setDictationEnabled, openAccessibilitySettings,
  watchVoiceStatusOnFocus, type DictationSetupRequest,
} from '../store/voice'
import { LANGUAGE_NAMES } from '../lib/voiceLanguages'
import { holdKeyName } from '../lib/holdKeyName'
import { formatDownloadSize } from '../lib/format'
import { useDismissable } from '../lib/dismissable'
import type { Language, VoiceStatus } from '../types/voice'

type Step = 'microphone' | 'language' | 'download' | 'accessibility' | 'done'

/**
 * The way into dictation: microphone, language, model download, Accessibility
 * for the hold key, then on. Mounted once per window; opens on
 * `openDictationSetup` (the mic button while dictation is off, a missing model,
 * Settings, "Add language...").
 */
export const DictationSetupDialog: Component = () => (
  <Show when={dictationSetupRequest()} keyed>
    {(request) => (
      <Show when={voiceStatus()?.supported ? voiceStatus() : null}>
        {(status) => <Wizard status={status()} request={request} />}
      </Show>
    )}
  </Show>
)

const close = () => clearDictationSetupRequest()

const Wizard: Component<{ status: VoiceStatus; request: DictationSetupRequest }> = (props) => {
  // Fixed for the dialog's lifetime (it is keyed on the request).
  const reason = props.request.reason
  /** Only turning it on (or getting a missing model back) switches dictation on; a language change never does. */
  const turnsOn = reason === 'enable' || reason === 'model-missing'
  const languageKnown = reason === 'model-missing' || reason === 'language'

  // Only what the user has decided here; everything else is read from the live status.
  const [chosen, setChosen] = createSignal<Language | null>(null)
  const [languageConfirmed, setLanguageConfirmed] = createSignal(false)
  const [skippedAccessibility, setSkippedAccessibility] = createSignal(false)
  const [finishing, setFinishing] = createSignal(false)

  const language = () => chosen() ?? props.request.language ?? pendingDictationLanguage() ?? props.status.language
  const languageStatus = (code: Language) => props.status.languages.find(l => l.code === code)
  const installed = (code: Language) => languageStatus(code)?.installed ?? false
  const model = () => props.status.models.find(m => m.id === languageStatus(language())?.model) ?? null
  const codes = stableKeys(() => props.status.languages.map(l => l.code))

  // The language is known from why setup opened, or from a download in play for
  // it: setup reopened mid-download shows the download. A failed one does so only
  // when turning dictation on; adding a language still offers the list.
  const languageDecided = () => {
    if (languageConfirmed() || languageKnown) return true
    const m = model()
    if (m === null) return false
    const phase = downloadPhase(m)
    return phase === 'running' || phase === 'finishing' || (phase === 'failed' && turnsOn)
  }

  // The microphone step shows for every reason (a language download is useless
  // without a microphone); the Accessibility step only when turning dictation on.
  const step = (): Step => {
    const s = props.status
    if (s.microphone !== 'granted') return 'microphone'
    if (!languageDecided()) return 'language'
    if (!installed(language())) return 'download'
    if (turnsOn && !s.accessibility && !skippedAccessibility()) return 'accessibility'
    return 'done'
  }

  // Escape closes the dialog, not Settings behind it.
  useDismissable(() => true, close)

  // Permissions change in System Settings; look again when the user comes back.
  onMount(() => onCleanup(watchVoiceStatusOnFocus()))

  // The choice is set once its model is installed (now, or when the download completes).
  const confirmLanguage = async () => {
    await chooseDictationLanguage(language())
    setLanguageConfirmed(true)
  }

  const finish = async () => {
    setFinishing(true)
    if (language() !== props.status.language && pendingDictationLanguage() !== language()) {
      await chooseDictationLanguage(language())
    }
    if (turnsOn && !props.status.enabled) await setDictationEnabled(true)
    close()
  }

  const downloading = () => {
    const m = model()
    return m !== null && downloadPhase(m) === 'running'
  }

  return (
    <Dialog open onClose={close} width="26rem">
      <h2 class="text-base font-semibold text-text-primary mb-2">Set up dictation</h2>
      <Switch>
        <Match when={step() === 'microphone'}>
          <Show
            when={props.status.microphone === 'denied'}
            fallback={
              <>
                <p class="text-sm text-text-muted mb-4">Verun needs your microphone to hear what you say. Audio stays on this Mac.</p>
                <Footer>
                  <button type="button" class="btn-primary" ref={focusOnMount} onClick={() => void requestMicrophone()}>Allow microphone</button>
                </Footer>
              </>
            }
          >
            <p class="text-sm text-text-muted mb-4">{MIC_DENIED_HELP}</p>
            <Footer>
              <button type="button" class="btn-primary" ref={focusOnMount} onClick={() => void refreshVoiceStatus()}>Check again</button>
            </Footer>
          </Show>
        </Match>

        <Match when={step() === 'language'}>
          <p class="text-sm text-text-muted mb-3">Which language will you speak?</p>
          <div role="radiogroup" aria-label="Language" class="grid grid-cols-2 gap-1 mb-4">
            <For each={codes()}>
              {(code) => (
                <label class="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-text-secondary hover:bg-surface-3 cursor-pointer">
                  <input
                    type="radio"
                    name="dictation-language"
                    value={code}
                    checked={language() === code}
                    onChange={() => setChosen(code)}
                  />
                  <span class="flex-1 min-w-0 truncate">{LANGUAGE_NAMES[code]}</span>
                  <Show when={installed(code)}><span class="text-[11px] text-text-dim">Ready</span></Show>
                </label>
              )}
            </For>
          </div>
          <Footer>
            <button type="button" class="btn-primary" ref={focusOnMount} onClick={() => void confirmLanguage()}>Continue</button>
          </Footer>
        </Match>

        <Match when={step() === 'download' && model()}>
          {(m) => (
            <>
              <p class="text-sm text-text-muted mb-4">
                {LANGUAGE_NAMES[language()]} needs the {m().displayName} speech model ({formatDownloadSize(m().bytes)}).
                It is downloaded once and runs on this Mac.
              </p>
              <div class="flex items-center gap-3 mb-2">
                <Show when={downloadPhase(m()) !== 'finishing'} fallback={<DownloadProgress model={m()} />}>
                  <ModelDownload model={m()} focus onStart={() => void chooseDictationLanguage(language())} />
                </Show>
              </div>
              <Show when={downloading()}>
                <p class="text-xs text-text-dim mb-2">The download continues in the background.</p>
              </Show>
              <Footer />
            </>
          )}
        </Match>

        <Match when={step() === 'download' && !model()}>
          <p class="text-sm text-text-muted mb-4">No speech model is available for {LANGUAGE_NAMES[language()]}.</p>
          <Footer />
        </Match>

        <Match when={step() === 'accessibility'}>
          <p class="text-sm text-text-muted mb-4">
            Holding {holdKeyName(props.status.holdKey)} to talk needs Accessibility permission. Turn on Verun in
            System Settings &gt; Privacy &amp; Security &gt; Accessibility.
          </p>
          <div class="flex flex-wrap justify-end gap-2">
            <button type="button" class="btn-ghost" onClick={() => setSkippedAccessibility(true)}>Skip, use the button only</button>
            <button type="button" class="btn-ghost" onClick={() => void refreshVoiceStatus()}>Check again</button>
            <button type="button" class="btn-primary" ref={focusOnMount} onClick={openAccessibilitySettings}>Open System Settings</button>
          </div>
        </Match>

        <Match when={step() === 'done'}>
          <Show
            when={turnsOn}
            fallback={
              <>
                <p class="text-sm text-text-primary mb-1">{LANGUAGE_NAMES[language()]} is ready.</p>
                <p class="text-sm text-text-muted mb-4">
                  {props.status.enabled
                    ? `Dictation will use ${LANGUAGE_NAMES[language()]}.`
                    : `Dictation will use ${LANGUAGE_NAMES[language()]} once you turn it on in Settings.`}
                </p>
              </>
            }
          >
            <p class="text-sm text-text-primary mb-1">Dictation is ready.</p>
            <p class="text-sm text-text-muted mb-4">
              <Show
                when={props.status.accessibility}
                fallback={'The mic button works now. The hold key will start working once Verun has Accessibility permission in System Settings.'}
              >
                Hold {holdKeyName(props.status.holdKey)} to talk, or click the mic button.
              </Show>
            </p>
          </Show>
          <div class="flex justify-end">
            <button type="button" class="btn-primary" ref={focusOnMount} disabled={finishing()} onClick={() => void finish()}>Done</button>
          </div>
        </Match>
      </Switch>
    </Dialog>
  )
}

/** Cancel (Close when the step has no action of its own), then the step's primary action. */
const Footer: Component<{ children?: JSX.Element }> = (props) => (
  <div class="flex justify-end gap-2">
    <button type="button" class="btn-ghost" onClick={close}>{props.children ? 'Cancel' : 'Close'}</button>
    {props.children}
  </div>
)
