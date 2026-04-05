import { Component, onMount } from 'solid-js'
import { Layout } from './components/Layout'
import { loadProjects } from './store/projects'
import { initSessionListeners } from './store/sessions'
import 'virtual:uno.css'

const App: Component = () => {
  onMount(async () => {
    await initSessionListeners()
    await loadProjects()
  })

  return <Layout />
}

export default App
