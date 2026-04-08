import { Component, Show, createSignal } from 'solid-js'
import { Copy, Check } from 'lucide-solid'
import { Popover } from './Popover'

interface Props {
  pos: { x: number; y: number; text: string } | null
  onClose: () => void
}

export const SelectionMenu: Component<Props> = (props) => {
  const [copied, setCopied] = createSignal(false)

  const handleCopy = async () => {
    if (!props.pos) return
    await navigator.clipboard.writeText(props.pos.text)
    setCopied(true)
    setTimeout(() => {
      setCopied(false)
      props.onClose()
    }, 800)
  }

  return (
    <Popover open={!!props.pos} onClose={props.onClose} pos={props.pos || undefined}>
      <button
        class="flex items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-4 transition-colors rounded-lg"
        onClick={handleCopy}
      >
        <Show when={copied()} fallback={<><Copy size={13} /> Copy</>}>
          <Check size={13} class="text-status-running" /> Copied
        </Show>
      </button>
    </Popover>
  )
}
