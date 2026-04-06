import { Component, onMount, onCleanup, createEffect, on, createSignal, Show } from 'solid-js'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import type { OutputItem } from '../types'

// ANSI escape helpers
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const ITALIC = '\x1b[3m'
const CYAN = '\x1b[36m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const GRAY = '\x1b[90m'

/** Convert a structured OutputItem to ANSI-formatted text for xterm.js */
function formatItem(item: OutputItem): string {
  switch (item.kind) {
    case 'text':
      return item.text

    case 'thinking':
      return `${DIM}${ITALIC}${item.text}${RESET}`

    case 'toolStart': {
      const header = `${CYAN}${BOLD}  ${item.tool}${RESET}`
      if (item.input) {
        // Show first line of input, truncated
        const firstLine = item.input.split('\n')[0].slice(0, 200)
        return `\r\n${header} ${DIM}${firstLine}${RESET}\r\n`
      }
      return `\r\n${header}\r\n`
    }

    case 'toolResult': {
      const color = item.isError ? RED : DIM
      // Indent tool output and cap at reasonable length
      const lines = item.text.split('\n').slice(0, 50)
      const formatted = lines.map(l => `${color}  ${l}${RESET}`).join('\r\n')
      return `${formatted}\r\n`
    }

    case 'system':
      return `\r\n${GRAY}${DIM}${item.text}${RESET}\r\n`

    case 'turnEnd':
      if (item.status === 'completed') {
        return `\r\n${GREEN}${DIM} Turn completed${RESET}\r\n`
      }
      return `\r\n${RED}${DIM} Turn ended: ${item.status}${RESET}\r\n`

    case 'raw':
      return `${DIM}${item.text}${RESET}\r\n`

    default:
      return ''
  }
}

interface Props {
  output: OutputItem[]
}

export const Terminal: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement
  let searchInputRef!: HTMLInputElement
  let term: XTerm
  let fitAddon: FitAddon
  let searchAddon: SearchAddon
  let writeBuffer: string[] = []
  let rafId: number | null = null
  let lastWrittenIndex = 0

  const [showSearch, setShowSearch] = createSignal(false)
  const [isAtBottom, setIsAtBottom] = createSignal(true)

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

  const scrollToBottom = () => {
    if (term) {
      term.scrollToBottom()
    }
  }

  const toggleSearch = () => {
    const next = !showSearch()
    setShowSearch(next)
    if (next) {
      requestAnimationFrame(() => searchInputRef?.focus())
    } else {
      searchAddon?.clearDecorations()
    }
  }

  const handleSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setShowSearch(false)
      searchAddon?.clearDecorations()
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        searchAddon?.findPrevious((e.target as HTMLInputElement).value)
      } else {
        searchAddon?.findNext((e.target as HTMLInputElement).value)
      }
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
      scrollback: 50000,
      allowProposedApi: true,
    })

    fitAddon = new FitAddon()
    searchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.loadAddon(searchAddon)

    term.open(containerRef)
    fitAddon.fit()

    // Track scroll position for "scroll to bottom" button
    term.onScroll(() => {
      const buffer = term.buffer.active
      const atBottom = buffer.viewportY >= buffer.baseY
      setIsAtBottom(atBottom)
    })

    // Ctrl+F / Cmd+F to search
    const handleKeyboard = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        toggleSearch()
      }
    }
    containerRef.addEventListener('keydown', handleKeyboard)

    const resizeObserver = new ResizeObserver(() => fitAddon.fit())
    resizeObserver.observe(containerRef)

    onCleanup(() => {
      containerRef.removeEventListener('keydown', handleKeyboard)
      resizeObserver.disconnect()
      if (rafId !== null) cancelAnimationFrame(rafId)
      term.dispose()
    })
  })

  // Write new output items incrementally
  createEffect(on(() => props.output.length, (len) => {
    if (!term || len === 0) {
      lastWrittenIndex = 0
      return
    }

    // If output was replaced (e.g. session switch), rewrite everything
    if (lastWrittenIndex > len) {
      term.clear()
      lastWrittenIndex = 0
    }

    for (let i = lastWrittenIndex; i < len; i++) {
      const formatted = formatItem(props.output[i])
      if (formatted) {
        batchWrite(formatted)
      }
    }
    lastWrittenIndex = len
  }))

  return (
    <div class="w-full h-full relative" tabIndex={0}>
      {/* Search bar */}
      <Show when={showSearch()}>
        <div class="absolute top-2 right-2 z-10 flex items-center gap-1 bg-surface-2 border border-border rounded px-2 py-1">
          <input
            ref={searchInputRef}
            class="bg-transparent text-sm text-gray-200 outline-none w-48 placeholder-gray-500"
            placeholder="Search..."
            onKeyDown={handleSearchKeyDown}
            onInput={(e) => searchAddon?.findNext(e.currentTarget.value)}
          />
          <button
            class="text-gray-500 hover:text-gray-300 text-xs px-1"
            onClick={() => { setShowSearch(false); searchAddon?.clearDecorations() }}
          >
            Esc
          </button>
        </div>
      </Show>

      {/* Scroll to bottom button */}
      <Show when={!isAtBottom()}>
        <button
          class="absolute bottom-3 right-3 z-10 bg-surface-2 border border-border rounded-full px-3 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
          onClick={scrollToBottom}
        >
          ↓ Bottom
        </button>
      </Show>

      <div ref={containerRef} class="w-full h-full" />
    </div>
  )
}
