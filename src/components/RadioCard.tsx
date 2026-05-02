import { For, Show, type JSX } from 'solid-js'

export interface RadioCardOption<V extends string> {
  value: V
  label: string
  /** Optional inline child rendered under the option when it is selected. */
  child?: JSX.Element
}

export interface RadioCardProps<V extends string> {
  title: string
  description?: string
  value: V
  options: ReadonlyArray<RadioCardOption<V>>
  onChange: (value: V) => void
}

export function RadioCard<V extends string>(props: RadioCardProps<V>) {
  return (
    <div class="ring-1 ring-border-subtle rounded-lg p-4 bg-surface-1">
      <h3 class="text-sm font-medium text-text-primary">{props.title}</h3>
      <Show when={props.description}>
        <p class="text-xs text-text-dim mt-1">{props.description}</p>
      </Show>
      <div class="mt-3 flex flex-col gap-2">
        <For each={props.options}>
          {(opt) => (
            <div>
              <label class="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  class="mt-0.5"
                  checked={props.value === opt.value}
                  onChange={() => props.onChange(opt.value)}
                />
                <span>{opt.label}</span>
              </label>
              <Show when={props.value === opt.value && opt.child}>
                <div class="ml-6 mt-2">{opt.child}</div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
