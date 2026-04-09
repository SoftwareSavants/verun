import { EditorView, type Panel, type ViewUpdate, runScopeHandlers } from '@codemirror/view'
import { SearchQuery, setSearchQuery, getSearchQuery, findNext, findPrevious, replaceNext, replaceAll, closeSearchPanel } from '@codemirror/search'

/**
 * VS Code-style search panel for CodeMirror 6.
 *
 * Layout:
 *   [▶] [Find______________] [Aa] [W] [.*]  1 of 5  [↑] [↓] [×]
 *       [Replace___________] [⎘]  [⎘⎘]
 */
export function createSearchPanel(view: EditorView): Panel {
  return new VscodeSearchPanel(view)
}

class VscodeSearchPanel implements Panel {
  dom: HTMLElement
  private searchInput: HTMLInputElement
  private replaceInput: HTMLInputElement
  private caseBtn: HTMLButtonElement
  private wordBtn: HTMLButtonElement
  private regexBtn: HTMLButtonElement
  private matchInfo: HTMLSpanElement
  private replaceRow: HTMLElement
  private toggleBtn: HTMLButtonElement
  private query: SearchQuery
  private replaceVisible = false

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state)

    // ── Build DOM ────────────────────────────────────────────────
    this.dom = el('div', 'vsc-search')

    // Toggle replace button
    this.toggleBtn = el('button', 'vsc-toggle', { title: 'Toggle Replace', type: 'button' }) as HTMLButtonElement
    this.toggleBtn.innerHTML = '›'
    this.toggleBtn.onclick = () => this.toggleReplace()

    // Search input
    this.searchInput = el('input', 'vsc-input', {
      type: 'text',
      placeholder: 'Find',
      'main-field': 'true',
    }) as HTMLInputElement
    this.searchInput.value = this.query.search
    this.searchInput.oninput = () => this.commit()
    this.searchInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); findNext(this.view) }
      else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); findPrevious(this.view) }
      else if (e.key === 'Escape') { e.preventDefault(); closeSearchPanel(this.view) }
    }

    // Toggle buttons
    this.caseBtn = this.makeToggle('Aa', 'Match Case', this.query.caseSensitive)
    this.wordBtn = this.makeToggle('W', 'Match Whole Word', this.query.wholeWord ?? false)
    this.regexBtn = this.makeToggle('.*', 'Use Regular Expression', this.query.regexp)

    // Match count
    this.matchInfo = el('span', 'vsc-match-info') as HTMLSpanElement
    this.matchInfo.textContent = 'No results'

    // Nav buttons
    const prevBtn = this.makeIconBtn('↑', 'Previous Match (Shift+Enter)', () => findPrevious(this.view))
    const nextBtn = this.makeIconBtn('↓', 'Next Match (Enter)', () => findNext(this.view))
    const closeBtn = this.makeIconBtn('×', 'Close (Escape)', () => closeSearchPanel(this.view))
    closeBtn.classList.add('vsc-close')

    // Search row
    const searchRow = el('div', 'vsc-row')
    searchRow.append(this.toggleBtn, this.searchInput, this.caseBtn, this.wordBtn, this.regexBtn, this.matchInfo, prevBtn, nextBtn, closeBtn)

    // Replace input
    this.replaceInput = el('input', 'vsc-input vsc-replace-input', {
      type: 'text',
      placeholder: 'Replace',
    }) as HTMLInputElement
    this.replaceInput.value = this.query.replace
    this.replaceInput.oninput = () => this.commit()
    this.replaceInput.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); replaceNext(this.view) }
      else if (e.key === 'Escape') { e.preventDefault(); closeSearchPanel(this.view) }
    }

    const replaceOneBtn = this.makeIconBtn('⎘', 'Replace (Enter)', () => replaceNext(this.view))
    const replaceAllBtn = this.makeIconBtn('⎘⎘', 'Replace All', () => replaceAll(this.view))

    this.replaceRow = el('div', 'vsc-row vsc-replace-row')
    this.replaceRow.append(this.replaceInput, replaceOneBtn, replaceAllBtn)
    this.replaceRow.style.display = 'none'

    this.dom.append(searchRow, this.replaceRow)
    this.dom.onkeydown = (e) => {
      if (runScopeHandlers(this.view, e, 'search-panel')) {
        e.preventDefault()
      }
    }

    this.updateMatchCount()
  }

  private makeToggle(label: string, title: string, active: boolean): HTMLButtonElement {
    const btn = el('button', 'vsc-toggle-btn' + (active ? ' active' : ''), { title, type: 'button' }) as HTMLButtonElement
    btn.textContent = label
    btn.onclick = () => {
      btn.classList.toggle('active')
      this.commit()
    }
    return btn
  }

  private makeIconBtn(icon: string, title: string, action: () => void): HTMLButtonElement {
    const btn = el('button', 'vsc-icon-btn', { title, type: 'button' }) as HTMLButtonElement
    btn.textContent = icon
    btn.onclick = action
    return btn
  }

  private toggleReplace() {
    this.replaceVisible = !this.replaceVisible
    this.replaceRow.style.display = this.replaceVisible ? 'flex' : 'none'
    this.toggleBtn.classList.toggle('open', this.replaceVisible)
    if (this.replaceVisible) this.replaceInput.focus()
  }

  private commit() {
    const query = new SearchQuery({
      search: this.searchInput.value,
      caseSensitive: this.caseBtn.classList.contains('active'),
      regexp: this.regexBtn.classList.contains('active'),
      wholeWord: this.wordBtn.classList.contains('active'),
      replace: this.replaceInput.value,
    })
    if (!query.eq(this.query)) {
      this.query = query
      this.view.dispatch({ effects: setSearchQuery.of(query) })
    }
  }

  private updateMatchCount() {
    const query = getSearchQuery(this.view.state)
    if (!query.search) {
      this.matchInfo.textContent = ''
      return
    }
    const iter = query.getCursor(this.view.state.doc)
    let count = 0
    let currentIdx = 0
    const mainSel = this.view.state.selection.main.from
    let result = iter.next()
    while (!result.done) {
      count++
      if (result.value.from <= mainSel && result.value.to >= mainSel && currentIdx === 0) {
        currentIdx = count
      }
      result = iter.next()
    }
    if (count === 0) {
      this.matchInfo.textContent = 'No results'
    } else if (currentIdx > 0) {
      this.matchInfo.textContent = `${currentIdx} of ${count}`
    } else {
      this.matchInfo.textContent = `${count} results`
    }
  }

  mount() {
    this.searchInput.select()
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.setQuery(effect.value)
        }
      }
    }
    if (update.docChanged || update.selectionSet) {
      this.updateMatchCount()
    }
  }

  private setQuery(query: SearchQuery) {
    this.query = query
    this.searchInput.value = query.search
    this.replaceInput.value = query.replace
    this.caseBtn.classList.toggle('active', query.caseSensitive)
    this.regexBtn.classList.toggle('active', query.regexp)
    this.wordBtn.classList.toggle('active', query.wholeWord ?? false)
    this.updateMatchCount()
  }

  get pos() { return 80 }
  get top() { return true }
}

function el(tag: string, className?: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}

/**
 * CSS for the VS Code-style search panel, injected into the editor theme.
 */
export const searchPanelTheme = EditorView.theme({
  // Hide the default panel container styling
  '.cm-panels': {
    backgroundColor: 'transparent !important',
    border: 'none !important',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: 'none !important',
  },

  // Main container — floating top-right
  '.cm-panel.vsc-search': {
    position: 'absolute',
    right: '16px',
    top: '0px',
    zIndex: '20',
    backgroundColor: '#252526',
    border: '1px solid #454545',
    borderTop: 'none',
    borderRadius: '0 0 6px 6px',
    padding: '6px 6px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '12px',
    color: '#cccccc',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    maxWidth: '450px',
  },

  // Row layout
  '.vsc-row': {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
  },

  // Replace row offset (aligned with search input)
  '.vsc-replace-row': {
    paddingLeft: '22px',
  },

  // Toggle expand/collapse button (▶ / ▼)
  '.vsc-toggle': {
    background: 'none',
    border: 'none',
    color: '#cccccc',
    fontSize: '12px',
    cursor: 'pointer',
    padding: '0 4px',
    width: '18px',
    height: '22px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '3px',
    transform: 'rotate(0deg)',
    transition: 'transform 0.15s ease',
    flexShrink: '0',
  },
  '.vsc-toggle:hover': {
    backgroundColor: '#3e3e42',
  },
  '.vsc-toggle.open': {
    transform: 'rotate(90deg)',
  },

  // Text inputs
  '.vsc-input': {
    backgroundColor: '#3c3c3c',
    color: '#cccccc',
    border: '1px solid #3c3c3c',
    borderRadius: '3px',
    padding: '3px 6px',
    fontSize: '12px',
    fontFamily: '"SF Mono", "Cascadia Code", "JetBrains Mono", "Fira Code", monospace',
    outline: 'none',
    height: '24px',
    boxSizing: 'border-box',
    width: '180px',
    flexShrink: '0',
  },
  '.vsc-input:focus': {
    borderColor: '#007fd4',
  },
  '.vsc-replace-input': {
    width: '180px',
  },

  // Toggle buttons (Aa, W, .*)
  '.vsc-toggle-btn': {
    background: 'none',
    border: '1px solid transparent',
    borderRadius: '3px',
    color: '#999999',
    fontSize: '11px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    cursor: 'pointer',
    padding: '1px 4px',
    height: '22px',
    minWidth: '22px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: '0',
  },
  '.vsc-toggle-btn:hover': {
    backgroundColor: '#3e3e42',
    color: '#cccccc',
  },
  '.vsc-toggle-btn.active': {
    backgroundColor: '#264f78',
    border: '1px solid #007fd4',
    color: '#ffffff',
  },

  // Icon buttons (↑ ↓ × ⎘)
  '.vsc-icon-btn': {
    background: 'none',
    border: 'none',
    borderRadius: '3px',
    color: '#999999',
    fontSize: '13px',
    cursor: 'pointer',
    padding: '1px 4px',
    height: '22px',
    minWidth: '22px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: '0',
  },
  '.vsc-icon-btn:hover': {
    backgroundColor: '#3e3e42',
    color: '#cccccc',
  },

  // Close button
  '.vsc-close': {
    fontSize: '16px',
  },

  // Match info
  '.vsc-match-info': {
    color: '#999999',
    fontSize: '11px',
    padding: '0 6px',
    whiteSpace: 'nowrap',
    minWidth: '60px',
    textAlign: 'center',
    flexShrink: '0',
  },

  // Search match highlighting
  '.cm-searchMatch': {
    backgroundColor: 'rgba(234, 179, 8, 0.25)',
    borderRadius: '2px',
    outline: '1px solid rgba(234, 179, 8, 0.4)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(234, 179, 8, 0.5)',
    outline: '1px solid rgba(234, 179, 8, 0.8)',
  },
}, { dark: true })
