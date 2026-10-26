import { produce } from 'solid-js/store'
import type { AccountSelection, AgentType } from '../types'
import * as ipc from '../lib/ipc'
import { setTasks } from './tasks'
import { setSessions, setOutputItems, sendMessage, updateSessionModel } from './sessions'
import { isSetupRunning, queueMessage, setupFailed } from './setup'
import { selectedTaskId, setSelectedTaskId, setSelectedProjectId, setSelectedSessionIdForTask, setShowArchived, addToast } from './ui'

export interface DraftTaskInput {
  projectId: string
  baseBranch: string
  agentType: AgentType
  model?: string
  directory?: string
  /** The account the task's first session runs on. The project's when left out. */
  account?: AccountSelection
  message: string
}

export async function startDraftTask(input: DraftTaskInput) {
  const previousSelection = selectedTaskId()
  const { task, session } = await ipc.createTask(input.projectId, input.baseBranch, input.agentType, input.directory, input.account)
  setTasks(prev => [task, ...prev.filter(t => t.id !== task.id)])
  setSessions(produce(s => { if (!s.some(row => row.id === session.id)) s.push(session) }))
  setOutputItems(session.id, [])
  if (input.model) updateSessionModel(session.id, input.model)
  // Retain the prompt if setup or the agent fails to start.
  localStorage.setItem(`verun:draft-msg:${session.id}`, input.message)
  const selectTask = () => {
    if (selectedTaskId() !== previousSelection) return
    setSelectedProjectId(task.projectId)
    setSelectedTaskId(task.id)
    setSelectedSessionIdForTask(task.id, session.id)
    setShowArchived(false)
  }
  if (setupFailed(task.id)) { selectTask(); return }
  if (isSetupRunning(task.id)) {
    queueMessage(task.id, { sessionId: session.id, message: input.message, model: input.model })
    localStorage.removeItem(`verun:draft-msg:${session.id}`)
    selectTask()
    return
  }
  try {
    // false: the session's account stopped the send and sendMessage has said so
    // with its toast. The agent did not start, so the prompt stays, as when it
    // fails below.
    if (await sendMessage(session.id, input.message, undefined, input.model)) {
      localStorage.removeItem(`verun:draft-msg:${session.id}`)
    }
  } catch (error) {
    // Creation succeeded: never create a duplicate task when sending fails.
    addToast(`Task created, but the agent could not start: ${String(error)}`, 'error')
  }
  selectTask()
}
