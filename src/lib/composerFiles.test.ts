import { describe, test, expect } from 'vitest'
import { isImagePath, mentionPathForFile } from './composerFiles'

describe('isImagePath', () => {
  test('matches supported image extensions case-insensitively', () => {
    expect(isImagePath('/a/b.PNG')).toBe(true)
    expect(isImagePath('/a/b.jpeg')).toBe(true)
    expect(isImagePath('/a/b.webp')).toBe(true)
    expect(isImagePath('/a/b.pdf')).toBe(false)
    expect(isImagePath('/a/png')).toBe(false)
  })
})

describe('mentionPathForFile', () => {
  test('files inside the worktree become worktree-relative', () => {
    expect(mentionPathForFile('/w/task/src/a.ts', '/w/task')).toBe('src/a.ts')
    expect(mentionPathForFile('/w/task/src/a.ts', '/w/task/')).toBe('src/a.ts')
  })

  test('files outside the worktree stay absolute', () => {
    expect(mentionPathForFile('/Users/me/spec.pdf', '/w/task')).toBe('/Users/me/spec.pdf')
    expect(mentionPathForFile('/w/task-2/a.ts', '/w/task')).toBe('/w/task-2/a.ts')
    expect(mentionPathForFile('/Users/me/spec.pdf', null)).toBe('/Users/me/spec.pdf')
  })
})
