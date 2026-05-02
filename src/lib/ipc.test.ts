import { describe, test, expect } from 'vitest'
import * as ipc from './ipc'

describe('ipc', () => {
  test('all project functions are exported', () => {
    expect(typeof ipc.addProject).toBe('function')
    expect(typeof ipc.listProjects).toBe('function')
    expect(typeof ipc.deleteProject).toBe('function')
  })

  test('all task functions are exported', () => {
    expect(typeof ipc.createTask).toBe('function')
    expect(typeof ipc.listTasks).toBe('function')
    expect(typeof ipc.getTask).toBe('function')
    expect(typeof ipc.deleteTask).toBe('function')
    expect(typeof ipc.archiveTask).toBe('function')
    expect(typeof ipc.checkTaskWorktree).toBe('function')
    expect(typeof ipc.restoreTask).toBe('function')
  })

  test('all session functions are exported', () => {
    expect(typeof ipc.createSession).toBe('function')
    expect(typeof ipc.sendMessage).toBe('function')
    expect(typeof ipc.abortMessage).toBe('function')
    expect(typeof ipc.listSessions).toBe('function')
    expect(typeof ipc.getSession).toBe('function')
    expect(typeof ipc.getOutputLines).toBe('function')
  })

  test('all git/worktree functions are exported', () => {
    expect(typeof ipc.getDiff).toBe('function')
    expect(typeof ipc.mergeBranch).toBe('function')
    expect(typeof ipc.getBranchStatus).toBe('function')
    expect(typeof ipc.getRepoInfo).toBe('function')
  })

  test('consolidated GitHub wrappers are exported', () => {
    expect(typeof ipc.getGithubOverview).toBe('function')
    expect(typeof ipc.getGithubActions).toBe('function')
    expect(typeof ipc.getGithubWorkflowJobs).toBe('function')
    expect(typeof ipc.getGithubWorkflowLog).toBe('function')
  })

  test('utility functions are exported', () => {
    expect(typeof ipc.openInFinder).toBe('function')
  })

  test('all plugin functions are exported', () => {
    expect(typeof ipc.pluginIsSupported).toBe('function')
    expect(typeof ipc.pluginListCatalog).toBe('function')
    expect(typeof ipc.pluginListMarketplaces).toBe('function')
    expect(typeof ipc.pluginInstall).toBe('function')
    expect(typeof ipc.pluginUninstall).toBe('function')
    expect(typeof ipc.pluginSetEnabled).toBe('function')
    expect(typeof ipc.pluginReadManifest).toBe('function')
  })

  test('blob store wrappers are exported', () => {
    expect(typeof ipc.uploadAttachment).toBe('function')
    expect(typeof ipc.getBlob).toBe('function')
    expect(typeof ipc.getStorageStats).toBe('function')
  })
})
