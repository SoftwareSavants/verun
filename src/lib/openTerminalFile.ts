import { resolveTerminalFile } from './ipc'
import type { FileLink } from './terminalFileLinks'
import { openFilePinned, setPendingGoToLine } from '../store/editorView'
import { addToast } from '../store/ui'

export async function openTerminalFile(terminalId: string, link: FileLink): Promise<void> {
  try {
    const { taskId, relativePath } = await resolveTerminalFile(terminalId, link.path)
    openFilePinned(taskId, relativePath, relativePath.split('/').pop()!)
    setPendingGoToLine({ taskId, relativePath, line: link.line, column: link.column })
  } catch (error) {
    addToast(error instanceof Error ? error.message : String(error), 'error')
  }
}
