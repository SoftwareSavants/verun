import { Component } from 'solid-js'
import { Sidebar } from './Sidebar'
import { AgentPanel } from './AgentPanel'

interface Props {
  onNewAgent: () => void
  onKill: (id: string) => void
  onRestart: (id: string) => void
  onOpenFinder: (path: string) => void
  onMerge: (worktreePath: string, targetBranch: string) => void
}

export const Layout: Component<Props> = (props) => {
  return (
    <div class="flex h-screen w-screen bg-surface-0 text-gray-200">
      <Sidebar onNewAgent={props.onNewAgent} />
      <AgentPanel
        onKill={props.onKill}
        onRestart={props.onRestart}
        onOpenFinder={props.onOpenFinder}
        onMerge={props.onMerge}
      />
    </div>
  )
}
