/** Absolute tab keys identify files explicitly opened outside the workspace. */
export function isExternalFile(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}
export function editorFilePath(worktree: string, path: string): string {
  return isExternalFile(path) ? path : `${worktree}/${path}`
}
