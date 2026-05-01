import { Archive, ExternalLink, FolderOpen, Pencil, Play, Settings, Square } from 'lucide-solid'
import type { ContextMenuItem } from '../components/ContextMenu'

export interface TaskMenuHandlers {
  onOpenInNewWindow: () => void
  onRename: () => void
  onOpenInFinder: () => void
  onStartApp: () => void
  onStopApp: () => void
  onSetupStartCommand: () => void
  onArchive: () => void
}

export interface TaskMenuState {
  isRunning: boolean
  isSetupRunning: boolean
  hasStartCommand: boolean
}

export function buildTaskMenuItems(h: TaskMenuHandlers, s: TaskMenuState): ContextMenuItem[] {
  let startStop: ContextMenuItem
  if (s.isRunning) {
    startStop = { label: 'Stop App', icon: Square, action: h.onStopApp }
  } else if (!s.hasStartCommand) {
    startStop = { label: 'Set Up Start Command...', icon: Settings, action: h.onSetupStartCommand }
  } else {
    startStop = {
      label: 'Start App',
      icon: Play,
      action: h.onStartApp,
      disabled: s.isSetupRunning,
    }
  }

  return [
    { label: 'Open in New Window', icon: ExternalLink, action: h.onOpenInNewWindow },
    { label: 'Rename', icon: Pencil, action: h.onRename },
    { label: 'Open in Finder', icon: FolderOpen, action: h.onOpenInFinder },
    startStop,
    { separator: true },
    { label: 'Archive Task', icon: Archive, action: h.onArchive },
  ]
}
