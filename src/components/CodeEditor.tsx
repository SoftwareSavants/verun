import { Component, createEffect, on, createSignal, Show, onCleanup, onMount } from 'solid-js'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, showTooltip, Decoration, type DecorationSet, type Tooltip } from '@codemirror/view'
import { EditorState, StateField, StateEffect, RangeSet, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentUnit } from '@codemirror/language'
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { jumpToDefinition, jumpToDefinitionKeymap, findReferencesKeymap, formatKeymap, LSPPlugin } from '@codemirror/lsp-client'
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
import { setTabDirty, getCachedContent, setCachedContent, getCachedOriginal, setCachedOriginal } from '../store/files'
import { getLspClient, isLspSupported, registerEditorView, unregisterEditorView } from '../lib/lsp'

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

// ── Inline rename widget (VS Code style) ──────────────────────────────
const showRenameTooltip = StateEffect.define<Tooltip | null>()

const renameTooltipField = StateField.define<Tooltip | null>({
  create: () => null,
  update(tooltip, tr) {
    for (const e of tr.effects) {
      if (e.is(showRenameTooltip)) return e.value
    }
    return tooltip
  },
  provide: f => showTooltip.from(f),
})

function inlineRename(view: EditorView): boolean {
  const wordRange = view.state.wordAt(view.state.selection.main.head)
  const plugin = LSPPlugin.get(view)
  if (!wordRange || !plugin || !plugin.client.serverCapabilities?.renameProvider) return false

  const word = view.state.sliceDoc(wordRange.from, wordRange.to)

  view.dispatch({
    effects: showRenameTooltip.of({
      pos: wordRange.from,
      above: true,
      create: () => {
        const container = document.createElement('div')
        container.className = 'cm-rename-widget'

        const input = document.createElement('input')
        input.type = 'text'
        input.value = word
        input.className = 'cm-rename-input'
        input.setAttribute('spellcheck', 'false')

        const dismiss = () => {
          view.dispatch({ effects: showRenameTooltip.of(null) })
          view.focus()
        }

        const submit = () => {
          const newName = input.value.trim()
          dismiss()
          if (newName && newName !== word) {
            const p = LSPPlugin.get(view)
            if (!p) return
            p.client.sync()
            p.client.withMapping((mapping: any) =>
              p.client.request('textDocument/rename', {
                newName,
                position: p.toPosition(wordRange.from),
                textDocument: { uri: p.uri },
              }).then((response: any) => {
                if (!response) return
                for (const uri in response.changes) {
                  const lspChanges = response.changes[uri]
                  const file = p.client.workspace.getFile(uri)
                  if (!lspChanges.length || !file) continue
                  p.client.workspace.updateFile(uri, {
                    changes: lspChanges.map((change: any) => ({
                      from: mapping.mapPosition(uri, change.range.start),
                      to: mapping.mapPosition(uri, change.range.end),
                      insert: change.newText,
                    })),
                    userEvent: 'rename',
                  })
                }
              })
            )
          }
        }

        input.onkeydown = (e: KeyboardEvent) => {
          if (e.key === 'Enter') { e.preventDefault(); submit() }
          else if (e.key === 'Escape') { e.preventDefault(); dismiss() }
          e.stopPropagation()
        }
        input.onblur = dismiss

        container.appendChild(input)
        requestAnimationFrame(() => { input.focus(); input.select() })
        return { dom: container }
      },
    }),
  })
  return true
}

const renameWidgetTheme = EditorView.theme({
  '.cm-rename-widget': {
    backgroundColor: '#252526',
    border: '1px solid #454545',
    borderRadius: '4px',
    padding: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
  },
  '.cm-rename-input': {
    backgroundColor: '#3c3c3c',
    color: '#cccccc',
    border: '1px solid #3c3c3c',
    borderRadius: '3px',
    padding: '3px 6px',
    fontSize: '13px',
    fontFamily: '"SF Mono", "Cascadia Code", "JetBrains Mono", "Fira Code", monospace',
    outline: 'none',
    width: '200px',
    height: '24px',
    boxSizing: 'border-box',
  },
  '.cm-rename-input:focus': {
    borderColor: '#007fd4',
  },
  // Position the tooltip properly
  '.cm-tooltip.cm-tooltip-above': {
    borderRadius: '4px',
  },
}, { dark: true })

// ── Cmd+hover underline (VS Code style) ─────────────────────────────
const setHoverRange = StateEffect.define<{ from: number; to: number } | null>()

const hoverUnderlineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(setHoverRange)) {
        if (!e.value) return Decoration.none
        return RangeSet.of([
          Decoration.mark({ class: 'cm-definition-hover' }).range(e.value.from, e.value.to),
        ])
      }
    }
    return decos.map(tr.changes)
  },
  provide: f => EditorView.decorations.from(f),
})

const hoverUnderlineTheme = EditorView.theme({
  '.cm-definition-hover': {
    textDecoration: 'underline',
    cursor: 'pointer',
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
    renameWidgetTheme,
    renameTooltipField,
    hoverUnderlineTheme,
    hoverUnderlineField,
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
      ...formatKeymap,
      { key: 'F2', run: inlineRename, preventDefault: true },
      indentWithTab,
      { key: 'Mod-s', run: () => { onSave(); return true } },
    ]),

    // Cmd+Click → go to definition, Cmd+hover → underline
    (() => {
      let lastMouse: { x: number; y: number } | null = null

      const updateHover = (view: EditorView, x: number, y: number, mod: boolean) => {
        if (!mod) {
          view.dispatch({ effects: setHoverRange.of(null) })
          return
        }
        const pos = view.posAtCoords({ x, y })
        if (pos == null) { view.dispatch({ effects: setHoverRange.of(null) }); return }
        const word = view.state.wordAt(pos)
        if (!word) { view.dispatch({ effects: setHoverRange.of(null) }); return }

        // Only update if the range actually changed
        const cur = view.state.field(hoverUnderlineField)
        let same = false
        cur.between(word.from, word.to, (f, t) => { if (f === word.from && t === word.to) same = true })
        if (!same) view.dispatch({ effects: setHoverRange.of({ from: word.from, to: word.to }) })
      }

      return EditorView.domEventHandlers({
        click: (event, view) => {
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault()
            view.dispatch({ effects: setHoverRange.of(null) })
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
            if (pos != null) {
              view.dispatch({ selection: { anchor: pos } })
              jumpToDefinition(view)
            }
            return true
          }
          return false
        },
        mousemove: (event, view) => {
          lastMouse = { x: event.clientX, y: event.clientY }
          updateHover(view, event.clientX, event.clientY, event.metaKey || event.ctrlKey)
          return false
        },
        mouseleave: (_event, view) => {
          lastMouse = null
          view.dispatch({ effects: setHoverRange.of(null) })
          return false
        },
        keydown: (event, view) => {
          if ((event.key === 'Meta' || event.key === 'Control') && lastMouse) {
            updateHover(view, lastMouse.x, lastMouse.y, true)
          }
          return false
        },
        keyup: (event, view) => {
          if (event.key === 'Meta' || event.key === 'Control') {
            view.dispatch({ effects: setHoverRange.of(null) })
          }
          return false
        },
      })
    })(),

    // Doc change listener
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDocChange(update.state.doc.toString())
      }
    }),

    // Context menu handler — move cursor to click position first
    EditorView.domEventHandlers({
      contextmenu: (event, view) => {
        event.preventDefault()
        // Move cursor to right-click position so Go to Definition works on the right word
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos != null) {
          view.dispatch({ selection: { anchor: pos } })
        }
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
  // Cursor position saved at right-click time, for context menu actions
  let contextMenuCursorPos: number | null = null

  // Current content — tracked for save, not reactive for CM
  let currentContent = ''
  // Current file URI for LSP view registration
  let currentFileUri = ''

  const save = async () => {
    try {
      await ipc.writeTextFile(props.taskId, props.relativePath, currentContent)
      setOriginalContent(currentContent)
      setCachedOriginal(props.taskId, props.relativePath, currentContent)
      setTabDirty(props.taskId, props.relativePath, false)
    } catch (e) {
      console.error('Save failed:', e)
    }
  }

  const createEditor = async (doc: string, path: string, worktreePath: string) => {
    // Destroy previous instance
    if (editorView) {
      if (currentFileUri) unregisterEditorView(currentFileUri)
      editorView.destroy()
      editorView = undefined
    }

    if (!editorParentRef) return

    const extensions = buildExtensions(
      path,
      (content) => {
        currentContent = content
        setCachedContent(props.taskId, props.relativePath, content)
        setTabDirty(props.taskId, props.relativePath, content !== originalContent())
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

    // Register the view for cross-file go-to-definition
    if (worktreePath) {
      currentFileUri = `file://${worktreePath}/${path}`
      registerEditorView(currentFileUri, editorView)
    }
  }

  // Load file and create editor — uses cache to avoid flicker on tab switch
  createEffect(on(() => props.relativePath, async (path) => {
    // Check cache first for instant tab switching
    const cached = getCachedContent(props.taskId, path)
    const cachedOriginal = getCachedOriginal(props.taskId, path)
    if (cached !== undefined && cachedOriginal !== undefined) {
      currentContent = cached
      setOriginalContent(cachedOriginal)
      try {
        const task = await ipc.getTask(props.taskId)
        await createEditor(cached, path, task?.worktreePath ?? '')
      } catch {
        await createEditor(cached, path, '')
      }
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const task = await ipc.getTask(props.taskId)
      if (!task) return
      const fullPath = `${task.worktreePath}/${path}`
      const text = await ipc.readTextFile(fullPath)
      currentContent = text
      setOriginalContent(text)
      setCachedContent(props.taskId, path, text)
      setCachedOriginal(props.taskId, path, text)
      setTabDirty(props.taskId, path, false)

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
    if (currentFileUri) unregisterEditorView(currentFileUri)
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

  /** Restore cursor, re-focus editor, then run action on next frame */
  const runAtContextCursor = (_actionName: string, action: (view: EditorView) => boolean | void) => {
    setContextMenu(null)
    if (!editorView || contextMenuCursorPos == null) return
    const view = editorView
    const pos = contextMenuCursorPos
    view.dispatch({ selection: { anchor: pos } })
    view.focus()
    requestAnimationFrame(() => action(view))
  }

  const handleGoToDefinition = () => {
    runAtContextCursor('GoToDefinition', (view) => jumpToDefinition(view))
  }

  const handleFindReferences = () => {
    runAtContextCursor('FindReferences', (view) => {
      import('@codemirror/lsp-client').then(({ findReferences }) => findReferences(view))
    })
  }

  const handleRenameSymbol = () => {
    runAtContextCursor('Rename', (view) => inlineRename(view))
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
  const handleClickOutside = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.editor-ctx-menu')) return
    setContextMenu(null)
  }
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
      if (editorView) {
        contextMenuCursorPos = editorView.state.selection.main.head
      }
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
            class="editor-ctx-menu fixed z-100 bg-[#21252b] border border-[#181a1f] rounded-lg py-1 min-w-52"
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
