import { Component, createEffect, on, createSignal, Show, onCleanup, onMount } from 'solid-js'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentUnit } from '@codemirror/language'
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { jumpToDefinition, jumpToDefinitionKeymap, findReferencesKeymap, renameKeymap, formatKeymap } from '@codemirror/lsp-client'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { createSearchPanel, searchPanelTheme } from './SearchPanel'
import { tags } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { sass } from '@codemirror/lang-sass'
import * as ipc from '../lib/ipc'
import { setTabDirty } from '../store/files'
import { getLspClient, isLspSupported } from '../lib/lsp'

interface Props {
  taskId: string
  relativePath: string
}

// ── Syntax highlighting — VS Code One Dark colors ──────────────────────
const verunHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#c678dd' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#e06c75' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#61afef' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#d19a66' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#abb2bf' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: '#e5c07b' },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: '#56b6c2' },
  { tag: [tags.meta, tags.comment], color: '#7f848e', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: '#61afef', textDecoration: 'underline' },
  { tag: tags.heading, fontWeight: 'bold', color: '#e06c75' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#d19a66' },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#98c379' },
  { tag: tags.invalid, color: '#ffffff', backgroundColor: '#e06c75' },
  { tag: tags.propertyName, color: '#e06c75' },
  { tag: tags.variableName, color: '#e06c75' },
  { tag: tags.definition(tags.variableName), color: '#61afef' },
  { tag: tags.definition(tags.propertyName), color: '#61afef' },
  { tag: tags.definition(tags.typeName), color: '#e5c07b' },
])

// ── Editor chrome — backgrounds, gutters, cursors ─────────────────────
const verunTheme = EditorView.theme({
  '&': {
    backgroundColor: '#1e1e1e',
    color: '#abb2bf',
    fontSize: '13px',
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: '"SF Mono", "Cascadia Code", "JetBrains Mono", "Fira Code", "Menlo", monospace',
    lineHeight: '1.6',
    overflow: 'auto',
    scrollbarWidth: 'thin',
    scrollbarColor: '#3e4452 transparent',
  },
  '.cm-content': {
    caretColor: '#528bff',
    padding: '4px 0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#528bff',
    borderLeftWidth: '2px',
  },
  '.cm-activeLine': {
    backgroundColor: '#2c313a',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#2c313a',
    color: '#abb2bf',
  },
  '.cm-gutters': {
    backgroundColor: '#1e1e1e',
    color: '#495162',
    border: 'none',
    borderRight: '1px solid #2c313a',
    minWidth: '48px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 12px 0 16px',
    minWidth: '40px',
    fontSize: '12px',
    textAlign: 'right',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: '#3e4452',
    border: 'none',
    color: '#7f848e',
    padding: '0 8px',
    borderRadius: '3px',
    margin: '0 4px',
  },
  '.cm-selectionBackground': {
    backgroundColor: '#3e4452 !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: '#264f78 !important',
  },
  '.cm-selectionMatch': {
    backgroundColor: '#3a3d41',
    borderRadius: '2px',
  },
  '.cm-matchingBracket': {
    backgroundColor: '#3e4452',
    outline: '1px solid #528bff',
    color: '#abb2bf !important',
  },
  '.cm-nonmatchingBracket': {
    color: '#e06c75 !important',
  },
  // Search match highlighting (panel CSS is in SearchPanel.ts)
  '.cm-tooltip': {
    backgroundColor: '#21252b',
    border: '1px solid #181a1f',
    borderRadius: '6px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li': {
      padding: '4px 8px',
      fontSize: '12px',
    },
    '& > ul > li[aria-selected]': {
      backgroundColor: '#2c313a',
      color: '#abb2bf',
    },
  },
  '.cm-foldGutter': {
    width: '14px',
  },
  '.cm-foldGutter .cm-gutterElement': {
    color: '#495162',
    fontSize: '12px',
    padding: '0 2px',
    cursor: 'pointer',
  },
  '.cm-foldGutter .cm-gutterElement:hover': {
    color: '#abb2bf',
  },
}, { dark: true })

// ── Language detection ─────────────────────────────────────────────────
function langFromExt(path: string): Extension | null {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const name = path.split('/').pop()?.toLowerCase() || ''

  // Check filename first for special cases
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return null
  if (name === 'makefile' || name === 'gnumakefile') return null

  switch (ext) {
    case 'js': case 'mjs': case 'cjs':
      return javascript()
    case 'ts': case 'mts': case 'cts':
      return javascript({ typescript: true })
    case 'jsx':
      return javascript({ jsx: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'py': case 'pyi': case 'pyw':
      return python()
    case 'rs':
      return rust()
    case 'json': case 'jsonc': case 'json5':
      return json()
    case 'html': case 'htm': case 'svelte': case 'vue':
      return html()
    case 'css':
      return css()
    case 'scss': case 'sass':
      return sass()
    case 'md': case 'mdx':
      return markdown()
    case 'java':
      return java()
    case 'c': case 'cpp': case 'h': case 'hpp': case 'cc': case 'cxx':
      return cpp()
    case 'go':
      return go()
    case 'php':
      return php()
    case 'sql':
      return sql()
    case 'xml': case 'svg': case 'xsl': case 'xsd': case 'wsdl': case 'plist':
      return xml()
    case 'yaml': case 'yml':
      return yaml()
    case 'toml':
      return json()
    default:
      return null
  }
}

// ── Build all extensions for a given file path ─────────────────────────
function buildExtensions(path: string, onDocChange: (content: string) => void, onSave: () => void): Extension[] {
  const exts: Extension[] = [
    // Theme & highlighting
    verunTheme,
    searchPanelTheme,
    syntaxHighlighting(verunHighlightStyle),
    syntaxHighlighting(oneDarkHighlightStyle, { fallback: true }),

    // Core editor features
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    indentOnInput(),
    indentUnit.of('  '),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    history(),
    search({ top: true, createPanel: createSearchPanel }),
    highlightSelectionMatches(),
    EditorView.lineWrapping,

    // Code folding
    foldGutter({
      openText: '\u25BE',
      closedText: '\u25B8',
    }),

    // Keymaps
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...jumpToDefinitionKeymap,
      ...findReferencesKeymap,
      ...renameKeymap,
      ...formatKeymap,
      indentWithTab,
      { key: 'Mod-s', run: () => { onSave(); return true } },
    ]),

    // Cmd+Click → go to definition
    EditorView.domEventHandlers({
      click: (event, view) => {
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault()
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos != null) {
            view.dispatch({ selection: { anchor: pos } })
            jumpToDefinition(view)
          }
          return true
        }
        return false
      },
    }),

    // Doc change listener
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDocChange(update.state.doc.toString())
      }
    }),

    // Context menu handler
    EditorView.domEventHandlers({
      contextmenu: (event, view) => {
        event.preventDefault()
        const editorEl = view.dom.closest('.code-editor-wrapper')
        if (editorEl) {
          editorEl.dispatchEvent(new CustomEvent('editor-context-menu', {
            detail: { x: event.clientX, y: event.clientY },
            bubbles: true,
          }))
        }
        return true
      },
    }),
  ]

  const lang = langFromExt(path)
  if (lang) exts.push(lang)

  return exts
}

// ── Component ──────────────────────────────────────────────────────────
export const CodeEditor: Component<Props> = (props) => {
  const [originalContent, setOriginalContent] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number } | null>(null)

  let editorView: EditorView | undefined
  let containerRef: HTMLDivElement | undefined
  let editorParentRef: HTMLDivElement | undefined

  // Current content — tracked for save, not reactive for CM
  let currentContent = ''

  const save = async () => {
    try {
      await ipc.writeTextFile(props.taskId, props.relativePath, currentContent)
      setOriginalContent(currentContent)
      setTabDirty(props.relativePath, false)
    } catch (e) {
      console.error('Save failed:', e)
    }
  }

  const createEditor = async (doc: string, path: string, worktreePath: string) => {
    // Destroy previous instance
    if (editorView) {
      editorView.destroy()
      editorView = undefined
    }

    if (!editorParentRef) return

    const extensions = buildExtensions(
      path,
      (content) => {
        currentContent = content
        setTabDirty(props.relativePath, content !== originalContent())
      },
      save,
    )

    // Add LSP plugin for JS/TS files
    if (isLspSupported(path)) {
      try {
        const client = await getLspClient(props.taskId, worktreePath)
        const fileUri = `file://${worktreePath}/${path}`
        extensions.push(client.plugin(fileUri, 'typescript'))
      } catch (e) {
        console.warn('LSP not available:', e)
        // Editor works fine without LSP
      }
    }

    const state = EditorState.create({ doc, extensions })
    editorView = new EditorView({ state, parent: editorParentRef })
  }

  // Load file and create editor
  createEffect(on(() => props.relativePath, async (path) => {
    setLoading(true)
    try {
      const task = await ipc.getTask(props.taskId)
      if (!task) return
      const fullPath = `${task.worktreePath}/${path}`
      const text = await ipc.readTextFile(fullPath)
      currentContent = text
      setOriginalContent(text)
      setTabDirty(path, false)

      // Create fresh editor with content + correct language + LSP
      await createEditor(text, path, task.worktreePath)
    } catch (e) {
      currentContent = `Error loading file: ${e}`
      await createEditor(currentContent, path, '')
    } finally {
      setLoading(false)
    }
  }))

  // Cleanup
  onCleanup(() => {
    if (editorView) {
      editorView.destroy()
      editorView = undefined
    }
  })

  // ── Context menu actions ───────────────────────────────────────────
  const handleCut = () => {
    if (!editorView) return
    const { from, to } = editorView.state.selection.main
    const sel = editorView.state.sliceDoc(from, to)
    if (sel) {
      navigator.clipboard.writeText(sel)
      editorView.dispatch(editorView.state.replaceSelection(''))
    }
    setContextMenu(null)
  }

  const handleCopy = () => {
    if (!editorView) return
    const { from, to } = editorView.state.selection.main
    const sel = editorView.state.sliceDoc(from, to)
    if (sel) navigator.clipboard.writeText(sel)
    setContextMenu(null)
  }

  const handlePaste = async () => {
    if (!editorView) return
    const text = await navigator.clipboard.readText()
    editorView.dispatch(editorView.state.replaceSelection(text))
    setContextMenu(null)
  }

  const handleSelectAll = () => {
    if (!editorView) return
    editorView.dispatch({ selection: { anchor: 0, head: editorView.state.doc.length } })
    setContextMenu(null)
  }

  const handleGoToDefinition = () => {
    if (editorView) jumpToDefinition(editorView)
    setContextMenu(null)
  }

  const handleFindReferences = () => {
    if (editorView) {
      import('@codemirror/lsp-client').then(({ findReferences }) => findReferences(editorView!))
    }
    setContextMenu(null)
  }

  const handleRenameSymbol = () => {
    if (editorView) {
      import('@codemirror/lsp-client').then(({ renameSymbol }) => renameSymbol(editorView!))
    }
    setContextMenu(null)
  }

  const handleCopyPath = () => {
    navigator.clipboard.writeText(props.relativePath)
    setContextMenu(null)
  }

  const handleFind = () => {
    if (editorView) openSearchPanel(editorView)
    setContextMenu(null)
  }

  const handleRevealInFinder = async () => {
    const task = await ipc.getTask(props.taskId)
    if (task) ipc.openInFinder(`${task.worktreePath}/${props.relativePath}`)
    setContextMenu(null)
  }

  const hasSelection = () => {
    if (!editorView) return false
    const { from, to } = editorView.state.selection.main
    return from !== to
  }

  // Close context menu on click outside
  const handleClickOutside = () => setContextMenu(null)
  createEffect(() => {
    if (contextMenu()) {
      document.addEventListener('mousedown', handleClickOutside)
    } else {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  })
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside))

  // Listen for context menu event from CM dom handler
  onMount(() => {
    containerRef?.addEventListener('editor-context-menu', ((e: CustomEvent) => {
      setContextMenu({ x: e.detail.x, y: e.detail.y })
    }) as EventListener)
  })

  return (
    <div ref={containerRef} class="code-editor-wrapper h-full overflow-hidden relative">
      <div ref={editorParentRef} class="h-full" style={{ display: loading() ? 'none' : 'block' }} />
      <Show when={loading()}>
        <div class="flex items-center justify-center h-full text-text-dim text-xs">
          Loading...
        </div>
      </Show>

      {/* Context menu */}
      <Show when={contextMenu()}>
        {(pos) => (
          <div
            class="fixed z-100 bg-[#21252b] border border-[#181a1f] rounded-lg py-1 min-w-52"
            style={{
              left: `${pos().x}px`,
              top: `${pos().y}px`,
              'box-shadow': '0 6px 24px rgba(0,0,0,0.5)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <ContextMenuItem label="Go to Definition" shortcut="F12" onClick={handleGoToDefinition} />
            <ContextMenuItem label="Find References" shortcut="Shift+F12" onClick={handleFindReferences} />
            <ContextMenuItem label="Rename Symbol" shortcut="F2" onClick={handleRenameSymbol} />
            <ContextMenuSep />
            <ContextMenuItem label="Cut" shortcut={'\u2318X'} onClick={handleCut} disabled={!hasSelection()} />
            <ContextMenuItem label="Copy" shortcut={'\u2318C'} onClick={handleCopy} disabled={!hasSelection()} />
            <ContextMenuItem label="Paste" shortcut={'\u2318V'} onClick={handlePaste} />
            <ContextMenuSep />
            <ContextMenuItem label="Select All" shortcut={'\u2318A'} onClick={handleSelectAll} />
            <ContextMenuSep />
            <ContextMenuItem label="Find" shortcut={'\u2318F'} onClick={handleFind} />
            <ContextMenuItem label="Find and Replace" shortcut={'\u2318H'} onClick={handleFind} />
            <ContextMenuSep />
            <ContextMenuItem label="Copy Relative Path" onClick={handleCopyPath} />
            <ContextMenuItem label="Reveal in Finder" onClick={handleRevealInFinder} />
          </div>
        )}
      </Show>
    </div>
  )
}

// ── Context menu primitives ────────────────────────────────────────────
function ContextMenuItem(props: { label: string; shortcut?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      class="w-full flex items-center justify-between px-3 py-1.5 text-[12px] text-[#abb2bf] hover:bg-[#2c313a] transition-colors text-left disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent"
      onClick={props.onClick}
      disabled={props.disabled}
    >
      <span>{props.label}</span>
      <Show when={props.shortcut}>
        <span class="text-[11px] text-[#5c6370] ml-8">{props.shortcut}</span>
      </Show>
    </button>
  )
}

function ContextMenuSep() {
  return <div class="h-px bg-[#181a1f] my-1" />
}
