import { Component } from 'solid-js'
import { FileTree } from './FileTree'

interface Props {
  taskId: string
}

export const FilesPanel: Component<Props> = (props) => {
  return (
    <div class="flex flex-col h-full">
      <FileTree taskId={props.taskId} />
    </div>
  )
}
