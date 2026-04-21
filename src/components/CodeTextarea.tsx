import { Component, createEffect, onMount } from 'solid-js'
import { modPressed } from '../lib/platform'

interface Props {
  value: string
  onInput: (value: string) => void
  onSave?: () => void
  placeholder?: string
  minRows?: number
  maxRows?: number
}

/**
 * Auto-expanding textarea with shell-like styling.
 * Grows with content, monospace font, syntax-colored background.
 */
export const CodeTextarea: Component<Props> = (props) => {
  let textareaRef!: HTMLTextAreaElement

  const resize = () => {
    if (!textareaRef) return
    textareaRef.style.height = 'auto'
    const lineH = 20 // line-height ~20px
    const pad = 16   // vertical padding
    const minHeight = (props.minRows ?? 1) * lineH + pad
    const maxHeight = props.maxRows ? props.maxRows * lineH + pad : Infinity
    const clamped = Math.min(Math.max(textareaRef.scrollHeight, minHeight), maxHeight)
    textareaRef.style.height = `${clamped}px`
    textareaRef.style.overflowY = textareaRef.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }

  onMount(resize)
  createEffect(() => {
    // Track value changes to trigger resize
    void props.value
    resize()
  })

  return (
    <textarea
      ref={textareaRef}
      class="w-full px-3 py-2 rounded-lg bg-surface-1 ring-1 ring-outline/8 text-[13px] text-text-secondary placeholder:text-text-dim focus:outline-none focus:ring-accent/40 resize-none font-mono leading-5"
      placeholder={props.placeholder}
      value={props.value}
      onInput={(e) => {
        props.onInput(e.currentTarget.value)
        resize()
      }}
      onKeyDown={(e) => {
        if (modPressed(e) && e.key === 'Enter') {
          e.preventDefault()
          props.onSave?.()
        }
      }}
      rows={props.minRows ?? 1}
      spellcheck={false}
    />
  )
}
