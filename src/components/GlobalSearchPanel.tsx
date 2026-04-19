import { Component, createEffect, createMemo, For, on, onCleanup, onMount, Show } from 'solid-js'
import { createVirtualizer } from '@tanstack/solid-virtual'
import { ChevronDown, ChevronRight, Ellipsis, Loader2 } from 'lucide-solid'
import { getFileIcon } from '../lib/fileIcons'
import { openFile, openFilePinned, setPendingGoToLine } from '../store/editorView'
import { focusSearchRequest, rightPanelTab } from '../store/ui'
import {
  type SearchMatch,
  addCollapsed,
  clearSearchResults,
  collapseAll as collapseAllPaths,
  ensureWorkspaceSearchListeners,
  expandAll as expandAllPaths,
  isCollapsed,
  removeCollapsed,
  searchState,
  setSearchBusy,
  setSearchCaseSensitive,
  setSearchError,
  setSearchExcludes,
  setSearchIncludes,
  setSearchQuery,
  setSearchSelectedIndex,
  setSearchShowFilters,
  setSearchUseRegex,
  setSearchWholeWord,
  toggleCollapsed,
} from '../store/workspaceSearch'
import * as ipc from '../lib/ipc'

interface Props {
  taskId: string
}

const GROUP_H = 26
const MATCH_H = 22

function parseGlobs(s: string): string[] {
  return s.split(',').map(p => p.trim()).filter(Boolean)
}

export const GlobalSearchPanel: Component<Props> = (props) => {
  const s = () => searchState(props.taskId)

  let inputRef: HTMLInputElement | undefined
  let scrollRef: HTMLDivElement | undefined
  let rootRef: HTMLDivElement | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  ensureWorkspaceSearchListeners()

  const runSearch = () => {
    const q = s().query
    setSearchError(props.taskId, null)
    clearSearchResults(props.taskId)
    if (q.length < 2) {
      setSearchBusy(props.taskId, false)
      ipc.workspaceSearchCancel(props.taskId).catch(() => {})
      return
    }
    setSearchBusy(props.taskId, true)
    ipc.workspaceSearchStart(props.taskId, q, {
      caseSensitive: s().caseSensitive,
      wholeWord: s().wholeWord,
      regex: s().useRegex,
      includes: parseGlobs(s().includes),
      excludes: parseGlobs(s().excludes),
    }).catch(err => {
      setSearchBusy(props.taskId, false)
      setSearchError(props.taskId, String(err))
    })
  }

  const scheduleSearch = () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(runSearch, 150)
  }

  onMount(() => {
    onCleanup(() => {
      if (debounceTimer) clearTimeout(debounceTimer)
    })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => inputRef?.focus())
    })
    // Cold-mount with a pre-seeded query (e.g. Cmd+Shift+F with selection while
    // the panel was unmounted). The deps effect is deferred so it won't fire on
    // initial read — run the search directly here instead.
    if (s().query.length >= 2 && s().matches.length === 0 && !s().busy && !s().done) {
      runSearch()
    }
  })

  // Switching tasks changes every `s().*` dep at once because `s()` now reads
  // a different task's slice. We must NOT treat that as a user edit — results
  // are already cached in the store. lastTaskId lets us detect the switch and
  // rebase without re-running the search or clobbering the selected index.
  let lastTaskId: string = props.taskId

  createEffect(on([
    () => props.taskId,
    () => s().query,
    () => s().caseSensitive,
    () => s().wholeWord,
    () => s().useRegex,
    () => s().includes,
    () => s().excludes,
  ], ([taskId]) => {
    if (taskId !== lastTaskId) {
      lastTaskId = taskId
      return
    }
    scheduleSearch()
  }, { defer: true }))

  createEffect(on(focusSearchRequest, (tick) => {
    if (tick === 0) return
    requestAnimationFrame(() => {
      inputRef?.focus()
      inputRef?.select()
    })
  }, { defer: true }))

  createEffect(on([() => props.taskId, () => s().query], ([taskId]) => {
    if (taskId !== lastTaskId) return
    setSearchSelectedIndex(props.taskId, -1)
  }, { defer: true }))

  type Group = { path: string; matches: SearchMatch[] }
  const groups = createMemo<Group[]>(() => {
    const out: Group[] = []
    const idx = new Map<string, number>()
    for (const m of s().matches) {
      let i = idx.get(m.path)
      if (i === undefined) {
        i = out.length
        idx.set(m.path, i)
        out.push({ path: m.path, matches: [] })
      }
      out[i].matches.push(m)
    }
    return out
  })

  type Row =
    | { kind: 'group'; groupIdx: number; h: number }
    | { kind: 'match'; groupIdx: number; matchIdx: number; h: number }
  const rows = createMemo<Row[]>(() => {
    const gs = groups()
    const out: Row[] = []
    for (let i = 0; i < gs.length; i++) {
      out.push({ kind: 'group', groupIdx: i, h: GROUP_H })
      if (isCollapsed(props.taskId, gs[i].path)) continue
      for (let j = 0; j < gs[i].matches.length; j++) {
        out.push({ kind: 'match', groupIdx: i, matchIdx: j, h: MATCH_H })
      }
    }
    return out
  })

  const virtualizer = createVirtualizer({
    get count() { return rows().length },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: (i) => rows()[i]?.h ?? MATCH_H,
    overscan: 15,
  })

  const openMatch = (m: SearchMatch, pinned: boolean) => {
    const name = m.path.split('/').pop() || m.path
    if (pinned) openFilePinned(props.taskId, m.path, name)
    else openFile(props.taskId, m.path, name)
    setPendingGoToLine({
      taskId: props.taskId,
      relativePath: m.path,
      line: m.lineNumber || 1,
      column: (m.matchSpans[0]?.[0] ?? 0) + 1,
      preserveFocus: !pinned,
    })
  }

  const navigateTo = (idx: number) => {
    const rs = rows()
    if (idx < 0 || idx >= rs.length) return
    setSearchSelectedIndex(props.taskId, idx)
    virtualizer.scrollToIndex(idx, { align: 'auto' })
    const r = rs[idx]
    if (r.kind === 'match') {
      const m = groups()[r.groupIdx]?.matches[r.matchIdx]
      if (m) openMatch(m, false)
    }
    // Focus the stable scroll container (never recycled by virtualizer) so
    // arrow keys keep working without stealing text-nav from the query input.
    scrollRef?.focus()
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (rightPanelTab() !== 'search') return
      const target = e.target as Node | null
      if (!target || !rootRef || !rootRef.contains(target)) return

      const rs = rows()
      if (rs.length === 0) return
      const idx = s().selectedIndex
      const item = idx >= 0 && idx < rs.length ? rs[idx] : null
      const mod = e.metaKey || e.ctrlKey
      const inInput = (e.target as HTMLElement).tagName === 'INPUT'

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          navigateTo(idx < 0 ? 0 : Math.min(idx + 1, rs.length - 1))
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          navigateTo(Math.max(idx - 1, 0))
          break
        }
        case 'ArrowLeft': {
          // In the input, always let native text nav handle it (mid-text or
          // modifier shortcuts like cmd+left for start-of-line). Only intercept
          // at caret=0 with no modifier so arrow-left from an empty/start caret
          // can jump back to collapse state.
          if (inInput) {
            if (mod) return
            const caretStart = inputRef?.selectionStart ?? 0
            const caretEnd = inputRef?.selectionEnd ?? 0
            if (caretStart !== 0 || caretEnd !== 0) return
          }
          e.preventDefault()
          if (mod) {
            collapseAllPaths(props.taskId, groups().map(g => g.path))
            if (item) {
              const fileIdx = rs.findIndex(r => r.kind === 'group' && r.groupIdx === item.groupIdx)
              if (fileIdx >= 0) { setSearchSelectedIndex(props.taskId, fileIdx); virtualizer.scrollToIndex(fileIdx, { align: 'auto' }) }
            }
          } else if (item) {
            const g = groups()[item.groupIdx]
            if (g) {
              const fileIdx = rs.findIndex(r => r.kind === 'group' && r.groupIdx === item.groupIdx)
              addCollapsed(props.taskId, g.path)
              if (fileIdx >= 0) { setSearchSelectedIndex(props.taskId, fileIdx); virtualizer.scrollToIndex(fileIdx, { align: 'auto' }) }
            }
          }
          break
        }
        case 'ArrowRight': {
          if (inInput) {
            if (mod) return
            const len = inputRef?.value.length ?? 0
            const caretStart = inputRef?.selectionStart ?? 0
            const caretEnd = inputRef?.selectionEnd ?? 0
            if (caretStart !== len || caretEnd !== len) return
          }
          e.preventDefault()
          if (mod) expandAllPaths(props.taskId)
          else if (item?.kind === 'group') {
            const path = groups()[item.groupIdx].path
            if (isCollapsed(props.taskId, path)) removeCollapsed(props.taskId, path)
            else {
              const next = idx + 1
              if (next < rs.length && rs[next].kind === 'match') navigateTo(next)
            }
          }
          break
        }
        case 'Enter': {
          e.preventDefault()
          if (item?.kind === 'group') toggleCollapsed(props.taskId, groups()[item.groupIdx].path)
          else if (item?.kind === 'match') {
            const m = groups()[item.groupIdx]?.matches[item.matchIdx]
            if (m) openMatch(m, true)
          }
          break
        }
        case ' ': {
          if (inInput) return
          e.preventDefault()
          if (item?.kind === 'group') toggleCollapsed(props.taskId, groups()[item.groupIdx].path)
          else if (item?.kind === 'match') {
            const m = groups()[item.groupIdx]?.matches[item.matchIdx]
            if (m) openMatch(m, true)
          }
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  const statusText = () => {
    if (s().error) return s().error!
    if (s().busy) return 'Searching...'
    const d = s().done
    if (d) {
      if (d.totalMatches === 0) return s().query.length >= 2 ? 'No results' : ''
      const plus = d.truncated ? '+' : ''
      return `${d.totalMatches}${plus} result${d.totalMatches === 1 ? '' : 's'} in ${d.totalFiles}${plus} file${d.totalFiles === 1 ? '' : 's'}`
    }
    return ''
  }

  return (
    <div ref={rootRef} class="flex flex-col h-full text-text-secondary text-[12px]">
      <div class="px-3 pt-2 pb-1.5">
        <div class="relative bg-surface-2 rounded ring-1 ring-transparent focus-within:ring-accent/40">
          <input
            ref={inputRef}
            class="w-full bg-transparent text-text-primary px-2 py-1 pr-[74px] text-[12px] outline-none placeholder-text-dim"
            placeholder="Search"
            value={s().query}
            onInput={(e) => setSearchQuery(props.taskId, e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.currentTarget.blur() } }}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck={false}
          />
          <div class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
            <ToggleBtn active={s().caseSensitive} title="Match Case" onClick={() => setSearchCaseSensitive(props.taskId, !s().caseSensitive)}>Aa</ToggleBtn>
            <ToggleBtn active={s().wholeWord} title="Match Whole Word" onClick={() => setSearchWholeWord(props.taskId, !s().wholeWord)}>
              <span class="underline underline-offset-[-1px]">ab</span>
            </ToggleBtn>
            <ToggleBtn active={s().useRegex} title="Use Regular Expression" onClick={() => setSearchUseRegex(props.taskId, !s().useRegex)}>.*</ToggleBtn>
          </div>
        </div>
      </div>

      <div class="px-3 pb-1.5 flex items-center justify-end">
        <ToggleBtn active={s().showFilters} title="Toggle files to include/exclude" onClick={() => setSearchShowFilters(props.taskId, !s().showFilters)}>
          <Ellipsis size={12} />
        </ToggleBtn>
      </div>

      <Show when={s().showFilters}>
        <div class="px-3 pb-1.5 flex flex-col gap-1">
          <input
            class="bg-surface-2 text-text-primary rounded px-2 py-1 text-[11px] outline-none ring-1 ring-transparent focus:ring-accent/40 placeholder-text-dim"
            placeholder="files to include (e.g. src/**, *.ts)"
            value={s().includes}
            onInput={(e) => setSearchIncludes(props.taskId, e.currentTarget.value)}
            spellcheck={false}
          />
          <input
            class="bg-surface-2 text-text-primary rounded px-2 py-1 text-[11px] outline-none ring-1 ring-transparent focus:ring-accent/40 placeholder-text-dim"
            placeholder="files to exclude (e.g. *.test.ts, dist)"
            value={s().excludes}
            onInput={(e) => setSearchExcludes(props.taskId, e.currentTarget.value)}
            spellcheck={false}
          />
        </div>
      </Show>

      <div class="px-3 pb-1 text-[11px] text-text-dim flex items-center gap-1.5 min-h-[18px]">
        <Show when={s().busy}>
          <Loader2 size={11} class="animate-spin shrink-0" />
        </Show>
        <span class="truncate">{statusText()}</span>
      </div>

      <div
        ref={scrollRef}
        tabIndex={-1}
        class="flex-1 overflow-auto outline-none"
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
          <For each={virtualizer.getVirtualItems()}>
            {(vrow) => {
              const row = () => rows()[vrow.index]
              return (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${vrow.size}px`,
                    transform: `translateY(${vrow.start}px)`,
                  }}
                >
                  <Show when={row()?.kind === 'group'}>
                    {(() => {
                      const r = row() as Extract<Row, { kind: 'group' }>
                      const g = () => groups()[r.groupIdx]
                      const path = () => g()?.path ?? ''
                      const name = () => path().split('/').pop() || path()
                      const dir = () => {
                        const p = path()
                        const i = p.lastIndexOf('/')
                        return i > 0 ? p.substring(0, i) : ''
                      }
                      const collapsed = () => isCollapsed(props.taskId, path())
                      const count = () => g()?.matches.length ?? 0
                      return (
                        <button
                          class={`w-full h-full flex items-center gap-1 px-3 text-left ${s().selectedIndex === vrow.index ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { setSearchSelectedIndex(props.taskId, vrow.index); toggleCollapsed(props.taskId, path()); scrollRef?.focus() }}
                        >
                          <Show when={collapsed()} fallback={<ChevronDown size={11} class="text-text-dim shrink-0" />}>
                            <ChevronRight size={11} class="text-text-dim shrink-0" />
                          </Show>
                          {(() => { const I = getFileIcon(name()); return <I size={12} class="shrink-0" /> })()}
                          <span class="text-[12px] truncate text-text-primary">{name()}</span>
                          <Show when={dir()}>
                            <span class="text-[11px] text-text-dim truncate">{dir()}</span>
                          </Show>
                          <span class="ml-auto text-[10px] text-text-dim tabular-nums">{count()}</span>
                        </button>
                      )
                    })()}
                  </Show>
                  <Show when={row()?.kind === 'match'}>
                    {(() => {
                      const r = row() as Extract<Row, { kind: 'match' }>
                      const m = () => groups()[r.groupIdx]?.matches[r.matchIdx]
                      return (
                        <Show when={m()}>
                          {(() => {
                            const match = m()!
                            return (
                              <button
                                class={`w-full h-full flex items-center gap-2 pl-7 pr-3 text-left font-mono text-[11px] ${s().selectedIndex === vrow.index ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => { setSearchSelectedIndex(props.taskId, vrow.index); openMatch(match, false); scrollRef?.focus() }}
                                onDblClick={() => openMatch(match, true)}
                                title={`${match.path}:${match.lineNumber}`}
                              >
                                <span class="text-text-dim tabular-nums shrink-0 w-8 text-right">{match.lineNumber}</span>
                                <span class="truncate whitespace-pre text-text-secondary">
                                  <HighlightedLine text={match.lineText} spans={match.matchSpans} />
                                </span>
                              </button>
                            )
                          })()}
                        </Show>
                      )
                    })()}
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}

const ToggleBtn: Component<{ active: boolean; title: string; onClick: () => void; children: any }> = (props) => (
  <button
    class={`h-[18px] w-[20px] text-[10px] font-mono rounded flex items-center justify-center ${props.active ? 'bg-surface-3 text-text-primary' : 'text-text-dim hover:text-text-secondary hover:bg-surface-3'}`}
    title={props.title}
    onMouseDown={(e) => e.preventDefault()}
    onClick={props.onClick}
  >
    {props.children}
  </button>
)

// Render match line with highlighted regions. Trim leading whitespace so deeply
// indented hits aren't pushed offscreen; spans get shifted accordingly.
const HighlightedLine: Component<{ text: string; spans: Array<[number, number]> }> = (props) => {
  const trimmed = () => {
    const original = props.text
    const leading = original.length - original.trimStart().length
    return { text: original.slice(leading), shift: leading }
  }
  const parts = createMemo(() => {
    const { text, shift } = trimmed()
    const out: Array<{ slice: string; highlight: boolean }> = []
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const bytes = encoder.encode(text)
    let cursor = 0
    const sorted = props.spans
      .map(([s, e]) => [Math.max(0, s - shift), Math.max(0, e - shift)] as const)
      .filter(([s, e]) => e > s && s < bytes.length)
      .sort((a, b) => a[0] - b[0])
    for (const [s, e] of sorted) {
      const start = Math.max(s, cursor)
      const end = Math.min(e, bytes.length)
      if (start > cursor) out.push({ slice: decoder.decode(bytes.slice(cursor, start)), highlight: false })
      if (end > start) out.push({ slice: decoder.decode(bytes.slice(start, end)), highlight: true })
      cursor = Math.max(cursor, end)
    }
    if (cursor < bytes.length) out.push({ slice: decoder.decode(bytes.slice(cursor)), highlight: false })
    return out
  })
  return (
    <>
      <For each={parts()}>
        {(p) => (
          <Show when={p.highlight} fallback={<span>{p.slice}</span>}>
            <span class="bg-accent/25 text-text-primary rounded-[1px]">{p.slice}</span>
          </Show>
        )}
      </For>
    </>
  )
}
