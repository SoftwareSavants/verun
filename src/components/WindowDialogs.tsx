import { Component } from 'solid-js'
import { FileConflictDialog } from './FileConflictDialog'
import { DictationSetupDialog } from './DictationSetupDialog'

/**
 * The dialogs every window shell mounts (main and detached task windows), so a
 * dialog added here shows in both without one shell drifting from the other.
 */
export const WindowDialogs: Component = () => (
  <>
    <FileConflictDialog />
    <DictationSetupDialog />
  </>
)
