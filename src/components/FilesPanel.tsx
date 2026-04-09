import { Component, Show } from 'solid-js'
import { FileTree } from './FileTree'
import { EditorTabs } from './EditorTabs'
import { CodeEditor } from './CodeEditor'
import { openTabs, activeTabPath } from '../store/files'

interface Props {
  taskId: string
}

export const FilesPanel: Component<Props> = (props) => {
  const hasOpenFiles = () => openTabs().length > 0

  return (
    <div class="flex flex-col h-full">
      <Show when={hasOpenFiles()}>
        {/* Editor tabs */}
        <EditorTabs />

        {/* Editor */}
        <Show when={activeTabPath()}>
          {(path) => (
            <div class="flex-1 overflow-hidden">
              <CodeEditor taskId={props.taskId} relativePath={path()} />
            </div>
          )}
        </Show>
      </Show>

      {/* File tree — takes full space when no files open, or bottom portion when editor is active */}
      <div class={hasOpenFiles() ? 'h-48 shrink-0 border-t border-border-subtle overflow-hidden' : 'flex-1 overflow-hidden'}>
        <FileTree taskId={props.taskId} />
      </div>
    </div>
  )
}
