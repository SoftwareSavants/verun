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

/** Module-level parsed context — safe to import from stores (outside component tree) */
export const windowContext = parseWindowContext()

console.log('[window-context]', windowContext.windowType, windowContext.windowLabel, { taskId: windowContext.taskId, projectId: windowContext.projectId })

/**
 * Returns true if this window should handle events for the given taskId.
 * Task windows own their specific task (or the task they created).
 * Main window owns everything (windowed-task filtering happens at call site).
 *
 * For new-task windows (Cmd+Shift+N) where taskId starts null, pass the
 * current selectedTaskId as `currentTaskId` so the check works after creation.
 */
let _isTaskWindowedFn: ((taskId: string) => boolean) | null = null

/** Register the windowed-task checker (called once from store/ui.ts to avoid circular deps) */
export function registerWindowedTaskChecker(fn: (taskId: string) => boolean) {
  _isTaskWindowedFn = fn
}

export function isTaskOwnedByThisWindow(taskId: string, currentTaskId?: string | null): boolean {
  if (windowContext.windowType === 'task') {
    const owned = windowContext.taskId
      ? windowContext.taskId === taskId
      : currentTaskId != null && currentTaskId === taskId
    console.log('[ownership]', windowContext.windowLabel, 'task window, taskId:', taskId, 'ctx.taskId:', windowContext.taskId, 'currentTaskId:', currentTaskId, '→', owned)
    return owned
  }
  // Main window: own all tasks except those open in a separate window
  const windowed = _isTaskWindowedFn ? _isTaskWindowedFn(taskId) : false
  const owned = !windowed
  console.log('[ownership]', 'main', 'taskId:', taskId, 'windowed:', windowed, '→', owned)
  return owned
}
