import { Component } from 'solid-js'

interface Props {
  checked: boolean
  onChange: (checked: boolean) => void
}

export const Toggle: Component<Props> = (props) => {
  return (
    <button
      class="w-9 h-5 rounded-full transition-colors relative"
      classList={{ 'bg-accent': props.checked, 'bg-surface-3': !props.checked }}
      onClick={() => props.onChange(!props.checked)}
    >
      <div
        class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
        classList={{ 'translate-x-4': props.checked, 'translate-x-0.5': !props.checked }}
      />
    </button>
  )
}
