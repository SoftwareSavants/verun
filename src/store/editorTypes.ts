export type DiffSource = { type: 'working' } | { type: 'commit'; commitHash: string }

export interface EditorTab {
  /** Unique tab key. For files this is the relative path. For diffs it's a synthetic key (see diffTabKey). */
  relativePath: string
  name: string
  dirty: boolean
  preview: boolean
  /** Tab variant. Defaults to 'file' when omitted (legacy persisted tabs). */
  kind?: 'file' | 'diff'
  /** Original on-disk relative path (only set for diff tabs — relativePath is synthetic). */
  diffPath?: string
  /** Diff source descriptor (only set for diff tabs). */
  diffSource?: DiffSource
}

export interface PendingGoToLineRequest {
  taskId: string
  relativePath: string
  line: number
  column: number
  /** When true, scroll + select but do NOT focus the editor. Used by preview-style opens (e.g. workspace search keyboard nav). */
  preserveFocus?: boolean
}
