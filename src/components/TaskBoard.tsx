import { For, Show, createMemo, createSignal } from 'solid-js'
import { Search, X, GitBranch } from 'lucide-solid'
import { Select } from './Select'
import type { BoardColumn } from '../lib/taskBoard'

export interface BoardCard {
  id: string
  name: string
  projectId: string
  projectName: string
  groupId: string
  branch: string
  column: BoardColumn
  label: string
}
const columns: { id: BoardColumn; name: string; empty: string; color: string }[] = [
  { id: 'attention', name: 'Needs attention', empty: 'Nothing needs your attention.', color: 'bg-status-error' },
  { id: 'running', name: 'Running', empty: 'No agents working right now.', color: 'bg-accent' },
  { id: 'ready', name: 'Ready', empty: 'Tasks ready to continue appear here.', color: 'bg-text-muted' },
  { id: 'unknown', name: 'Status unavailable', empty: '', color: 'bg-text-dim' },
  { id: 'archived', name: 'Archived', empty: 'No archived tasks.', color: 'bg-text-dim' },
]
export function TaskBoard(props: {
  cards: BoardCard[]
  groups: { id: string; name: string }[]
  initialGroup?: string
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [group, setGroup] = createSignal(props.initialGroup ?? 'all')
  const [project, setProject] = createSignal('all')
  const [query, setQuery] = createSignal('')
  const [archived, setArchived] = createSignal(false)
  const groupScope = () => group() === 'ungrouped' || props.groups.some(g => g.id === group()) ? group() : 'all'
  const groupCards = createMemo(() => props.cards.filter(c => groupScope() === 'all' || c.groupId === groupScope()))
  const projectOptions = createMemo(() => [...new Map(groupCards().map(c => [c.projectId, { value: c.projectId, label: c.projectName }])).values()].sort((a, b) => a.label.localeCompare(b.label)))
  const projectScope = () => projectOptions().some(p => p.value === project()) ? project() : 'all'
  const filtered = createMemo(() => groupCards().filter(c => (projectScope() === 'all' || c.projectId === projectScope()) && `${c.name} ${c.projectName} ${c.branch}`.toLowerCase().includes(query().trim().toLowerCase())))
  return <main class="h-full flex flex-col min-h-0 bg-surface-0" aria-label="Task board">
    <header class="px-6 pt-10 pb-5 shrink-0">
      <div class="flex items-center justify-between gap-3 mb-4">
        <h1 class="text-lg font-semibold text-text-primary">Task board</h1>
        <button type="button" class="p-1.5 rounded-md text-text-muted hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent" aria-label="Close task board" onClick={props.onClose}><X size={16} /></button>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Select label="Group" size="compact" value={groupScope()} options={[{ value: 'all', label: 'All groups' }, ...props.groups.map(g => ({ value: g.id, label: g.name })), { value: 'ungrouped', label: 'Ungrouped' }]} onChange={value => { setGroup(value); setProject('all') }} />
        <Select label="Project" size="compact" value={projectScope()} options={[{ value: 'all', label: 'All projects' }, ...projectOptions()]} onChange={setProject} />
        <div class="flex items-center gap-2 rounded-md bg-surface-1 px-2 py-1.5 min-w-0 flex-1 max-w-64 focus-within:ring-1 focus-within:ring-accent">
          <Search size={12} class="text-text-dim shrink-0" />
          <input aria-label="Search tasks" placeholder="Find a task…" class="bg-transparent outline-none text-xs min-w-0 w-full text-text-primary" value={query()} onInput={e => setQuery(e.currentTarget.value)} />
        </div>
        <label class="flex items-center gap-1.5 text-xs text-text-muted ml-auto cursor-pointer"><input type="checkbox" checked={archived()} onChange={e => setArchived(e.currentTarget.checked)} />Show archived</label>
      </div>
    </header>
    <div class="flex-1 min-h-0 overflow-x-auto px-6 pb-5 flex gap-4">
      <For each={columns.filter(c => (c.id !== 'archived' || archived()) && (c.id !== 'unknown' || filtered().some(card => card.column === 'unknown')))}>{column => {
        const cards = () => filtered().filter(c => c.column === column.id)
        return <section role="region" aria-label={column.name} class="flex-1 min-w-60 flex flex-col min-h-0">
          <div class="flex items-center gap-2 pb-3 shrink-0">
            <span class={`w-1.5 h-1.5 rounded-full ${column.color}`} />
            <h2 class="text-xs font-medium text-text-secondary">{column.name}</h2>
            <span class="text-xs text-text-dim tabular-nums">{cards().length}</span>
          </div>
          <div class="flex-1 min-h-0 overflow-y-auto rounded-lg bg-surface-1 p-2 space-y-2">
            <For each={cards()}>{card => <button type="button" class="block w-full text-left rounded-md bg-surface-0 ring-1 ring-outline/8 p-3 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent transition-colors" onClick={() => props.onOpen(card.id)}>
              <span class="block text-[11px] text-text-muted truncate mb-1" title={card.projectName}>{card.projectName}</span>
              <span class="block text-sm font-medium text-text-primary break-words leading-snug">{card.name}</span>
              <span class="flex items-center gap-1 text-[11px] text-text-dim mt-2" title={card.branch}><GitBranch size={11} class="shrink-0" /><span class="truncate">{card.branch}</span></span>
              <span class="block text-[11px] text-text-muted mt-2">{card.label}</span>
            </button>}</For>
            <Show when={cards().length === 0}><p class="text-xs text-text-dim px-2 py-6 text-center">{query() || projectScope() !== 'all' || groupScope() !== 'all' ? 'No matching tasks.' : column.empty}</p></Show>
          </div>
        </section>
      }}</For>
    </div>
  </main>
}
