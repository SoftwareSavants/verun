import { FolderOpen, Plus } from 'lucide-solid'
import type { ContextMenuItem } from '../components/ContextMenu'
import { GithubIcon } from '../components/icons/GithubIcon'

export interface AddProjectMenuHandlers {
  onAddExisting: () => void
  onCreateNew: () => void
  onCloneRepo: () => void
}

export function buildAddProjectMenuItems(h: AddProjectMenuHandlers): ContextMenuItem[] {
  return [
    { label: 'Add existing project...', icon: FolderOpen, action: h.onAddExisting },
    { label: 'Bootstrap a new project...', icon: Plus, action: h.onCreateNew },
    { label: 'Clone repo', icon: GithubIcon, action: h.onCloneRepo },
  ]
}
