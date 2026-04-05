import * as ipc from '../lib/ipc'
import type { RepoInfo } from '../types'

export function useWorktree() {
  const getDiff = (taskId: string) =>
    ipc.getDiff(taskId)

  const merge = (taskId: string, targetBranch: string) =>
    ipc.mergeBranch(taskId, targetBranch)

  const getBranchStatus = (taskId: string) =>
    ipc.getBranchStatus(taskId)

  const getRepoInfo = (path: string): Promise<RepoInfo> =>
    ipc.getRepoInfo(path)

  return { getDiff, merge, getBranchStatus, getRepoInfo }
}
