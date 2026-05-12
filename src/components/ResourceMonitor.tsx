import { Component, createSignal } from 'solid-js'
import { ResourceChip } from './ResourceChip'
import { ResourceOverlay } from './ResourceOverlay'

/// Activity-monitor chip pinned to the window's top-right title-bar area,
/// with an overlay popover that opens downward, right-aligned to the chip.
export const ResourceMonitor: Component = () => {
  const [open, setOpen] = createSignal(false)
  const [anchor, setAnchor] = createSignal<{ x: number; y: number } | undefined>(undefined)

  return (
    <>
      <div class="fixed top-1 right-3 z-30 no-drag">
        <ResourceChip onClick={(el) => {
          const r = el.getBoundingClientRect()
          setAnchor({ x: r.right, y: r.bottom + 4 })
          setOpen(true)
        }} />
      </div>
      <ResourceOverlay
        open={open()}
        onClose={() => setOpen(false)}
        anchor={anchor()}
      />
    </>
  )
}
