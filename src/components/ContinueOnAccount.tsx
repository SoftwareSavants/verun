import { For, Show, createSignal, type Component } from 'solid-js'
import { ArrowRight, Loader2 } from 'lucide-solid'
import { clsx } from 'clsx'
import { otherAccountChoices } from '../lib/accounts'
import { failureText } from '../lib/accountErrors'
import { sessionById } from '../store/sessions'
import { taskById } from '../store/tasks'
import { addToast } from '../store/ui'
import { continueOnAccount } from '../store/fork'

/**
 * "Continue on <account>" for a session that hit its usage limit: forks the
 * whole session to that account and sends `message` there. Nothing renders
 * when there is no other account to go to.
 */
/** The accounts a session that ran out of usage can carry over to. */
export function continueChoices(sessionId: string) {
  const s = sessionById(sessionId)
  if (!s || s.agentType !== 'claude') return []
  return otherAccountChoices('claude', s.accountId, taskById(s.taskId)?.projectId)
}

export const ContinueOnAccount: Component<{
  sessionId: string
  /** What the fork is sent to pick up: the failed prompt, or "continue". */
  message: string
  /** `floating`: one pill per account, like the side question pill. */
  variant?: 'inline' | 'floating'
}> = (props) => {
  const [busy, setBusy] = createSignal<string | null>(null)
  const choices = () => continueChoices(props.sessionId)
  const go = async (key: string, target: { accountId: string | null }) => {
    setBusy(key)
    try {
      await continueOnAccount(props.sessionId, target, props.message, sessionById(props.sessionId)?.model ?? null)
    } catch (e) {
      addToast(failureText(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  return (
    <Show when={choices().length > 0}>
      <For each={choices()}>{choice => (
        <button
          class={clsx(
            'flex items-center gap-1.5 font-medium transition-colors disabled:opacity-50',
            props.variant === 'floating'
              ? 'h-7 px-2.5 rounded-full bg-surface-2 ring-1 ring-outline/10 shadow-lg text-[11px] text-text-secondary hover:text-text-primary hover:ring-outline/20'
              : 'px-2.5 py-1 rounded-md text-[11px] bg-surface-2 text-text-secondary hover:bg-surface-3',
          )}
          disabled={busy() !== null}
          aria-label={`Continue on ${choice.label}`}
          title={`Fork this session to ${choice.label} and keep going there`}
          onClick={() => void go(choice.key, choice.target)}
        >
          <Show when={busy() === choice.key} fallback={
            <span class="w-2 h-2 rounded-full shrink-0 ring-1 ring-outline/20" style={{ background: choice.color ?? 'transparent' }} />
          }>
            <Loader2 size={11} class="animate-spin" />
          </Show>
          Continue on {choice.label}
          <ArrowRight size={11} class="text-text-dim" />
        </button>
      )}</For>
    </Show>
  )
}
