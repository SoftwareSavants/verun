import { createSignal } from 'solid-js'
import type { ClaudeSkill } from '../types'
import * as ipc from '../lib/ipc'

export interface Command {
  name: string
  description: string
  category: 'app' | 'claude'
}

export const APP_COMMANDS: Command[] = [
  { name: 'new-session', description: 'Create a new session on the current task', category: 'app' },
  { name: 'clear', description: 'Clear the current session output', category: 'app' },
  { name: 'model', description: 'Switch model (opus, sonnet, haiku)', category: 'app' },
]

const [claudeSkills, setClaudeSkills] = createSignal<ClaudeSkill[]>([])
const [skillsLoaded, setSkillsLoaded] = createSignal(false)

export { claudeSkills }

export async function loadClaudeSkills() {
  if (skillsLoaded()) return
  try {
    const skills = await ipc.listClaudeSkills()
    setClaudeSkills(skills)
    setSkillsLoaded(true)
  } catch (e) {
    console.warn('Failed to load Claude skills:', e)
  }
}

export function allCommands(): Command[] {
  return [
    ...APP_COMMANDS,
    ...claudeSkills().map(s => ({
      name: s.name,
      description: s.description,
      category: 'claude' as const,
    })),
  ]
}

export function filterCommands(query: string): Command[] {
  const q = query.toLowerCase().replace(/^\//, '')
  if (!q) return allCommands()
  return allCommands().filter(c =>
    c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
  )
}
