import { describe, expect, test } from 'vitest'
import { describeStep, shortPath, summarizeSteps } from './steps'

const text = (tool: string, input: Record<string, unknown>) => describeStep(tool, input).parts.map(p => p.text).join(' ')

describe('describeStep', () => {
  test('file steps read as a verb and a worktree-relative path', () => {
    const read = describeStep('Read', { file_path: '/Users/dev/app/.verun/worktrees/fix-x/src/lib/markdown.ts' })
    expect(read.kind).toBe('read')
    expect(read.parts).toEqual([{ text: 'Read', tone: 'verb' }, { text: 'src/lib/markdown.ts', tone: 'path' }])
  })

  test('edits and writes count the lines they add and remove', () => {
    const edit = describeStep('Edit', { file_path: '/repo/.verun/worktrees/a/src/a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree' })
    expect(text('Edit', { file_path: '/repo/.verun/worktrees/a/src/a.ts' })).toBe('Edited src/a.ts')
    expect([edit.added, edit.removed]).toEqual([3, 2])
    const multi = describeStep('MultiEdit', { file_path: '/x/a.ts', edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'd\ne', new_string: '' }] })
    expect([multi.added, multi.removed]).toEqual([2, 3])
    const write = describeStep('Write', { file_path: '/x/new.ts', content: 'a\nb\nc\n' })
    expect(write.parts[0].text).toBe('Wrote')
    expect([write.added, write.removed]).toEqual([3, 0])
  })

  test("a command reads as Claude's description of it; the command itself only when there is none", () => {
    expect(describeStep('Bash', { command: 'pnpm vitest run src/lib/markdown.test.ts', description: 'Run the markdown tests' }).parts).toEqual([
      { text: 'Run the markdown tests', tone: 'verb' },
    ])
    expect(text('Bash', { command: 'ls -la\necho done' })).toBe('Ran ls -la')
  })

  test('paths are relative to the worktree or the project, whichever holds them', () => {
    const roots = ['/Users/dev/app/.verun/worktrees/fix-x', '/Users/dev/app']
    expect(text('Read', { file_path: '/Users/dev/app/src/main.ts' })).toBe('Read ~/app/src/main.ts')
    expect(describeStep('Read', { file_path: '/Users/dev/app/src/main.ts' }, roots).parts[1].text).toBe('src/main.ts')
    const grep = describeStep('Grep', { pattern: 'x', path: '/Users/dev/app/.verun/worktrees/fix-x/src' }, roots).parts
    expect(grep[grep.length - 1].text).toBe('src')
  })

  test('searches show the pattern without regex escapes, and where', () => {
    expect(text('Grep', { pattern: 'visibleProjects\\(', path: 'src' })).toBe('Searched for visibleProjects( in src')
    expect(text('Glob', { pattern: 'src/**/*Search*.tsx' })).toBe('Found files src/**/*Search*.tsx')
  })

  test('web, MCP, skills and unknown tools still say what they did', () => {
    expect(text('WebFetch', { url: 'https://docs.github.com/en/actions?x=1' })).toBe('Fetched docs.github.com/en/actions')
    expect(text('WebSearch', { query: 'solid-js createStore' })).toBe('Searched the web for solid-js createStore')
    expect(text('mcp__verun__verun_list_tasks', {})).toBe('Used verun_list_tasks on verun')
    expect(text('Skill', { skill: 'impeccable' })).toBe('Used the impeccable skill')
    expect(text('TodoWrite', { todos: [] })).toBe('Updated the to-do list')
    expect(text('Frobnicate', { path: '/repo/x' })).toBe('Frobnicate /repo/x')
    expect(describeStep('Bash', undefined).parts[0].text).toBe('Ran')
  })
})

test('paths outside the worktree start from home', () => {
  expect(shortPath('/Users/dev/.claude/skills/x/SKILL.md')).toBe('~/.claude/skills/x/SKILL.md')
  expect(shortPath('/private/tmp/a.txt')).toBe('/private/tmp/a.txt')
})

test('a run of steps sums up by kind, in the order they first came', () => {
  expect(summarizeSteps([
    { tool: 'Read' }, { tool: 'Grep' }, { tool: 'Read' }, { tool: 'Bash' }, { tool: 'Read' }, { tool: 'Grep' },
  ])).toBe('Read 3 files, searched 2 times, ran 1 command')
  expect(summarizeSteps([{ tool: 'Edit' }, { tool: 'thinking' }])).toBe('Edited 1 file, thought')
  expect(summarizeSteps([{ tool: 'mcp__a__b' }, { tool: 'mcp__a__c' }])).toBe('Used 2 tools')
})
