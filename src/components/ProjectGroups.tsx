import { For, Show, createSignal, type Component } from 'solid-js'
import { AlertCircle, Check, ChevronDown, ChevronRight, Pencil, Plus, Search, Trash2, X } from 'lucide-solid'
import { Select } from './Select'
import { addGroup, deleteGroup, groupState, projectQuery, renameGroup, setGroupScope, setProjectQuery, toggleGroup } from '../store/projectGroups'

const GroupNameEditor: Component<{ id?: string; name?: string; onClose: () => void }> = props => {
  const [name, setName] = createSignal(props.name ?? '')
  const [error, setError] = createSignal('')
  const save = () => {
    try { if (props.id) renameGroup(props.id, name()); else addGroup(name()); props.onClose() }
    catch (e) { setError(String(e).replace(/^Error: /, '')) }
  }
  return <div class="px-1 py-1.5">
    <div class="flex items-center gap-1">
      <input aria-label="Group name" placeholder="Group name" maxLength={60} class="input-base min-w-0 text-xs" value={name()}
        ref={el => queueMicrotask(() => { el.focus(); el.select() })}
        onInput={e => setName(e.currentTarget.value)} onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Enter') { e.preventDefault(); save() }
          if (e.key === 'Escape') props.onClose()
        }} />
      <button class="btn-ghost p-1" aria-label="Save group" onClick={save}><Check size={13} /></button>
      <button class="btn-ghost p-1" aria-label="Cancel group edit" onClick={props.onClose}><X size={13} /></button>
    </div>
    <Show when={error()}><p role="alert" class="text-xs text-status-error mt-1">{error()}</p></Show>
  </div>
}

export const GroupToolbar: Component<{
  attention: { id: string; name: string; count: number }[]
  onAttention: (groupId: string) => void
}> = props => {
  const [adding, setAdding] = createSignal(false)
  return <div class="px-2 pb-2 no-drag">
    <div class="flex items-center gap-1 mb-2">
      <div class="flex-1 min-w-0"><Select label="Project group" value={groupState().scope} onChange={setGroupScope}
        options={[{ value: 'all', label: 'All projects' }, ...groupState().groups.map(g => ({ value: g.id, label: g.name })), { value: 'ungrouped', label: 'Ungrouped' }]} /></div>
      <button class="btn-ghost p-1.5 shrink-0" title="New group" aria-label="New group" onClick={() => setAdding(true)}><Plus size={14} /></button>
    </div>
    <Show when={adding()}><GroupNameEditor onClose={() => setAdding(false)} /></Show>
    <div class="relative">
      <Search size={13} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim pointer-events-none" />
      <input aria-label="Find any project" placeholder="Find any project…" class="input-base pl-8 pr-7 text-xs" value={projectQuery()}
        onInput={e => setProjectQuery(e.currentTarget.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setProjectQuery('') }} />
      <Show when={projectQuery()}><button aria-label="Clear project search" class="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim" onClick={() => setProjectQuery('')}><X size={12} /></button></Show>
    </div>
    <For each={props.attention}>{group => <button class="w-full mt-2 px-2 py-1.5 rounded-md bg-amber-500/10 text-amber-600 text-[11px] flex items-center gap-1.5 text-left" onClick={() => props.onAttention(group.id)}>
      <AlertCircle size={12} class="shrink-0" /><span class="flex-1 truncate">{group.name} · {group.count} need attention</span><ChevronRight size={12} />
    </button>}</For>
  </div>
}

export const GroupHeading: Component<{ id: string; name: string; count: number; attention: number }> = props => {
  const [editing, setEditing] = createSignal(false)
  const name = () => groupState().groups.find(g => g.id === props.id)?.name ?? props.name
  const collapsed = () => groupState().collapsed.includes(props.id)
  return <Show when={!editing()} fallback={<GroupNameEditor id={props.id} name={name()} onClose={() => setEditing(false)} />}>
    <div class="flex items-center gap-1 px-1 pt-3 pb-1 group/group">
      <button class="flex-1 min-w-0 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-dim text-left" aria-expanded={!collapsed()} aria-label={`${collapsed() ? 'Expand' : 'Collapse'} ${name()}`} onClick={() => toggleGroup(props.id)}>
        <Show when={collapsed()} fallback={<ChevronDown size={12} />}><ChevronRight size={12} /></Show>
        <span class="truncate">{name()}</span><span class="text-text-dim font-normal">{props.count}</span>
        <Show when={props.attention > 0}><span class="text-amber-600" title={`${props.attention} tasks need attention`}>· {props.attention}</span></Show>
      </button>
      <Show when={props.id !== 'ungrouped'}>
        <button class="p-1 rounded text-text-dim hover:text-text-primary opacity-0 group-hover/group:opacity-100 focus:opacity-100" aria-label={`Rename ${name()}`} onClick={() => setEditing(true)}><Pencil size={11} /></button>
        <button class="p-1 rounded text-text-dim hover:text-status-error opacity-0 group-hover/group:opacity-100 focus:opacity-100" title="Projects will move to Ungrouped" aria-label={`Delete ${name()} group; keep projects`} onClick={() => deleteGroup(props.id)}><Trash2 size={11} /></button>
      </Show>
    </div>
  </Show>
}
