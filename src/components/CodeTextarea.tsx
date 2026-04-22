import { Component, createEffect, on, onCleanup, onMount } from 'solid-js'
import { EditorView, keymap, placeholder as placeholderExt, tooltips } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { autocompletion, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { verunHighlightStyle } from './verunHighlightStyle'
import { modPressed } from '../lib/platform'

interface Props {
  value: string
  onInput: (value: string) => void
  onSave?: () => void
  placeholder?: string
  minRows?: number
  maxRows?: number
}

export interface VerunCompletionCandidate {
  label: string
  detail: string
}

// Mirrors the env vars Rust injects into hooks + start commands (see
// `verun_env_vars` in src-tauri/src/worktree.rs). Keep in sync.
export const VERUN_ENV_VARS: VerunCompletionCandidate[] = [
  { label: '$VERUN_REPO_PATH', detail: 'absolute path to the main repo' },
  ...Array.from({ length: 10 }, (_, i) => ({
    label: `$VERUN_PORT_${i}`,
    detail: i === 0 ? 'primary allocated port for this task' : `additional allocated port #${i}`,
  })),
]

export function findDollarTokenStart(textBeforeCursor: string): number {
  let i = textBeforeCursor.length - 1
  while (i >= 0 && /[A-Za-z0-9_]/.test(textBeforeCursor[i])) i--
  if (i >= 0 && textBeforeCursor[i] === '$') return i
  return -1
}

function verunEnvCompletions(context: CompletionContext): CompletionResult | null {
  const before = context.state.doc.sliceString(0, context.pos)
  const start = findDollarTokenStart(before)
  if (start < 0) return null
  return {
    from: start,
    options: VERUN_ENV_VARS.map(v => ({
      label: v.label,
      type: 'variable',
      detail: v.detail,
    })),
    validFor: /^\$[A-Za-z0-9_]*$/,
  }
}

const LINE_H = 20
const PAD = 16

const shellLanguage = StreamLanguage.define(shell)

const baseTheme = EditorView.theme({
  '&': {
    fontSize: 'var(--font-code-size, 13px)',
    fontFamily: 'var(--font-code, ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace)',
    color: 'var(--text-secondary)',
    backgroundColor: 'var(--surface-1)',
    borderRadius: '8px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { lineHeight: `${LINE_H}px`, padding: '0', overflow: 'auto' },
  '.cm-content': { padding: '8px 12px', caretColor: 'var(--text-primary)' },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'var(--text-dim)' },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--surface-2)',
    border: '1px solid var(--border-default)',
    borderRadius: '6px',
    boxShadow: '0 6px 24px rgb(0 0 0 / 0.25)',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '4px 10px',
    color: 'var(--text-secondary)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'rgb(var(--accent-rgb) / 0.22)',
    color: 'var(--text-primary)',
  },
  '.cm-completionLabel': { fontFamily: 'var(--font-code)' },
  '.cm-completionDetail': {
    color: 'var(--text-muted)',
    fontStyle: 'normal',
    marginLeft: '10px',
  },
})

export const CodeTextarea: Component<Props> = (props) => {
  let hostEl!: HTMLDivElement
  let view: EditorView | undefined

  const applyRowConstraints = () => {
    if (!hostEl) return
    const minH = (props.minRows ?? 1) * LINE_H + PAD
    const maxH = props.maxRows ? props.maxRows * LINE_H + PAD : undefined
    hostEl.style.minHeight = `${minH}px`
    if (maxH) hostEl.style.maxHeight = `${maxH}px`
    else hostEl.style.removeProperty('max-height')
  }

  onMount(() => {
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        baseTheme,
        shellLanguage,
        syntaxHighlighting(verunHighlightStyle),
        history(),
        placeholderExt(props.placeholder ?? ''),
        EditorView.lineWrapping,
        tooltips({ position: 'fixed', parent: document.body }),
        autocompletion({
          override: [verunEnvCompletions],
          icons: false,
        }),
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              props.onSave?.()
              return true
            },
          },
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) props.onInput(update.state.doc.toString())
        }),
      ],
    })
    view = new EditorView({ state, parent: hostEl })
    applyRowConstraints()
  })

  // Sync external value changes (form reset, auto-detect fill) into the editor.
  createEffect(on(() => props.value, (v) => {
    if (!view) return
    const current = view.state.doc.toString()
    if (v !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: v } })
    }
  }, { defer: true }))

  createEffect(on(() => [props.minRows, props.maxRows], applyRowConstraints, { defer: true }))

  onCleanup(() => { view?.destroy(); view = undefined })

  return (
    <div
      ref={hostEl}
      class="code-textarea w-full rounded-lg bg-surface-1 ring-1 ring-outline/8 focus-within:ring-accent/40 overflow-hidden"
      onKeyDown={(e) => {
        // Cmd/Ctrl+Enter dispatched at DOM level in case the CM keymap is
        // shadowed by an outer handler; the CM keymap also handles it.
        if (modPressed(e) && e.key === 'Enter') {
          e.preventDefault()
          props.onSave?.()
        }
      }}
    />
  )
}
