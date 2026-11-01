const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i

/** Images the composer attaches inline; everything else becomes an @-mention. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXT_RE.test(path)
}

/** Worktree-relative path for files inside the task's worktree, absolute otherwise. */
export function mentionPathForFile(path: string, worktreePath: string | null | undefined): string {
  if (!worktreePath) return path
  const root = worktreePath.endsWith('/') ? worktreePath : `${worktreePath}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}
