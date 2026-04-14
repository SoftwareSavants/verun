import { Component, createSignal, createEffect, on, onCleanup, Show } from 'solid-js'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers, drawSelection, highlightSpecialChars, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, foldGutter, bracketMatching, indentOnInput } from '@codemirror/language'
import { search, searchKeymap } from '@codemirror/search'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { Loader2, AlertCircle, Columns2, Rows2, FileText } from 'lucide-solid'
import * as ipc from '../lib/ipc'
import type { DiffContents } from '../types'
import { openFilePinned, type DiffSource } from '../store/files'
import { langFromExt, verunTheme, verunHighlightStyle, selectionAwareActiveLine } from './CodeEditor'
import { BreadcrumbBar } from './BreadcrumbBar'
import { createSearchPanel, searchPanelTheme } from './SearchPanel'

interface Props {
  taskId: string
  source: DiffSource
  relativePath: string
}

const STATUS_LABELS: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed' }
const STATUS_COLORS: Record<string, string> = {
  A: 'text-emerald-400',
  M: 'text-amber-400',
  D: 'text-red-400',
  R: 'text-blue-400',
}

// Override @codemirror/merge's default change indicators (a 2px bottom
// gradient that reads as a wavy underline) with solid GitHub/VS Code-style
// background fills on changed lines and per-character changes.
const mergeOverrideTheme = EditorView.theme({
  // Per-character changes — solid background, no underline gradient
  '&.cm-merge-a .cm-changedText, &.cm-merge-a .cm-deletedChunk .cm-deletedText, & .cm-deletedChunk .cm-deletedText': {
    background: 'rgba(248, 81, 73, 0.4)',
    backgroundImage: 'none',
  },
  '&.cm-merge-b .cm-changedText': {
    background: 'rgba(63, 185, 80, 0.4)',
    backgroundImage: 'none',
  },
  '&.cm-merge-b .cm-deletedText': {
    background: 'rgba(248, 81, 73, 0.4)',
    backgroundImage: 'none',
  },
  // Whole-line tinting
  '&.cm-merge-a .cm-changedLine, & .cm-deletedChunk, & .cm-deletedLine': {
    backgroundColor: 'rgba(248, 81, 73, 0.12)',
  },
  '&.cm-merge-b .cm-changedLine, & .cm-inlineChangedLine, & .cm-insertedLine': {
    backgroundColor: 'rgba(63, 185, 80, 0.12)',
  },
  // Gutter markers
  '&.cm-merge-a .cm-changedLineGutter, & .cm-deletedLineGutter': {
    background: 'rgba(248, 81, 73, 0.6)',
  },
  '&.cm-merge-b .cm-changedLineGutter': {
    background: 'rgba(63, 185, 80, 0.6)',
  },
})

function buildSideExtensions(path: string, readOnly: boolean): Extension[] {
  const lang = langFromExt(path)
  return [
    verunTheme,
    mergeOverrideTheme,
    searchPanelTheme,
    syntaxHighlighting(verunHighlightStyle),
    syntaxHighlighting(oneDarkHighlightStyle, { fallback: true }),
    lineNumbers(),
    selectionAwareActiveLine(),
    highlightSpecialChars(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    foldGutter({ openText: '\u25BE', closedText: '\u25B8' }),
    history(),
    search({ top: true, createPanel: createSearchPanel }),
    EditorView.lineWrapping,
    EditorState.readOnly.of(readOnly),
    keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
    ...(lang ? [lang] : []),
  ]
}

export const DiffEditor: Component<Props> = (props) => {
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [contents, setContents] = createSignal<DiffContents | null>(null)
  const [orientation, setOrientation] = createSignal<'a-b' | 'inline'>('a-b')

  let containerEl: HTMLDivElement | undefined
  let mergeView: MergeView | undefined
  let unifiedView: EditorView | undefined
  let detachAnchor: (() => void) | undefined

  // Keep the visible spot pinned when the user expands a "X unchanged lines"
  // collapsed region. Two gotchas:
  //   1. CodeMirror disables overflow-anchor on its scroller, so the browser
  //      won't auto-pin content when the doc grows above the viewport.
  //   2. In MergeView, each side's `.cm-scroller` has `overflow-y: visible`
  //      and the actual scrolling happens on the outer wrapper. So
  //      `view.scrollDOM` is not the right element to adjust — we have to
  //      walk up to the nearest real scroll container.
  const findScroller = (el: HTMLElement): HTMLElement | null => {
    let cur: HTMLElement | null = el
    while (cur) {
      const s = getComputedStyle(cur)
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight) return cur
      cur = cur.parentElement
    }
    return null
  }

  const installScrollAnchor = (root: HTMLElement) => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      const pill = target?.closest('.cm-collapsedLines') as HTMLElement | null
      if (!pill) return
      const view = EditorView.findFromDOM(pill)
      if (!view) return
      const pos = view.posAtDOM(pill)
      const scroller = findScroller(pill)
      if (!scroller) return
      const oldTop = pill.getBoundingClientRect().top
      const oldScrollTop = scroller.scrollTop

      // The merge view dispatches the uncollapse on both sibling editors and
      // re-measures asynchronously. A single rAF can land before the layout
      // settles, so retry until coordsAtPos returns a stable answer (or we
      // give up after a few frames).
      let tries = 0
      const reanchor = () => {
        tries++
        const coords = view.coordsAtPos(pos)
        if (!coords) {
          if (tries < 6) requestAnimationFrame(reanchor)
          return
        }
        const newTop = coords.top
        const delta = newTop - oldTop
        if (Math.abs(delta) < 0.5) return
        scroller.scrollTop = oldScrollTop + delta
        if (tries < 4) requestAnimationFrame(reanchor)
      }
      requestAnimationFrame(reanchor)
    }
    root.addEventListener('mousedown', onMouseDown, true)
    return () => root.removeEventListener('mousedown', onMouseDown, true)
  }

  const sourceKey = () => {
    const s = props.source
    return s.type === 'commit' ? `c:${s.commitHash}` : 'w'
  }

  const fetchContents = async () => {
    setLoading(true)
    setError(null)
    try {
      const c = props.source.type === 'commit'
        ? await ipc.getCommitFileContents(props.taskId, props.source.commitHash, props.relativePath)
        : await ipc.getFileDiffContents(props.taskId, props.relativePath)
      setContents(c)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const destroy = () => {
    if (detachAnchor) { detachAnchor(); detachAnchor = undefined }
    if (mergeView) { mergeView.destroy(); mergeView = undefined }
    if (unifiedView) { unifiedView.destroy(); unifiedView = undefined }
  }

  const mount = () => {
    destroy()
    const c = contents()
    if (!c || !containerEl || c.binary) return
    const orient = orientation()
    if (orient === 'inline') {
      unifiedView = new EditorView({
        state: EditorState.create({
          doc: c.newText,
          extensions: [
            ...buildSideExtensions(props.relativePath, true),
            unifiedMergeView({
              original: c.oldText,
              highlightChanges: true,
              gutter: true,
              mergeControls: false,
              collapseUnchanged: { margin: 3, minSize: 4 },
            }),
          ],
        }),
        parent: containerEl,
      })
      detachAnchor = installScrollAnchor(containerEl)
      return
    }
    detachAnchor = installScrollAnchor(containerEl)
    mergeView = new MergeView({
      a: { doc: c.oldText, extensions: buildSideExtensions(props.relativePath, true) },
      b: { doc: c.newText, extensions: buildSideExtensions(props.relativePath, true) },
      parent: containerEl,
      orientation: 'a-b',
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    })
  }

  createEffect(on(() => [props.taskId, props.relativePath, sourceKey()], fetchContents))
  createEffect(on(contents, mount))
  createEffect(on(orientation, mount, { defer: true }))
  onCleanup(destroy)

  return (
    <div class="flex flex-col h-full">
      <div class="flex items-center gap-2 px-3 py-1.5 shrink-0">
        <BreadcrumbBar taskId={props.taskId} currentPath={props.relativePath} />
        <Show when={contents()}>
          <span class={`text-[11px] font-medium ${STATUS_COLORS[contents()!.status] || 'text-text-dim'}`}>
            {STATUS_LABELS[contents()!.status] || contents()!.status}
          </span>
        </Show>
        <Show when={props.source.type === 'commit'}>
          <span class="text-[11px] text-text-dim font-mono">
            @ {(props.source as { type: 'commit'; commitHash: string }).commitHash.slice(0, 7)}
          </span>
        </Show>
        <div class="flex-1" />
        <button
          class="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-text-dim hover:text-text-secondary hover:bg-surface-2 transition-colors"
          title="Open file"
          onClick={() => {
            const name = props.relativePath.split('/').pop() ?? props.relativePath
            openFilePinned(props.taskId, props.relativePath, name)
          }}
        >
          <FileText size={12} />
          Open file
        </button>
        <div class="flex items-center bg-surface-2 rounded-md p-0.5 gap-0.5">
          <button
            class={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
              orientation() !== 'inline' ? 'bg-surface-3 text-text-secondary' : 'text-text-dim hover:text-text-muted'
            }`}
            onClick={() => setOrientation('a-b')}
            title="Side by side"
          >
            <Columns2 size={12} />
            Side by side
          </button>
          <button
            class={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
              orientation() === 'inline' ? 'bg-surface-3 text-text-secondary' : 'text-text-dim hover:text-text-muted'
            }`}
            onClick={() => setOrientation('inline')}
            title="Inline"
          >
            <Rows2 size={12} />
            Inline
          </button>
        </div>
      </div>

      <Show when={loading()}>
        <div class="flex-1 flex items-center justify-center">
          <Loader2 size={24} class="animate-spin text-text-dim" />
        </div>
      </Show>

      <Show when={error()}>
        <div class="flex-1 flex flex-col items-center justify-center gap-2 text-text-dim">
          <AlertCircle size={24} />
          <span class="text-xs">{error()}</span>
        </div>
      </Show>

      <Show when={!loading() && !error() && contents()?.binary}>
        <div class="flex-1 flex flex-col items-center justify-center gap-2 text-text-dim">
          <AlertCircle size={20} />
          <span class="text-xs">Binary file — no preview</span>
        </div>
      </Show>

      <div
        ref={containerEl}
        class="diff-editor-host flex-1 overflow-auto"
        style={{ display: !loading() && !error() && !contents()?.binary ? '' : 'none' }}
      />
    </div>
  )
}
