import { createSignal } from 'solid-js'
import type { AgentSkill, AgentType } from '../types'
import * as ipc from '../lib/ipc'

export interface Command {
  name: string
  description: string
  category: 'app' | 'skill'
}

/** Context needed to resolve skills for a given composer. */
export interface SkillContext {
  agentKind: AgentType
  /** Repo root - coarse cache key and fallback scan root. */
  projectRoot: string
  /** Task id - fine cache key; skills differ per worktree. */
  taskId?: string
  /** Worktree path - scan root for fine cache refresh. */
  worktreePath?: string
}

export const APP_COMMANDS: Command[] = [
  { name: 'new-session', description: 'Create a new session on the current task', category: 'app' },
  { name: 'clear', description: 'Clear the current session output', category: 'app' },
  { name: 'plan', description: 'Toggle plan mode', category: 'app' },
  { name: 'btw', description: 'Ask an ephemeral side question (not added to history)', category: 'app' },
]

const byKey = new Map<string, AgentSkill[]>()
const byTask = new Map<string, AgentSkill[]>()
const inFlight = new Set<string>()
const [version, setVersion] = createSignal(0)

const coarseKey = (agent: AgentType, projectRoot: string) => `${agent}|${projectRoot}`
const taskKey = (taskId: string, agent: AgentType) => `${taskId}|${agent}`

export function getSkills(ctx: SkillContext): AgentSkill[] {
  version()
  if (ctx.taskId) {
    const fine = byTask.get(taskKey(ctx.taskId, ctx.agentKind))
    if (fine) return fine
  }
  return byKey.get(coarseKey(ctx.agentKind, ctx.projectRoot)) ?? []
}

export function hasSkill(name: string, ctx: SkillContext): boolean {
  return getSkills(ctx).some(s => s.name === name)
}

async function loadCoarse(agent: AgentType, projectRoot: string): Promise<void> {
  const key = coarseKey(agent, projectRoot)
  if (byKey.has(key) || inFlight.has(key)) return
  inFlight.add(key)
  try {
    const skills = await ipc.listAgentSkills(agent, projectRoot)
    byKey.set(key, skills)
    setVersion(v => v + 1)
  } catch (e) {
    console.warn('coarse skill load failed:', e)
  } finally {
    inFlight.delete(key)
  }
}

export function refreshTaskSkills(ctx: SkillContext): void {
  if (!ctx.taskId) return
  const scan = ctx.worktreePath ?? ctx.projectRoot
  const key = taskKey(ctx.taskId, ctx.agentKind)
  if (inFlight.has(key)) return
  inFlight.add(key)
  ipc.listAgentSkills(ctx.agentKind, scan)
    .then(skills => {
      byTask.set(key, skills)
      setVersion(v => v + 1)
    })
    .catch(e => console.warn('task skill refresh failed:', e))
    .finally(() => inFlight.delete(key))
}

/** Ensure coarse cache is populated and kick off a background fine refresh. */
export function primeSkills(ctx: SkillContext): void {
  void loadCoarse(ctx.agentKind, ctx.projectRoot)
  refreshTaskSkills(ctx)
}

/** Drop fine-cached entries for a task (e.g. on archive/delete). */
export function dropTaskSkills(taskId: string): void {
  const prefix = `${taskId}|`
  let changed = false
  for (const key of Array.from(byTask.keys())) {
    if (key.startsWith(prefix)) {
      byTask.delete(key)
      changed = true
    }
  }
  if (changed) setVersion(v => v + 1)
}

export function filterCommands(query: string, ctx: SkillContext): Command[] {
  const skills = getSkills(ctx)
  const all: Command[] = [
    ...APP_COMMANDS,
    ...skills.map(s => ({
      name: s.name,
      description: s.description,
      category: 'skill' as const,
    })),
  ]
  const q = query.toLowerCase().replace(/^\//, '')
  if (!q) return all
  return all.filter(c =>
    c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
  )
}
