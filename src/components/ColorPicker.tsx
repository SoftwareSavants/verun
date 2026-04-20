import { Component, createMemo, createSignal, createEffect } from 'solid-js'

interface Props {
  value: string                    // hex like "#2d6e4f"
  onChange: (hex: string) => void
}

// HSV picker with a saturation/value square + hue slider + hex input.
// HSV (not HSL) because the SV square is the standard color-picker affordance
// users recognize from Figma/Photoshop/macOS.
export const ColorPicker: Component<Props> = (props) => {
  // Local edit state for the hex text input - keeps invalid drafts from
  // round-tripping through onChange while the user is mid-typing.
  const [hexDraft, setHexDraft] = createSignal(normalizeHex(props.value))
  createEffect(() => setHexDraft(normalizeHex(props.value)))

  const hsv = createMemo(() => hexToHsv(props.value))

  const setHsv = (next: Partial<{ h: number; s: number; v: number }>) => {
    const merged = { ...hsv(), ...next }
    props.onChange(hsvToHex(merged))
  }

  // Drag handlers — pointer capture means we keep getting move events
  // even if the cursor leaves the element.
  const startDrag = (
    el: HTMLElement,
    e: PointerEvent,
    onMove: (xRatio: number, yRatio: number) => void,
  ) => {
    el.setPointerCapture(e.pointerId)
    const rect = el.getBoundingClientRect()
    const apply = (clientX: number, clientY: number) => {
      const x = clamp01((clientX - rect.left) / rect.width)
      const y = clamp01((clientY - rect.top) / rect.height)
      onMove(x, y)
    }
    apply(e.clientX, e.clientY)
    const move = (ev: PointerEvent) => apply(ev.clientX, ev.clientY)
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div class="flex flex-col gap-3 select-none">
      {/* Saturation × Value square */}
      <div
        class="relative w-full h-36 rounded-md ring-1 ring-outline/12 cursor-crosshair touch-none"
        style={{
          background: `
            linear-gradient(to top, #000, transparent),
            linear-gradient(to right, #fff, hsl(${hsv().h}, 100%, 50%))
          `,
        }}
        onPointerDown={(e) => startDrag(e.currentTarget, e, (x, y) => setHsv({ s: x, v: 1 - y }))}
      >
        <div
          class="absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full ring-2 ring-white shadow-md pointer-events-none"
          style={{
            left: `${hsv().s * 100}%`,
            top: `${(1 - hsv().v) * 100}%`,
            background: props.value,
          }}
        />
      </div>

      {/* Hue slider */}
      <div
        class="relative w-full h-3 rounded-full ring-1 ring-outline/12 cursor-pointer touch-none"
        style={{
          background:
            'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
        }}
        onPointerDown={(e) => startDrag(e.currentTarget, e, (x) => setHsv({ h: x * 360 }))}
      >
        <div
          class="absolute top-1/2 -translate-y-1/2 -ml-1.5 w-3 h-5 rounded-sm ring-2 ring-white shadow-md pointer-events-none"
          style={{
            left: `${(hsv().h / 360) * 100}%`,
            background: `hsl(${hsv().h}, 100%, 50%)`,
          }}
        />
      </div>

      {/* Hex input + swatch */}
      <div class="flex items-center gap-2">
        <div
          class="w-7 h-7 rounded-md ring-1 ring-outline/12 shrink-0"
          style={{ background: props.value }}
        />
        <input
          type="text"
          class="flex-1 bg-surface-1 ring-1 ring-outline/8 rounded-md px-2 py-1.5 text-xs font-mono text-text-primary outline-none focus:ring-accent/40 transition-shadow"
          value={hexDraft()}
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          // Paste handler: normalize whatever the user dropped in (with or
          // without #, with whitespace, mixed case) into "#xxxxxx" so the
          // visible value never has a stray prefix or trailing junk.
          onPaste={(e) => {
            const raw = e.clipboardData?.getData('text') ?? ''
            const cleaned = '#' + raw.replace(/[^0-9a-fA-F]/g, '').slice(0, 6).toLowerCase()
            if (cleaned.length >= 4) {
              e.preventDefault()
              setHexDraft(cleaned)
              if (cleaned.length === 7 || cleaned.length === 4) {
                props.onChange(normalizeHex(cleaned))
              }
            }
          }}
          onInput={(e) => {
            // Live typing — strip non-hex chars, ensure exactly one leading #,
            // cap at 7 chars (#xxxxxx).
            const v = e.currentTarget.value
            const hex = v.replace(/[^0-9a-fA-F]/g, '').slice(0, 6)
            const next = '#' + hex
            // Update visible input (in case we stripped something).
            if (next !== v) e.currentTarget.value = next
            setHexDraft(next)
            if (hex.length === 6 || hex.length === 3) {
              props.onChange(normalizeHex(next))
            }
          }}
          // On blur, snap the visible draft to the canonical 6-char form so
          // partially-typed values don't linger.
          onBlur={() => setHexDraft(normalizeHex(props.value))}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Color math (kept local — theme.ts uses HSL; the picker uses HSV)
// ---------------------------------------------------------------------------

function clamp01(n: number) { return Math.max(0, Math.min(1, n)) }

function expandHex(hex: string): string {
  const h = hex.replace(/^#/, '').toLowerCase()
  if (h.length === 3) return h.split('').map(c => c + c).join('')
  return h.padEnd(6, '0').slice(0, 6)
}

function normalizeHex(hex: string): string {
  return '#' + expandHex(hex)
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const h = expandHex(hex)
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const v = max
  const s = max === 0 ? 0 : d / max
  let hue = 0
  if (d !== 0) {
    switch (max) {
      case r: hue = ((g - b) / d) % 6; break
      case g: hue = (b - r) / d + 2; break
      case b: hue = (r - g) / d + 4; break
    }
    hue *= 60
    if (hue < 0) hue += 360
  }
  return { h: hue, s, v }
}

function hsvToHex({ h, s, v }: { h: number; s: number; v: number }): string {
  const c = v * s
  const hh = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  let r = 0, g = 0, b = 0
  if (hh < 1)      [r, g, b] = [c, x, 0]
  else if (hh < 2) [r, g, b] = [x, c, 0]
  else if (hh < 3) [r, g, b] = [0, c, x]
  else if (hh < 4) [r, g, b] = [0, x, c]
  else if (hh < 5) [r, g, b] = [x, 0, c]
  else             [r, g, b] = [c, 0, x]
  const m = v - c
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}
