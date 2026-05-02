import type { FileStatus, ConflictKind } from '../types'

export type FileEntry =
  | { kind: 'conflict'; file: FileStatus }
  | { kind: 'staged'; file: FileStatus }
  | { kind: 'unstaged'; file: FileStatus }

export interface StatusBadge {
  letter: string
  colorClass: string
  label: string
  tooltip?: string
}

export function fanOut(file: FileStatus): FileEntry[] {
  if (file.conflict) {
    return [{ kind: 'conflict', file }]
  }
  if (file.indexStatus === '?' && file.worktreeStatus === '?') {
    return [{ kind: 'unstaged', file }]
  }
  const out: FileEntry[] = []
  if (file.indexStatus !== ' ' && file.indexStatus !== '?') {
    out.push({ kind: 'staged', file })
  }
  if (file.worktreeStatus !== ' ' && file.worktreeStatus !== '?') {
    out.push({ kind: 'unstaged', file })
  }
  return out
}

export function conflictLabel(kind: ConflictKind): string {
  switch (kind) {
    case 'bothModified': return 'Both modified'
    case 'bothAdded':    return 'Both added'
    case 'bothDeleted':  return 'Both deleted'
    case 'addedByUs':    return 'Added by us'
    case 'addedByThem':  return 'Added by them'
    case 'deletedByUs':  return 'Deleted by us'
    case 'deletedByThem':return 'Deleted by them'
  }
}

function badgeForChar(ch: string): { letter: string; colorClass: string; label: string } {
  switch (ch) {
    case 'A': return { letter: 'A', colorClass: 'text-emerald-400', label: 'Added' }
    case 'M': return { letter: 'M', colorClass: 'text-amber-400',   label: 'Modified' }
    case 'D': return { letter: 'D', colorClass: 'text-red-400',     label: 'Deleted' }
    case 'R': return { letter: 'R', colorClass: 'text-blue-400',    label: 'Renamed' }
    case 'C': return { letter: 'C', colorClass: 'text-blue-400',    label: 'Copied' }
    default:  return { letter: ch || '?', colorClass: 'text-text-muted', label: 'Unknown' }
  }
}

export function badgeForEntry(entry: FileEntry): StatusBadge {
  if (entry.kind === 'conflict' && entry.file.conflict) {
    const label = conflictLabel(entry.file.conflict)
    return {
      letter: '!',
      colorClass: 'text-red-400',
      label: 'Conflict',
      tooltip: label,
    }
  }
  const f = entry.file
  if (entry.kind === 'unstaged' && f.indexStatus === '?' && f.worktreeStatus === '?') {
    return { letter: 'U', colorClass: 'text-emerald-400', label: 'Untracked' }
  }
  if (entry.kind === 'staged') {
    const b = badgeForChar(f.indexStatus)
    return { ...b, label: `${b.label} (staged)` }
  }
  return badgeForChar(f.worktreeStatus)
}
