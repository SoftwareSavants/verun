import { FolderOpen, Rocket } from 'lucide-solid'
import type { ContextMenuItem } from '../components/ContextMenu'

export interface AddProjectMenuHandlers {
  onAddExisting: () => void
  onCreateNew: () => void
}

export function buildAddProjectMenuItems(h: AddProjectMenuHandlers): ContextMenuItem[] {
  return [
    { label: 'Add existing project...', icon: FolderOpen, action: h.onAddExisting },
    { label: 'Bootstrap a new project...', icon: Rocket, action: h.onCreateNew },
  ]
}
