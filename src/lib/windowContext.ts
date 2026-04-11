import { createContext, useContext } from 'solid-js'

export type WindowType = 'main' | 'task'

export interface WindowContext {
  windowType: WindowType
  windowLabel: string
  /** Set for task windows showing an existing task */
  taskId: string | null
  /** Set for new-task windows (Cmd+Shift+N) — the project to create the task in */
  projectId: string | null
}

const WindowCtx = createContext<WindowContext>({
  windowType: 'main',
  windowLabel: 'main',
  taskId: null,
  projectId: null,
})

export const WindowContextProvider = WindowCtx.Provider

export function useWindowContext(): WindowContext {
  return useContext(WindowCtx)
}

export function parseWindowContext(): WindowContext {
  const params = new URLSearchParams(window.location.search)
  const windowType = (params.get('windowType') as WindowType) || 'main'
  const taskId = params.get('taskId')
  const projectId = params.get('projectId')
  const windowLabel = params.get('windowLabel') || 'main'

  return { windowType, windowLabel, taskId, projectId }
}

/** Module-level parsed context — importable from stores outside the component tree */
export const windowContext = parseWindowContext()

export const isMainWindow = windowContext.windowType === 'main'
export const isTaskWindow = windowContext.windowType === 'task'
export const isNewTaskWindow = isTaskWindow && !windowContext.taskId

// ---------------------------------------------------------------------------
// Task ownership — determines which window handles events for a given taskId
// ---------------------------------------------------------------------------

let _isTaskWindowedFn: ((taskId: string) => boolean) | null = null

/** Register the windowed-task checker (called from store/ui.ts to avoid circular deps) */
export function registerWindowedTaskChecker(fn: (taskId: string) => boolean) {
  _isTaskWindowedFn = fn
}

/**
 * Returns true if this window should handle events for the given taskId.
 *
 * - Existing task window: only owns its specific task (exact ID match)
 * - New-task window: owns everything (only one task can be created here,
 *   and the real ID isn't known until after the setup hook fires)
 * - Main window: owns all tasks except those open in a separate window
 */
export function isTaskOwnedByThisWindow(taskId: string): boolean {
  if (isTaskWindow) {
    if (windowContext.taskId) return windowContext.taskId === taskId
    return true // new-task window — accept all
  }
  // Main window
  return !_isTaskWindowedFn?.(taskId)
}
