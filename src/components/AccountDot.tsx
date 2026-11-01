import { Component, Show } from 'solid-js'
import { clsx } from 'clsx'
import { accountById } from '../store/accounts'

/** The size of the dot an account has in the pickers (`AgentRowName`: `w-2 h-2`). */
const DEFAULT_SIZE = 8

/**
 * Which account a session runs on: a dot in the account's color, named on hover
 * (`Acme · dev@acme.com`). Default (`null`) shows nothing, so a session looks as
 * it did before accounts existed.
 *
 * A session keeps its account after the account is removed, and then the dot is a
 * ring in the same color. An account the store does not know (yet) is a gray ring.
 */
export const AccountDot: Component<{ accountId: string | null; size?: number }> = (props) => {
  const account = () => accountById(props.accountId)
  const live = () => account()?.removedAt === null
  const title = () => {
    const a = account()
    if (!a) return 'Unknown account'
    if (a.removedAt !== null) return `${a.label} (removed)`
    return a.identity.email ? `${a.label} · ${a.identity.email}` : a.label
  }
  const px = () => `${props.size ?? DEFAULT_SIZE}px`

  return (
    <Show when={props.accountId}>
      <span
        role="img"
        title={title()}
        // A ring is drawn in the element's `color` and inside its box, so a hollow dot is as big as a filled one.
        class={clsx('inline-block rounded-full shrink-0', !live() && 'ring-1 ring-inset ring-current', !account() && 'text-text-muted')}
        style={{
          width: px(),
          height: px(),
          'background-color': live() ? account()?.color : undefined,
          color: live() ? undefined : account()?.color,
        }}
      />
    </Show>
  )
}
