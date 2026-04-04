import * as ipc from '../lib/ipc'

export function useWorktree() {
  const create = (repoPath: string, branch: string) =>
    ipc.createWorktree(repoPath, branch)

  const remove = (worktreePath: string) =>
    ipc.deleteWorktree(worktreePath)

  const list = (repoPath: string) =>
    ipc.listWorktrees(repoPath)

  const getDiff = (worktreePath: string) =>
    ipc.getDiff(worktreePath)

  const merge = (worktreePath: string, targetBranch: string) =>
    ipc.mergeBranch(worktreePath, targetBranch)

  return { create, remove, list, getDiff, merge }
}
