import { Component, createSignal, createEffect } from 'solid-js'
import { Minus, Plus } from 'lucide-solid'

interface Props {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
}

export const QuantityStepper: Component<Props> = (props) => {
  const step = () => props.step ?? 1
  const [text, setText] = createSignal(String(props.value))

  createEffect(() => {
    setText(String(props.value))
  })

  const clamp = (v: number) => Math.max(props.min, Math.min(props.max, v))

  const dec = () => {
    if (props.value > props.min) props.onChange(clamp(props.value - step()))
  }
  const inc = () => {
    if (props.value < props.max) props.onChange(clamp(props.value + step()))
  }

  const commit = () => {
    const n = Number(text())
    if (Number.isFinite(n)) {
      const clamped = clamp(Math.round(n))
      if (clamped !== props.value) props.onChange(clamped)
      setText(String(clamped))
    } else {
      setText(String(props.value))
    }
  }

  return (
    <div class="inline-flex items-center bg-surface-2 ring-1 ring-outline/8 rounded-lg overflow-hidden">
      <button
        class="px-2 py-1.5 text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
        onClick={dec}
        disabled={props.value <= props.min}
        title="Decrease"
      >
        <Minus size={12} />
      </button>
      <input
        type="number"
        class="w-10 text-center bg-transparent text-sm text-text-primary outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={text()}
        min={props.min}
        max={props.max}
        step={step()}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        }}
      />
      <button
        class="px-2 py-1.5 text-text-dim hover:text-text-secondary hover:bg-surface-3 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
        onClick={inc}
        disabled={props.value >= props.max}
        title="Increase"
      >
        <Plus size={12} />
      </button>
    </div>
  )
}
