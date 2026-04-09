import { Component, createEffect, onMount } from 'solid-js'
import { modPressed } from '../lib/platform'

interface Props {
  value: string
  onInput: (value: string) => void
  onSave?: () => void
  placeholder?: string
  minRows?: number
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
    const minHeight = (props.minRows ?? 1) * 20 + 16 // line-height ~20px + padding
    textareaRef.style.height = `${Math.max(textareaRef.scrollHeight, minHeight)}px`
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
      class="w-full px-3 py-2 rounded-lg bg-[#0d1117] border border-[#30363d] text-[13px] text-[#c9d1d9] placeholder:text-[#484f58] focus:outline-none focus:border-[#58a6ff] resize-none font-mono leading-5 overflow-hidden"
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
