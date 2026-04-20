import { Component, onMount, onCleanup, createSignal, Show, type Accessor } from 'solid-js'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { registerXterm, getXtermEntry } from '../store/terminals'
import type { XtermEntry } from '../store/terminals'
import * as ipc from '../lib/ipc'
import { isMac, modPressed } from '../lib/platform'
import { getXtermTheme, getXtermFontConfig, subscribeXtermToAppearance } from '../lib/terminalTheme'
import '@xterm/xterm/css/xterm.css'

/** Capture-phase keydown on the container — fires before xterm's textarea gets it */
function setupCaptureKeyHandler(container: HTMLElement, term: XTerm, terminalId: string, isStopped?: Accessor<boolean>, onToggleSearch?: () => void) {
  container.addEventListener('keydown', (e: KeyboardEvent) => {
    const mod = modPressed(e)
    const inInput = (e.target as HTMLElement).tagName === 'INPUT'

    if (mod && e.key === 'f') {
      e.preventDefault()
      e.stopImmediatePropagation()
      onToggleSearch?.()
      return
    }
    // Let standard text-editing shortcuts pass through to input elements
    if (inInput) return

    if (mod && e.key === 'c') {
      e.preventDefault()
      e.stopImmediatePropagation()
      const selection = term.getSelection()
      if (selection) navigator.clipboard.writeText(selection)
      return
    }
    if (mod && e.key === 'a') { e.preventDefault(); term.selectAll(); return }
    if (mod && e.key === 'k') { e.preventDefault(); term.clear(); return }
    if (mod && e.key === 'ArrowUp') { e.preventDefault(); term.scrollToTop(); return }
    if (mod && e.key === 'ArrowDown') { e.preventDefault(); term.scrollToBottom(); return }
    // Block PTY writes when stopped
    if (isStopped?.()) return
    if (mod && e.key === 'v') {
      e.preventDefault()
      e.stopImmediatePropagation()
      ipc.readClipboard().then(text => { if (text) term.paste(text) })
      return
    }
    if (mod && e.key === 'ArrowLeft') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x01'); return }
    if (mod && e.key === 'ArrowRight') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x05'); return }
    if (mod && e.key === 'Backspace') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x15'); return }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x1bb'); return }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x1bf'); return }
    if (e.altKey && e.key === 'Backspace') { e.preventDefault(); ipc.ptyWrite(terminalId, '\x17'); return }
  }, true)
}

function setupXtermPassthrough(term: XTerm) {
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true
    if (e.ctrlKey && (e.key === '`' || e.key === '~' || e.key === 'Tab')) return false
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') return false
    if (modPressed(e)) return false
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Backspace')) return false
    return true
  })
}

function attachResizeObserver(container: HTMLElement, entry: XtermEntry, terminalId: string): ResizeObserver {
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const observer = new ResizeObserver(() => {
    if (container.clientWidth < 10 || container.clientHeight < 10) return
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      entry.fitAddon.fit()
      ipc.ptyResize(terminalId, entry.term.rows, entry.term.cols)
    }, 100)
  })
  observer.observe(container)
  return observer
}

function initialFit(entry: XtermEntry, terminalId: string) {
  requestAnimationFrame(() => {
    entry.fitAddon.fit()
    entry.term.refresh(0, entry.term.rows - 1)
    ipc.ptyResize(terminalId, entry.term.rows, entry.term.cols)
    entry.term.focus()
  })
}

interface Props {
  terminalId: string
  /** Reactive accessor — when true, keyboard input to the PTY is blocked (scrolling still works) */
  isStopped?: Accessor<boolean>
}

const SEARCH_DECORATIONS = {
  matchBorder: '#2d6e4f',
  matchOverviewRuler: '#2d6e4f',
  activeMatchBackground: '#2d6e4f',
  activeMatchBorder: '#3a8562',
  activeMatchColorOverviewRuler: '#3a8562',
}

export const ShellTerminal: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement
  let terminalRef: HTMLDivElement | undefined
  let searchInputRef: HTMLInputElement | undefined
  let resizeObserver: ResizeObserver | undefined
  let searchAddonRef: SearchAddon | undefined
  let resultsDisposable: { dispose(): void } | undefined
  let unsubAppearance: (() => void) | undefined

  const [showSearch, setShowSearch] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal('')
  const [resultIndex, setResultIndex] = createSignal(-1)
  const [resultCount, setResultCount] = createSignal(0)

  const searchOpts = { decorations: SEARCH_DECORATIONS }

  const closeSearch = () => {
    setShowSearch(false)
    setSearchQuery('')
    setResultIndex(-1)
    setResultCount(0)
    searchAddonRef?.clearDecorations()
    getXtermEntry(props.terminalId)?.term.focus()
  }

  const toggleSearch = () => {
    if (showSearch()) {
      closeSearch()
    } else {
      setShowSearch(true)
      requestAnimationFrame(() => {
        searchInputRef?.focus()
        searchInputRef?.select()
      })
    }
  }

  const findNext = () => {
    const val = searchInputRef?.value
    if (val) searchAddonRef?.findNext(val, searchOpts)
  }

  const findPrev = () => {
    const val = searchInputRef?.value
    if (val) searchAddonRef?.findPrevious(val, searchOpts)
  }

  const handleSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeSearch()
    } else if (e.key === 'Enter') {
      if (e.shiftKey) findPrev()
      else findNext()
    }
  }

  const attachResultsListener = (addon: SearchAddon) => {
    resultsDisposable?.dispose()
    resultsDisposable = addon.onDidChangeResults((e) => {
      setResultIndex(e.resultIndex)
      setResultCount(e.resultCount)
    })
  }

  onMount(() => {
    if (!terminalRef) return

    const existing = getXtermEntry(props.terminalId)

    if (existing) {
      const el = existing.term.element
      if (el) terminalRef.appendChild(el)
      searchAddonRef = existing.searchAddon
      if (searchAddonRef) attachResultsListener(searchAddonRef)
      setupCaptureKeyHandler(containerRef, existing.term, props.terminalId, props.isStopped, toggleSearch)
      initialFit(existing, props.terminalId)
      resizeObserver = attachResizeObserver(terminalRef, existing, props.terminalId)
      unsubAppearance = subscribeXtermToAppearance(existing.term, () => existing.fitAddon.fit())
      return
    }

    const fontCfg = getXtermFontConfig()
    const term = new XTerm({
      theme: getXtermTheme(),
      fontFamily: fontCfg.fontFamily,
      fontSize: fontCfg.fontSize,
      lineHeight: 1.0,
      cursorBlink: fontCfg.cursorBlink,
      cursorStyle: 'block',
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: isMac,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      drawBoldTextInBrightColors: false,
    })

    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    searchAddonRef = searchAddon
    attachResultsListener(searchAddon)
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(new WebLinksAddon())
    const unicode11 = new Unicode11Addon()
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'
    setupXtermPassthrough(term)
    setupCaptureKeyHandler(containerRef, term, props.terminalId, props.isStopped, toggleSearch)
    term.onData((data) => {
      if (props.isStopped?.()) return
      ipc.ptyWrite(props.terminalId, data)
    })
    registerXterm(props.terminalId, term, fitAddon, searchAddon)

    term.open(terminalRef)

    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // WebGL not available
    }

    const entry = { term, fitAddon, searchAddon }
    initialFit(entry, props.terminalId)
    resizeObserver = attachResizeObserver(terminalRef, entry, props.terminalId)
    unsubAppearance = subscribeXtermToAppearance(term, () => fitAddon.fit())
  })

  onCleanup(() => {
    resizeObserver?.disconnect()
    resultsDisposable?.dispose()
    unsubAppearance?.()
  })

  return (
    <div ref={containerRef} class="w-full h-full relative">
      <Show when={showSearch()}>
        <div class="absolute top-2 right-3 z-20 flex items-center gap-1 bg-surface-2 border border-border rounded-lg px-2 py-1 shadow-lg">
          <input
            ref={searchInputRef}
            class="bg-transparent text-sm text-text-primary outline-none w-52 placeholder-text-dim"
            placeholder="Find in terminal..."
            value={searchQuery()}
            onKeyDown={handleSearchKeyDown}
            onInput={(e) => {
              const val = e.currentTarget.value
              setSearchQuery(val)
              if (val) searchAddonRef?.findPrevious(val, searchOpts)
              else { searchAddonRef?.clearDecorations(); setResultIndex(-1); setResultCount(0) }
            }}
          />
          <span class="text-[11px] text-text-dim whitespace-nowrap w-16 text-right">
            {searchQuery() ? (resultCount() === 0 ? 'No results' : `${resultIndex() + 1} of ${resultCount()}`) : '\u00A0'}
          </span>
          <button
            class="p-0.5 text-text-dim hover:text-text-muted transition-colors disabled:opacity-30"
            onClick={findPrev}
            disabled={resultCount() === 0}
            title="Previous (Shift+Enter)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
          </button>
          <button
            class="p-0.5 text-text-dim hover:text-text-muted transition-colors disabled:opacity-30"
            onClick={findNext}
            disabled={resultCount() === 0}
            title="Next (Enter)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <button
            class="p-0.5 text-text-dim hover:text-text-muted transition-colors"
            onClick={closeSearch}
            title="Close (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      </Show>
      <div
        ref={terminalRef}
        class="w-full h-full shell-terminal"
        style={{ "background-color": "var(--surface-0)", cursor: "default" }}
      />
    </div>
  )
}
