import { Component, onMount } from 'solid-js'
import { Layout } from './components/Layout'
import { AddProjectDialog } from './components/AddProjectDialog'
import { NewTaskDialog } from './components/NewTaskDialog'
import { loadProjects } from './store/projects'
import { initSessionListeners } from './store/sessions'
import {
  selectedProjectId,
  showAddProjectDialog, setShowAddProjectDialog,
  showNewTaskDialog, setShowNewTaskDialog,
} from './store/ui'
import 'virtual:uno.css'

const App: Component = () => {
  onMount(async () => {
    await initSessionListeners()
    await loadProjects()
  })

  return (
    <>
      <Layout />
      <AddProjectDialog
        open={showAddProjectDialog()}
        onClose={() => setShowAddProjectDialog(false)}
      />
      <NewTaskDialog
        open={showNewTaskDialog()}
        projectId={selectedProjectId()}
        onClose={() => setShowNewTaskDialog(false)}
      />
    </>
  )
}

export default App
