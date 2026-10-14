import { expect, test } from 'vitest'
import { editorFilePath, isExternalFile } from './editorFilePath'
test('external tabs preserve their absolute path; workspace files resolve under the worktree', () => {
  expect(editorFilePath('/repo', '/private/tmp/notes.txt')).toBe('/private/tmp/notes.txt')
  expect(editorFilePath('/repo', 'src/main.ts')).toBe('/repo/src/main.ts')
  expect(isExternalFile('/private/tmp/notes.txt')).toBe(true)
  expect(isExternalFile('src/main.ts')).toBe(false)
})
