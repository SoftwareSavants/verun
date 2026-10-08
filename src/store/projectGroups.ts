import { createSignal } from 'solid-js'

export interface ProjectGroup { id: string; name: string }
interface GroupState { groups: ProjectGroup[]; assignments: Record<string, string>; collapsed: string[]; scope: string }
const KEY = 'verun:projectGroups'
const empty = (): GroupState => ({ groups: [], assignments: {}, collapsed: [], scope: 'all' })
function readState(): GroupState {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!data || !Array.isArray(data.groups)) return empty()
    const groups: ProjectGroup[] = data.groups.filter((g: ProjectGroup) => g && typeof g.id === 'string' && typeof g.name === 'string' && g.name.trim())
    const valid = new Set(groups.map(g => g.id))
    const assignments = Object.fromEntries(Object.entries(data.assignments ?? {}).filter(([, id]) => typeof id === 'string' && valid.has(id))) as Record<string, string>
    return { groups, assignments, collapsed: Array.isArray(data.collapsed) ? data.collapsed.filter((id: string) => id === 'ungrouped' || valid.has(id)) : [], scope: data.scope === 'ungrouped' || valid.has(data.scope) ? data.scope : 'all' }
  } catch { return empty() }
}
export const [groupState, setGroupState] = createSignal<GroupState>(readState())
export const [projectQuery, setProjectQuery] = createSignal('')
function save(next: GroupState) {
  localStorage.setItem(KEY, JSON.stringify(next))
  setGroupState(next)
}
export function resetGroupState() { setGroupState(readState()); setProjectQuery('') }
export function syncProjectGroups(event: StorageEvent) { if (event.key === KEY || event.key === null) setGroupState(readState()) }
function validName(name: string, except?: string) {
  const value = name.trim()
  if (!value || value.length > 60) throw new Error('Use a group name between 1 and 60 characters.')
  if (['all projects', 'ungrouped'].includes(value.toLowerCase()) || groupState().groups.some(g => g.id !== except && g.name.toLowerCase() === value.toLowerCase())) throw new Error('Choose a unique group name.')
  return value
}
export function addGroup(name: string) {
  const group = { id: crypto.randomUUID(), name: validName(name) }
  save({ ...groupState(), groups: [...groupState().groups, group] })
  return group.id
}
export function renameGroup(id: string, name: string) {
  const value = validName(name, id)
  save({ ...groupState(), groups: groupState().groups.map(g => g.id === id ? { ...g, name: value } : g) })
}
export function deleteGroup(id: string) {
  const s = groupState()
  save({ groups: s.groups.filter(g => g.id !== id), assignments: Object.fromEntries(Object.entries(s.assignments).filter(([, group]) => group !== id)), collapsed: s.collapsed.filter(g => g !== id), scope: s.scope === id ? 'all' : s.scope })
}
export function moveProject(projectId: string, groupId: string) {
  if (groupId !== 'ungrouped' && !groupState().groups.some(g => g.id === groupId)) throw new Error('Group no longer exists.')
  const assignments = { ...groupState().assignments }
  if (groupId === 'ungrouped') delete assignments[projectId]
  else assignments[projectId] = groupId
  save({ ...groupState(), assignments })
}
export const projectGroup = (projectId: string) => groupState().assignments[projectId] ?? 'ungrouped'
export const groupName = (id: string) => groupState().groups.find(g => g.id === id)?.name ?? 'Ungrouped'
export function setGroupScope(scope: string) { save({ ...groupState(), scope }); setProjectQuery('') }
export function toggleGroup(id: string) {
  const s = groupState()
  save({ ...s, collapsed: s.collapsed.includes(id) ? s.collapsed.filter(g => g !== id) : [...s.collapsed, id] })
}
export function revealProject(id: string) {
  const group = projectGroup(id)
  save({ ...groupState(), scope: group, collapsed: groupState().collapsed.filter(g => g !== group) })
  setProjectQuery('')
}
export function projectSections<T extends { id: string; name: string }>(projects: T[]) {
  const s = groupState()
  const query = projectQuery().trim().toLowerCase()
  const definitions = [...s.groups, { id: 'ungrouped', name: 'Ungrouped' }]
  return definitions.filter(g => query || s.scope === 'all' || s.scope === g.id).map(group => ({
    ...group,
    collapsed: s.groups.length > 0 && !query && s.scope === 'all' && s.collapsed.includes(group.id),
    projects: projects.filter(p => projectGroup(p.id) === group.id && (!query || p.name.toLowerCase().includes(query))),
  })).filter(g => query ? g.projects.length > 0 : g.id !== 'ungrouped' || g.projects.length > 0 || s.scope === 'ungrouped')
}
export function visibleProjects<T extends { id: string; name: string }>(projects: T[]) {
  return projectSections(projects).flatMap(g => g.collapsed ? [] : g.projects)
}
