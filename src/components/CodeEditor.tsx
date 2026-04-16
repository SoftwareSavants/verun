import { Component, createEffect, on, createSignal, Show, onCleanup, onMount } from 'solid-js'
import { EditorView, keymap, lineNumbers, ViewPlugin, GutterMarker, gutterLineClass, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, showTooltip, hoverTooltip, tooltips, Decoration, type DecorationSet, type Tooltip } from '@codemirror/view'
import { linter, forEachDiagnostic, type Diagnostic } from '@codemirror/lint'
import { EditorState, StateField, StateEffect, RangeSet, Facet, type Extension } from '@codemirror/state'
import { setChatPrefillRequest } from '../store/ui'
import { mainView, setMainView } from '../store/editorView'
import { ContextMenu } from './ContextMenu'
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from '@codemirror/commands'
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
import { getCachedContent, setCachedContent, getCachedOriginal, setCachedOriginal } from '../store/files'
import { setTabDirty, pendingGoToLine, consumeGoToLine, onBeforeActiveEditorChange, onTabClose, onTaskCleanup } from '../store/editorView'
import { reloadNonce, checkBeforeSave } from '../store/fileSync'
import { getLspClient, isLspSupported, registerEditorView, unregisterEditorView } from '../lib/lsp'

// Selection-aware active line: suppresses highlight when text is selected
// so single-line selections remain visible through drawSelection()'s z-index layer.
const activeLineDeco = Decoration.line({ class: 'cm-activeLine' })

export function selectionAwareActiveLine() {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.getDeco(view)
    }
    update(update: { docChanged: boolean, selectionSet: boolean, view: EditorView }) {
      if (update.docChanged || update.selectionSet)
        this.decorations = this.getDeco(update.view)
    }
    getDeco(view: EditorView): DecorationSet {
      if (view.state.selection.ranges.some(r => !r.empty))
        return Decoration.none
      let lastLineStart = -1
      const deco: ReturnType<typeof activeLineDeco.range>[] = []
      for (const r of view.state.selection.ranges) {
        const line = view.lineBlockAt(r.head)
        if (line.from > lastLineStart) {
          deco.push(activeLineDeco.range(line.from))
          lastLineStart = line.from
        }
      }
      return Decoration.set(deco)
    }
  }, {
    decorations: v => v.decorations
  })
}

const activeLineGutterDeco = new class extends GutterMarker {
  elementClass = 'cm-activeLineGutter'
}

function selectionAwareActiveLineGutter() {
  return gutterLineClass.compute(['selection'], state => {
    if (state.selection.ranges.some(r => !r.empty))
      return RangeSet.empty
    const marks: ReturnType<typeof activeLineGutterDeco.range>[] = []
    let last = -1
    for (const range of state.selection.ranges) {
      const linePos = state.doc.lineAt(range.head).from
      if (linePos > last) {
        last = linePos
        marks.push(activeLineGutterDeco.range(linePos))
      }
    }
    return RangeSet.of(marks)
  })
}

interface Props {
  taskId: string
  relativePath: string
}

// ── Syntax highlighting — VS Code One Dark colors ──────────────────────
export const verunHighlightStyle = HighlightStyle.define([
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
export const verunTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--surface-0)',
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
    backgroundColor: 'var(--surface-0)',
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

// ── Editor context facet — carries taskId + relativePath to module-level
// extensions (the merged hover tooltip needs these for the "Ask agent to
// fix" action, which references the current file and task).
interface EditorContext { taskId: string; relativePath: string }
const editorContextFacet = Facet.define<EditorContext, EditorContext | null>({
  combine: (values) => values.length > 0 ? values[0] : null,
})

// ── Merged hover tooltip (diagnostic + type, single popup) ─────────────
// The LSP client's hoverTooltips() and @codemirror/lint's hover each render
// their own tooltip at the same position, so hovering an errored identifier
// stacks the type info on top of the error. We disable both (see
// `languageServerExtensions` replacement in `src/lib/lsp.ts` and the
// `linter(null, { tooltipFilter })` below) and render one merged tooltip:
// error section first, then type info, with a divider.
function renderHoverContents(plugin: any, contents: any): string {
  if (!contents) return ''
  if (Array.isArray(contents)) return contents.map(c => renderHoverContents(plugin, c)).filter(Boolean).join('<br>')
  if (typeof contents === 'string') return plugin.docToHTML(contents, 'markdown')
  if ('kind' in contents) return plugin.docToHTML(contents)
  if ('value' in contents) return plugin.docToHTML(String(contents.value ?? ''), 'markdown')
  return ''
}

type PositionedDiagnostic = Diagnostic & { from: number; to: number }

const mergedHoverTooltip = hoverTooltip(async (view, pos) => {
  // 1. Collect lint diagnostics covering `pos`
  const diags: PositionedDiagnostic[] = []
  forEachDiagnostic(view.state, (d: Diagnostic, from: number, to: number) => {
    if (pos >= from && pos <= to) diags.push({ ...d, from, to })
  })

  // 2. Fetch LSP hover (types) in parallel
  const plugin = LSPPlugin.get(view)
  let hoverHtml = ''
  let hoverFrom = pos
  let hoverTo = pos
  if (plugin && plugin.client.serverCapabilities?.hoverProvider) {
    try {
      plugin.client.sync()
      const result: any = await plugin.client.request('textDocument/hover', {
        position: plugin.toPosition(pos),
        textDocument: { uri: plugin.uri },
      })
      if (result && result.contents) {
        hoverHtml = renderHoverContents(plugin, result.contents)
        if (result.range) {
          hoverFrom = plugin.fromPosition(result.range.start)
          hoverTo = plugin.fromPosition(result.range.end)
        }
      }
    } catch { /* swallow — show diagnostics-only tooltip if types failed */ }
  }

  if (diags.length === 0 && !hoverHtml) return null

  return {
    pos: diags.length > 0 ? Math.min(diags[0].from, hoverFrom) : hoverFrom,
    end: diags.length > 0 ? Math.max(diags[diags.length - 1].to, hoverTo) : hoverTo,
    above: true,
    create: () => {
      const dom = document.createElement('div')
      dom.className = 'cm-merged-hover'
      // Cap the tooltip size to the smaller of a fixed ceiling and the
      // editor's bounds, so it never overflows its container (and also
      // stays readable on huge monitors).
      const rect = view.dom.getBoundingClientRect()
      dom.style.maxWidth = `${Math.min(560, Math.max(240, Math.floor(rect.width - 24)))}px`
      dom.style.maxHeight = `${Math.min(400, Math.max(120, Math.floor(rect.height - 48)))}px`

      const ctx = view.state.facet(editorContextFacet)

      // Scrollable content area — errors + type info scroll together,
      // action footer stays pinned at the bottom (VS Code layout).
      const scroll = document.createElement('div')
      scroll.className = 'cm-merged-hover-scroll'
      dom.appendChild(scroll)

      if (diags.length > 0) {
        const errSection = document.createElement('div')
        errSection.className = 'cm-merged-hover-errors'
        for (const d of diags) {
          const row = document.createElement('div')
          row.className = `cm-merged-hover-diagnostic cm-merged-hover-${d.severity}`
          const msg = document.createElement('span')
          msg.className = 'cm-merged-hover-message'
          msg.textContent = d.message
          row.appendChild(msg)
          if (d.source) {
            const meta = document.createElement('span')
            meta.className = 'cm-merged-hover-meta'
            meta.textContent = d.source
            row.appendChild(meta)
          }
          errSection.appendChild(row)
        }
        scroll.appendChild(errSection)
      }

      if (hoverHtml) {
        if (diags.length > 0) {
          const divider = document.createElement('div')
          divider.className = 'cm-merged-hover-divider'
          scroll.appendChild(divider)
        }
        const typeSection = document.createElement('div')
        typeSection.className = 'cm-merged-hover-type cm-lsp-documentation'
        typeSection.innerHTML = hoverHtml
        scroll.appendChild(typeSection)
      }

      // "Ask agent to fix" — pinned footer (VS Code style). Prefills the
      // message input with a template referencing the current file and the
      // diagnostic(s) at this position, then focuses the session tab. User
      // reviews and sends manually.
      if (diags.length > 0 && ctx) {
        const actions = document.createElement('div')
        actions.className = 'cm-merged-hover-actions'
        const askBtn = document.createElement('button')
        askBtn.className = 'cm-merged-hover-ask'
        askBtn.type = 'button'
        askBtn.textContent = 'Ask agent to fix'
        askBtn.onclick = (e) => {
          e.preventDefault()
          e.stopPropagation()
          const line = view.state.doc.lineAt(pos).number
          const messages = diags.map(d => `- ${d.message}`).join('\n')
          const text = diags.length === 1
            ? `Fix this error in @${ctx.relativePath} (line ${line}):\n\n${diags[0].message}`
            : `Fix these errors in @${ctx.relativePath} (line ${line}):\n\n${messages}`
          setMainView(ctx.taskId, 'session')
          setChatPrefillRequest({ text })
        }
        actions.appendChild(askBtn)
        dom.appendChild(actions)
      }

      // resize:false prevents CodeMirror from rewriting dom.style.height on
      // every measure pass. Without it, our overflow:auto scroll event
      // triggers another measure, which CM answers by resizing the tooltip
      // again — a feedback loop that manifests as a slow "animation" while
      // the popup settles. Our inline maxWidth/maxHeight already handle
      // containment.
      return { dom, resize: false }
    },
  }
}, { hideOn: tr => tr.docChanged })

const mergedHoverTheme = EditorView.theme({
  '.cm-merged-hover': {
    display: 'flex',
    flexDirection: 'column',
    fontSize: '12.5px',
    lineHeight: '1.5',
    color: '#abb2bf',
    userSelect: 'text',
    WebkitUserSelect: 'text',
    cursor: 'text',
    minHeight: '0',
  },
  '.cm-merged-hover *': {
    userSelect: 'text',
    WebkitUserSelect: 'text',
  },
  '.cm-merged-hover-scroll': {
    flex: '1 1 auto',
    minHeight: '0',
    overflow: 'auto',
    padding: '6px 0',
  },
  '.cm-merged-hover-errors': {
    padding: '2px 10px 6px',
  },
  '.cm-merged-hover-diagnostic': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '7px',
    padding: '2px 0',
  },
  '.cm-merged-hover-dot': {
    display: 'inline-block',
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    marginTop: '6px',
    flexShrink: '0',
  },
  '.cm-merged-hover-error .cm-merged-hover-dot': { backgroundColor: '#f87171' },
  '.cm-merged-hover-warning .cm-merged-hover-dot': { backgroundColor: '#fbbf24' },
  '.cm-merged-hover-info .cm-merged-hover-dot': { backgroundColor: '#60a5fa' },
  '.cm-merged-hover-hint .cm-merged-hover-dot': { backgroundColor: '#6b7280' },
  '.cm-merged-hover-message': {
    flex: '1',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  '.cm-merged-hover-error .cm-merged-hover-message': { color: '#fca5a5' },
  '.cm-merged-hover-warning .cm-merged-hover-message': { color: '#fcd34d' },
  '.cm-merged-hover-meta': {
    color: '#6b7280',
    fontSize: '11px',
    marginLeft: '4px',
    flexShrink: '0',
  },
  '.cm-merged-hover-actions': {
    flex: '0 0 auto',
    padding: '6px 10px',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '6px',
    borderTop: '1px solid #181a1f',
    backgroundColor: '#21252b',
  },
  '.cm-merged-hover-ask': {
    fontSize: '11.5px',
    padding: '3px 8px',
    borderRadius: '4px',
    border: '1px solid #3e4452',
    backgroundColor: '#2c313a',
    color: '#abb2bf',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  '.cm-merged-hover-ask:hover': {
    backgroundColor: '#3a3f4b',
    borderColor: '#528bff',
    color: '#e6e6e6',
  },
  '.cm-merged-hover-divider': {
    height: '1px',
    backgroundColor: '#3e4452',
    margin: '4px 0',
  },
  '.cm-merged-hover-type': {
    padding: '4px 10px',
  },
  '.cm-merged-hover-type p': { margin: '2px 0' },
  '.cm-merged-hover-type pre': {
    margin: '4px 0',
    padding: '6px 8px',
    backgroundColor: '#1e1e1e',
    borderRadius: '4px',
    overflow: 'auto',
  },
  '.cm-merged-hover-type code': {
    fontFamily: '"SF Mono", "Cascadia Code", "JetBrains Mono", "Fira Code", monospace',
    fontSize: '12px',
  },
}, { dark: true })

// ── Language detection ─────────────────────────────────────────────────
export function langFromExt(path: string): Extension | null {
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
function buildExtensions(taskId: string, path: string, onDocChange: (content: string) => void, onSave: () => void): Extension[] {
  const exts: Extension[] = [
    // Theme & highlighting
    verunTheme,
    searchPanelTheme,
    renameWidgetTheme,
    renameTooltipField,
    hoverUnderlineTheme,
    hoverUnderlineField,
    mergedHoverTheme,
    mergedHoverTooltip,
    editorContextFacet.of({ taskId, relativePath: path }),
    // Clamp tooltip positioning to the editor bounds so hover popups never
    // overflow into adjacent panels (problems panel, sidebar, etc).
    tooltips({
      tooltipSpace: (view) => {
        const r = view.dom.getBoundingClientRect()
        return { top: r.top + 4, left: r.left + 4, bottom: r.bottom - 4, right: r.right - 4 }
      },
    }),
    // Suppress @codemirror/lint's built-in diagnostic hover tooltip so it
    // doesn't stack on top of our merged tooltip. Squigglies still render.
    linter(null, { tooltipFilter: () => [] }),
    syntaxHighlighting(verunHighlightStyle),
    syntaxHighlighting(oneDarkHighlightStyle, { fallback: true }),

    // Core editor features
    lineNumbers(),
    selectionAwareActiveLine(),
    selectionAwareActiveLineGutter(),
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
        // Move cursor to right-click position so Go to Definition works on the right word,
        // but preserve an existing selection if the click landed inside it (so Copy works).
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos != null) {
          const sel = view.state.selection.main
          const inside = !sel.empty && pos >= sel.from && pos <= sel.to
          if (!inside) {
            view.dispatch({ selection: { anchor: pos } })
          }
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

// ── Editor state cache — preserves cursor, selection, and undo/redo across tab switches.
// We cache a JSON snapshot (not the EditorState itself) so we can rebuild a fresh
// state with live extensions on restore. Caching the EditorState directly leaks
// stale references (e.g. the LSP plugin ties to a specific LSPClient instance).
type CachedSnapshot = { doc: string; state: any /* serialized by toJSON */ }
const editorStateCache = new Map<string, CachedSnapshot>()
const scrollPositionCache = new Map<string, { top: number; left: number }>()

function cacheKey(taskId: string, relativePath: string) {
  return `${taskId}:${relativePath}`
}

function snapshotEditorState(key: string, view: EditorView) {
  editorStateCache.set(key, {
    doc: view.state.doc.toString(),
    state: view.state.toJSON({ history: historyField }),
  })
  scrollPositionCache.set(key, {
    top: view.scrollDOM.scrollTop,
    left: view.scrollDOM.scrollLeft,
  })
}

export function clearEditorStateCache(taskId: string, relativePath: string) {
  const key = cacheKey(taskId, relativePath)
  editorStateCache.delete(key)
  scrollPositionCache.delete(key)
}

/** Clear all cached editor state for a task (call on task deletion/archive). */
export function clearAllEditorStateForTask(taskId: string) {
  const prefix = `${taskId}:`
  for (const key of editorStateCache.keys()) {
    if (key.startsWith(prefix)) editorStateCache.delete(key)
  }
  for (const key of scrollPositionCache.keys()) {
    if (key.startsWith(prefix)) scrollPositionCache.delete(key)
  }
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
  // Current cache key for saving/restoring editor state
  let currentFileKey = ''

  const snapshotCurrentEditor = () => {
    if (!editorView || !currentFileKey) return
    snapshotEditorState(currentFileKey, editorView)
  }

  // Clear editor state cache when a tab is closed or task is deleted
  const unsubTabClose = onTabClose(clearEditorStateCache)
  const unsubTaskCleanup = onTaskCleanup(clearAllEditorStateForTask)
  const unsubBeforeActiveEditorChange = onBeforeActiveEditorChange((taskId, relativePath) => {
    if (taskId !== props.taskId) return
    if (relativePath !== props.relativePath) return
    if (mainView(props.taskId) !== props.relativePath) return
    snapshotCurrentEditor()
  })
  onCleanup(() => { unsubTabClose(); unsubTaskCleanup(); unsubBeforeActiveEditorChange() })

  const save = async () => {
    try {
      const task = await ipc.getTask(props.taskId)
      if (task) {
        const ok = await checkBeforeSave(props.taskId, props.relativePath, task.worktreePath, currentContent)
        if (!ok) return // conflict dialog is now showing; resolution writes the file
      }
      await ipc.writeTextFile(props.taskId, props.relativePath, currentContent)
      setOriginalContent(currentContent)
      setCachedOriginal(props.taskId, props.relativePath, currentContent)
      setTabDirty(props.taskId, props.relativePath, false)
    } catch (e) {
      console.error('Save failed:', e)
    }
  }

  // ── Go-to-line ──────────────────────────────────────────────────────
  // Scrolls the editor to a specific line/column and focuses it.
  const goToLine = (line: number, column: number) => {
    if (!editorView) return
    const l = Math.min(line, editorView.state.doc.lines)
    const lineInfo = editorView.state.doc.line(l)
    const col = Math.min(column - 1, lineInfo.length)
    const pos = lineInfo.from + col
    editorView.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    editorView.focus()
  }

  // Drains the pendingGoToLine signal if it targets this file.
  const drainPendingGoToLine = () => {
    const req = pendingGoToLine(props.taskId)
    if (!req || req.relativePath !== props.relativePath) return
    if (!editorView) return
    consumeGoToLine(props.taskId)
    goToLine(req.line, req.column)
  }

  // ── Editor lifecycle ──────────────────────────────────────────────
  const createEditor = async (doc: string, path: string, worktreePath: string) => {
    // Save outgoing editor snapshot (selection + history) as JSON so we can
    // rebuild with fresh extensions on restore — caching EditorState directly
    // pins stale plugin references (notably the LSP plugin's LSPClient).
    snapshotCurrentEditor()

    // Destroy previous instance
    if (editorView) {
      if (currentFileUri) unregisterEditorView(currentFileUri)
      editorView.destroy()
      editorView = undefined
    }

    if (!editorParentRef) return

    const newKey = cacheKey(props.taskId, path)
    currentFileKey = newKey

    // Always build fresh extensions so the LSP plugin is wired to the current
    // live LSPClient, and the view/workspace references are fresh.
    const extensions = buildExtensions(
      props.taskId,
      path,
      (content) => {
        currentContent = content
        setCachedContent(props.taskId, props.relativePath, content)
        setTabDirty(props.taskId, props.relativePath, content !== originalContent())
      },
      save,
    )

    // Add LSP plugin with correct languageId for JS/TS files.
    if (isLspSupported(path)) {
      try {
        const client = await getLspClient(props.taskId, worktreePath)
        const fileUri = `file://${worktreePath}/${path}`
        const ext = path.split('.').pop()?.toLowerCase() || ''
        const languageId = ext === 'tsx' ? 'typescriptreact'
          : ext === 'jsx' ? 'javascriptreact'
          : ['mjs', 'cjs', 'js'].includes(ext) ? 'javascript'
          : 'typescript'
        extensions.push(client.plugin(fileUri, languageId))
      } catch (e) {
        console.warn('LSP not available:', e)
      }
    }

    // Restore selection + history from the cached snapshot if the doc still matches.
    const cached = editorStateCache.get(newKey)
    let state: EditorState
    if (cached && cached.doc === doc) {
      try {
        state = EditorState.fromJSON(cached.state, { doc, extensions }, { history: historyField })
      } catch {
        state = EditorState.create({ doc, extensions })
      }
    } else {
      state = EditorState.create({ doc, extensions })
    }

    editorView = new EditorView({ state, parent: editorParentRef })

    // Restore scroll position after DOM layout
    const savedScroll = scrollPositionCache.get(newKey)
    if (savedScroll) {
      requestAnimationFrame(() => {
        editorView?.scrollDOM.scrollTo(savedScroll.left, savedScroll.top)
      })
    }

    if (worktreePath) {
      currentFileUri = `file://${worktreePath}/${path}`
      registerEditorView(currentFileUri, editorView)
    }

    // Apply any pending go-to-line now that the editor is ready
    drainPendingGoToLine()

    // Auto-focus the editor so the cursor is visible and keyboard input works
    editorView.focus()
  }

  // Load file content and (re)create the editor when the file changes
  // Also reruns when fileSync bumps the reload nonce after an external edit.
  createEffect(on(
    [() => props.relativePath, () => reloadNonce(props.taskId, props.relativePath)],
    async ([path]) => {
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
      // Loading from disk — clear any stale editor state
      clearEditorStateCache(props.taskId, path)
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

  // Cleanup — save state before destroying so it survives component remount
  onCleanup(() => {
    snapshotCurrentEditor()
    if (currentFileUri) unregisterEditorView(currentFileUri)
    if (editorView) {
      editorView.destroy()
      editorView = undefined
    }
  })

  // React to go-to-line requests for the file already shown (no editor recreation)
  createEffect(() => {
    const req = pendingGoToLine(props.taskId)
    void props.relativePath // track so effect re-fires on file switch
    if (!req || !editorView) return
    drainPendingGoToLine()
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
    editorView.focus()
  }

  const handleCopy = () => {
    if (!editorView) return
    const { from, to } = editorView.state.selection.main
    const sel = editorView.state.sliceDoc(from, to)
    if (sel) navigator.clipboard.writeText(sel)
    setContextMenu(null)
    editorView.focus()
  }

  const handlePaste = async () => {
    if (!editorView) return
    const text = await navigator.clipboard.readText()
    editorView.dispatch(editorView.state.replaceSelection(text))
    setContextMenu(null)
    editorView.focus()
  }

  const handleSelectAll = () => {
    if (!editorView) return
    editorView.dispatch({ selection: { anchor: 0, head: editorView.state.doc.length } })
    setContextMenu(null)
    editorView.focus()
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
      <ContextMenu
        open={!!contextMenu()}
        onClose={() => setContextMenu(null)}
        pos={contextMenu() || undefined}
        minWidth="min-w-44"
        items={[
          { label: 'Go to Definition', shortcut: 'F12', action: handleGoToDefinition },
          { label: 'Find References', shortcut: 'Shift+F12', action: handleFindReferences },
          { label: 'Rename Symbol', shortcut: 'F2', action: handleRenameSymbol },
          { separator: true },
          { label: 'Cut', shortcut: '\u2318X', action: handleCut, disabled: !hasSelection() },
          { label: 'Copy', shortcut: '\u2318C', action: handleCopy, disabled: !hasSelection() },
          { label: 'Paste', shortcut: '\u2318V', action: handlePaste },
          { separator: true },
          { label: 'Select All', shortcut: '\u2318A', action: handleSelectAll },
          { separator: true },
          { label: 'Find', shortcut: '\u2318F', action: handleFind },
          { label: 'Find and Replace', shortcut: '\u2318H', action: handleFind },
          { separator: true },
          { label: 'Copy Relative Path', action: handleCopyPath },
          { label: 'Reveal in Finder', action: handleRevealInFinder },
        ]}
      />
    </div>
  )
}
