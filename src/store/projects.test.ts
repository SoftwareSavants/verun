import { describe, test, expect, beforeEach } from 'vitest'
import { projects, setProjects, projectById } from './projects'
import type { Project } from '../types'

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'p-001',
  name: 'my-app',
  repoPath: '/tmp/my-app',
  baseBranch: 'main',
  createdAt: 1000,
  ...overrides,
})

describe('projects store', () => {
  beforeEach(() => {
    setProjects([])
  })

  test('starts empty', () => {
    expect(projects.length).toBe(0)
  })

  test('setProjects populates the store', () => {
    setProjects([makeProject()])
    expect(projects.length).toBe(1)
    expect(projects[0].id).toBe('p-001')
  })

  test('projectById finds the correct project', () => {
    setProjects([
      makeProject({ id: 'p-001', name: 'first' }),
      makeProject({ id: 'p-002', name: 'second', repoPath: '/tmp/second' }),
    ])
    expect(projectById('p-002')?.name).toBe('second')
  })

  test('projectById returns undefined for missing id', () => {
    setProjects([makeProject()])
    expect(projectById('nope')).toBeUndefined()
  })

  test('filtering projects works', () => {
    setProjects([
      makeProject({ id: '1', repoPath: '/a' }),
      makeProject({ id: '2', repoPath: '/b' }),
      makeProject({ id: '3', repoPath: '/c' }),
    ])
    setProjects(prev => prev.filter(p => p.id !== '2'))
    expect(projects.length).toBe(2)
    expect(projects.map(p => p.id)).toEqual(['1', '3'])
  })
})
