import { Component } from 'solid-js'
import { Layout } from './components/Layout'
import { useAgent } from './hooks/useAgent'
import * as ipc from './lib/ipc'
import 'virtual:uno.css'

const App: Component = () => {
  const { kill, restart } = useAgent()

  const handleNewAgent = async () => {
    // TODO: Phase 4 — open dialog to configure new agent
    console.log('New agent dialog — implement in Phase 4')
  }

  const handleKill = (id: string) => kill(id)
  const handleRestart = (id: string) => restart(id)
  const handleOpenFinder = (path: string) => ipc.openInFinder(path)
  const handleMerge = (worktreePath: string, targetBranch: string) =>
    ipc.mergeBranch(worktreePath, targetBranch)

  return (
    <Layout
      onNewAgent={handleNewAgent}
      onKill={handleKill}
      onRestart={handleRestart}
      onOpenFinder={handleOpenFinder}
      onMerge={handleMerge}
    />
  )
}

export default App
