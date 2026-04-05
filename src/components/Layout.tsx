import { Component } from 'solid-js'
import { Sidebar } from './Sidebar'
import { TaskPanel } from './TaskPanel'

export const Layout: Component = () => {
  return (
    <div class="flex h-screen w-screen bg-surface-0 text-gray-200">
      <Sidebar />
      <TaskPanel />
    </div>
  )
}
