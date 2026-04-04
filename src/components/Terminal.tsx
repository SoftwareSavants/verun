import { Component, onMount, onCleanup, createEffect } from 'solid-js'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface Props {
  output: string[]
}

export const Terminal: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement
  let term: XTerm
  let fitAddon: FitAddon
  let writeBuffer: string[] = []
  let rafId: number | null = null

  const flushBuffer = () => {
    if (writeBuffer.length > 0 && term) {
      term.write(writeBuffer.join(''))
      writeBuffer = []
    }
    rafId = null
  }

  const batchWrite = (data: string) => {
    writeBuffer.push(data)
    if (rafId === null) {
      rafId = requestAnimationFrame(flushBuffer)
    }
  }

  onMount(() => {
    term = new XTerm({
      theme: {
        background: '#0a0a0a',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5',
        selectionBackground: '#6366f140',
      },
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: false,
      disableStdin: true,
      scrollback: 10000,
    })

    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())

    term.open(containerRef)
    fitAddon.fit()

    const resizeObserver = new ResizeObserver(() => fitAddon.fit())
    resizeObserver.observe(containerRef)

    onCleanup(() => {
      resizeObserver.disconnect()
      if (rafId !== null) cancelAnimationFrame(rafId)
      term.dispose()
    })
  })

  // React to new output lines
  createEffect(() => {
    const lines = props.output
    if (lines.length > 0) {
      const latest = lines[lines.length - 1]
      batchWrite(latest + '\r\n')
    }
  })

  return (
    <div
      ref={containerRef}
      class="w-full h-full"
    />
  )
}
