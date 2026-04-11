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
