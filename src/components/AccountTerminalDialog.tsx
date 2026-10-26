import { Component, Match, Show, Switch, createSignal, onCleanup, onMount } from 'solid-js'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Dialog } from './Dialog'
import { ShellTerminal } from './ShellTerminal'
import * as ipc from '../lib/ipc'
import { keepTerminalAfterExit, releaseKeptTerminal } from '../store/terminals'
import { failureText } from '../lib/accountErrors'
import type { Account, AccountTerminal, AccountTerminalAction, PtyExitedEvent } from '../types'

interface Props {
  account: Account
  action: AccountTerminalAction
  onClose: () => void
}

/** A browser login signs in whichever account the browser is already using. */
const BROWSER_NOTE = 'Your browser signs in with whichever account it is already using. If that is the wrong one, copy the link from the terminal into the right browser profile.'

/**
 * Runs the harness's own login or logout command for an account in a terminal.
 * The backend sends `accounts-changed` when the command ends, so the list behind
 * this dialog shows the new identity without help from here.
 *
 * The terminal belongs to the dialog and stays after the command has ended, so
 * what it printed (why a login failed) can be read until the dialog is
 * dismissed. The terminal store would dispose its xterm at the exit, so the
 * dialog opts it out and disposes it itself. The PTY goes the same way: it is
 * closed with the dialog, whether the command is still running or has ended
 * (an ended PTY stays in the backend until closed).
 */
export const AccountTerminalDialog: Component<Props> = (props) => {
  const [terminal, setTerminal] = createSignal<AccountTerminal | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  // Exit code of every terminal seen to end while this dialog is open. Our
  // terminal's id is only known once the start call returns, and a command that
  // fails at once can end before that.
  const [exits, setExits] = createSignal<Record<string, number | null>>({})
  let closed = false
  let released = false
  let unlisten: UnlistenFn | undefined
  let terminalBox!: HTMLDivElement

  const exited = () => {
    const started = terminal()
    return started !== null && started.terminalId in exits()
  }

  const endedText = () => {
    const code = exits()[terminal()?.terminalId ?? '']
    return code ? `The command ended with exit code ${code}.` : 'The command has ended.'
  }

  const closePty = (terminalId: string) => {
    ipc.ptyClose(terminalId).catch((e) => console.error('Failed to close the account terminal:', e))
  }

  /** Closes our PTY and disposes its xterm, once, whichever way the dialog goes away. */
  const releaseTerminal = () => {
    const started = terminal()
    if (!started || released) return
    released = true
    closePty(started.terminalId)
    releaseKeptTerminal(started.terminalId)
  }

  const close = () => {
    closed = true
    releaseTerminal()
    props.onClose()
  }

  async function start() {
    try {
      // Listen first: the exit event must not be missed, and it can arrive
      // before the call that starts the terminal returns.
      const stop = await listen<PtyExitedEvent>('pty-exited', (event) => {
        const { terminalId, exitCode } = event.payload
        setExits((prev) => ({ ...prev, [terminalId]: exitCode ?? null }))
      })
      if (closed) {
        stop()
        return
      }
      unlisten = stop
      const started = await ipc.startAccountTerminal(props.account.id, props.action, 24, 80)
      if (closed) {
        // Closed while it was starting: nobody is left to look at the terminal.
        closePty(started.terminalId)
        return
      }
      // From the moment its id is known, before the terminal is mounted: an exit
      // before this found no xterm to dispose, and the one made on mounting is ours.
      keepTerminalAfterExit(started.terminalId)
      setTerminal(started)
    } catch (e) {
      // Another login being open is the one to expect. The toast says how to fix
      // it, and the sentence stays here for after the toast is gone.
      if (!closed) setError(failureText(e))
    }
  }

  onMount(() => { void start() })

  // Escape closes this, not the page behind it (Settings closes on it too). That
  // is why it is heard ahead of everything else, and so also ahead of the
  // terminal: typed into a running command it is the command's, which may be
  // showing a prompt that takes it. Once the command has ended it is nobody's.
  const closeOnEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (!exited() && e.target instanceof Node && terminalBox.contains(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    close()
  }
  window.addEventListener('keydown', closeOnEscape, true)

  onCleanup(() => {
    window.removeEventListener('keydown', closeOnEscape, true)
    closed = true
    unlisten?.()
    releaseTerminal()
  })

  return (
    <Dialog open onClose={close} width="44rem">
      <h2 class="text-base font-semibold text-text-primary mb-2">
        {props.action === 'login' ? `Log in to ${props.account.label}` : `Log out of ${props.account.label}`}
      </h2>
      <Show when={props.action === 'login'}>
        <p class="text-xs text-text-dim mb-2">{BROWSER_NOTE}</p>
      </Show>
      <Show when={terminal()?.hint}>
        {(hint) => <p class="text-xs text-text-muted mb-2">{hint()}</p>}
      </Show>

      <div ref={terminalBox} class="h-72 mt-3 mb-4 rounded-lg overflow-hidden ring-1 ring-outline/8 bg-surface-0">
        <Switch fallback={<div class="p-4 text-sm text-text-dim">Starting...</div>}>
          <Match when={error()}>
            {(message) => <div class="p-4 text-sm text-status-error">{message()}</div>}
          </Match>
          <Match when={terminal()}>
            {(started) => (
              <div class="h-full p-2">
                {/* Nothing typed reaches a command that has ended. */}
                <ShellTerminal terminalId={started().terminalId} isStopped={exited} />
              </div>
            )}
          </Match>
        </Switch>
      </div>

      <div class="flex items-center justify-end gap-3">
        <Show when={exited()}>
          <span class="mr-auto text-xs text-text-muted">{endedText()}</span>
        </Show>
        <button class={exited() ? 'btn-primary' : 'btn-ghost'} onClick={close}>
          {exited() ? 'Done' : error() ? 'Close' : 'Cancel'}
        </button>
      </div>
    </Dialog>
  )
}
