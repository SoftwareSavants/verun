import { FolderOpen, Plus, Zap } from 'lucide-solid'
import type { ContextMenuItem } from '../components/ContextMenu'
import { GithubIcon } from '../components/icons/GithubIcon'

export interface AddProjectMenuHandlers {
  onAddExisting: () => void
  onCreateNew: () => void
  onCloneRepo: () => void
  /** Run an agent in any folder without adding a project. */
  onQuickTask: () => void
}

export function buildAddProjectMenuItems(h: AddProjectMenuHandlers): ContextMenuItem[] {
  return [
    { label: 'Quick task in any folder...', icon: Zap, shortcut: '⌘⌥N', action: h.onQuickTask },
    { separator: true },
    { label: 'Add existing project...', icon: FolderOpen, action: h.onAddExisting },
    { label: 'Bootstrap a new project...', icon: Plus, action: h.onCreateNew },
    { label: 'Clone repo', icon: GithubIcon, action: h.onCloneRepo },
  ]
}
