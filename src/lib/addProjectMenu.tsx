import { FolderOpen, Rocket } from 'lucide-solid'
import type { ContextMenuItem } from '../components/ContextMenu'
import { CloneIcon } from '../components/icons/CloneIcon'

export interface AddProjectMenuHandlers {
  onAddExisting: () => void
  onCreateNew: () => void
  onCloneRepo: () => void
}

export function buildAddProjectMenuItems(h: AddProjectMenuHandlers): ContextMenuItem[] {
  return [
    { label: 'Add existing project...', icon: FolderOpen, action: h.onAddExisting },
    { label: 'Bootstrap a new project...', icon: Rocket, action: h.onCreateNew },
    { label: 'Clone repo', icon: CloneIcon, action: h.onCloneRepo },
  ]
}
