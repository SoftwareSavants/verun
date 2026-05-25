import { Component } from 'solid-js'
import { ModelPicker } from './ModelPicker'
import { modelPickerRequest, closeModelPicker } from '../store/modelPicker'

// Mounts ModelPicker against the global picker request store. Rendered by
// both Layout (main window) and TaskWindowShell (detached windows) so any
// caller of openModelPicker — including ActionsPanel's "Fix in new session"
// and the Cmd+T shortcut — surfaces the picker regardless of which shell
// holds the window.
export const TaskModelPickerHost: Component = () => {
  return (
    <ModelPicker
      open={!!modelPickerRequest()}
      title={modelPickerRequest()?.title}
      placeholder={modelPickerRequest()?.placeholder}
      defaultAgent={modelPickerRequest()?.defaultAgent}
      defaultModel={modelPickerRequest()?.defaultModel}
      onClose={closeModelPicker}
      onPick={(agentType, model) => {
        const req = modelPickerRequest()
        if (req) return req.onPick(agentType, model)
      }}
    />
  )
}
