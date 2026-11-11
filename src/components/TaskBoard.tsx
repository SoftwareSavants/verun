import { For, Show, createMemo, createSignal } from 'solid-js'
import { Search, X } from 'lucide-solid'
import { Select } from './Select'
import { TaskStatusIcon } from './TaskStatusIcon'
import { BOARD_COLUMNS, type BoardColumn, type TaskStatusKind } from '../lib/taskBoard'

export interface BoardCard {
  id: string
  name: string
  projectId: string
  projectName: string
  groupId: string
  branch: string
  column: BoardColumn
  kind: TaskStatusKind
  label: string
}
const columns = BOARD_COLUMNS
// Status text the column header doesn't already say.
const showsLabel = (card: BoardCard) => card.column === 'attention' || card.kind === 'busy' || card.column === 'unknown'

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
  const count = (column: BoardColumn) => filtered().filter(c => c.column === column).length
  return <main class="h-full flex flex-col min-h-0 bg-surface-0" aria-label="Task board">
    <header class="px-5 pt-10 pb-4 shrink-0">
      <div class="flex items-center justify-between gap-3 mb-3">
        <div class="flex items-baseline gap-3 min-w-0">
          <h1 class="text-sm font-semibold text-text-primary">Task board</h1>
          <span class="text-xs tabular-nums text-text-muted">
            <span class={count('attention') ? 'text-status-waiting font-medium' : ''}>{count('attention') ? `${count('attention')} needs you` : 'Nothing needs you'}</span>
            <span class="text-text-dim"> · </span>
            <span class="text-text-secondary">{`${count('running')} running`}</span>
            <span class="text-text-dim"> · </span>
            <span>{`${count('idle')} idle`}</span>
            <span class="text-text-dim"> · </span>
            <span>{`${count('review')} in review`}</span>
            <span class="text-text-dim"> · </span>
            <span>{`${count('done')} done`}</span>
          </span>
        </div>
        <button type="button" class="p-1.5 rounded-md text-text-muted hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent" aria-label="Close task board" onClick={props.onClose}><X size={15} /></button>
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
    <div class="flex-1 min-h-0 overflow-x-auto px-5 pb-4 flex gap-3">
      <For each={columns.filter(c => (c.id !== 'archived' || archived()) && (c.id !== 'unknown' || filtered().some(card => card.column === 'unknown')))}>{column => {
        const cards = () => filtered().filter(c => c.column === column.id)
        const urgent = () => column.id === 'attention' && cards().length > 0
        // Space follows the work: empty columns shrink, busy ones grow a little.
        return <section role="region" aria-label={column.name}
          class={`flex flex-col min-h-0 ${cards().length > 1 ? 'min-w-52' : 'flex-none w-44'}`}
          style={cards().length > 1 ? { flex: `${1 + Math.min(cards().length, 6) / 6} 1 0` } : undefined}>
          <div class="flex items-center gap-1.5 px-1 pb-2 shrink-0 border-b-1 border-b-solid border-b-outline/8 mb-2">
            <h2 class={`text-xs font-semibold ${urgent() ? 'text-status-waiting' : 'text-text-secondary'}`}>{column.name}</h2>
            <span class={`text-xs tabular-nums ${urgent() ? 'text-status-waiting' : 'text-text-dim'}`}>{cards().length}</span>
          </div>
          <div class="flex-1 min-h-0 overflow-y-auto space-y-1.5">
            <For each={cards()}>{card => <button type="button"
              class="block w-full text-left rounded-md bg-surface-1 ring-1 ring-outline/6 px-2.5 py-2 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent transition-colors"
              title={`${card.name}\n${card.projectName} · ${card.branch}`} onClick={() => props.onOpen(card.id)}>
              <span class="flex items-center gap-2 min-w-0">
                <span><TaskStatusIcon kind={card.kind} label={card.label} /></span>
                <span class="text-[13px] font-medium text-text-primary leading-snug truncate">{card.name}</span>
              </span>
              <span class="flex items-center gap-1.5 mt-1 pl-5 text-[11px] min-w-0">
                <span class="text-text-muted truncate">{card.projectName}</span>
                <Show when={showsLabel(card)}>
                  <span class="text-text-dim">·</span>
                  <span class={`shrink-0 font-medium ${card.column === 'attention' ? (card.kind === 'input' ? 'text-status-waiting' : 'text-status-error') : 'text-text-muted'}`}>{card.label}</span>
                </Show>
              </span>
            </button>}</For>
            <Show when={cards().length === 0}><p class="text-[11px] text-text-dim px-1 py-3">{query() || projectScope() !== 'all' || groupScope() !== 'all' ? 'No matching tasks.' : column.empty}</p></Show>
          </div>
        </section>
      }}</For>
    </div>
  </main>
}
