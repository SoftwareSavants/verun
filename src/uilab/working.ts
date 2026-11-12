// ?fixture=working: a session with three finished turns (each with a real work
// log: thinking, narration, reads, edits, commands, one failure) and a fourth
// turn still running, with a dozen tool calls and a subagent mid-flight. Lets
// chat UX be judged on scanning history and on live progress.
import type { OutputItem } from '../types'

const SESSION = 'demo-sess-md-1'
const WT = '/Users/dev/verun/.verun/worktrees/fix-markdown/'

export async function seedWorking() {
  const { DEMO_OUTPUT_LINES, DEMO_SESSIONS } = await import('../lib/seedData')
  const now = Date.now()
  let n = 0
  const tool = (name: string, input: object, result?: string, isError = false): OutputItem[] => {
    const id = `toolu_w${n++}`
    const start: OutputItem = { kind: 'toolStart', tool: name, input: JSON.stringify(input, null, 2), id }
    return result === undefined ? [start] : [start, { kind: 'toolResult', text: result, isError, toolUseId: id }]
  }
  const sub = (parent: string, items: OutputItem[]): OutputItem[] => items.map(item => ({ kind: 'subagent', parentToolUseId: parent, item }))
  const read = (path: string, lines = 120) => tool('Read', { file_path: WT + path }, Array.from({ length: 6 }, (_, i) => `${i + 1}\t// ${path} line ${i + 1}`).join('\n') + `\n… ${lines} lines`)
  const edit = (path: string, oldStr: string, newStr: string) => tool('Edit', { file_path: WT + path, old_string: oldStr, new_string: newStr }, `The file ${WT + path} has been updated.`)
  const bash = (command: string, description: string, result?: string, isError = false) => tool('Bash', { command, description }, result, isError)
  const pass = (files: number, tests: number) => ` Test Files  ${files} passed (${files})\n      Tests  ${tests} passed (${tests})\n   Duration  2.41s`
  const turn = (startMin: number, endMin: number, user: string, body: OutputItem[]): OutputItem[] => [
    { kind: 'userMessage', text: user, timestamp: now - startMin * 60_000 },
    ...body,
    { kind: 'turnEnd', status: 'completed', timestamp: now - endMin * 60_000, cost: 0.42, inputTokens: 48_200, outputTokens: 3_900, cacheReadTokens: 210_000, cacheWriteTokens: 12_400 },
  ]

  const items: OutputItem[] = [
    ...turn(52, 47.8, 'The sidebar search misses projects with an accent in their name. Find out why and fix it.', [
      { kind: 'thinking', text: 'Search lowercases the query but compares it with raw names, so "é" never matches "e". Check projectSections first, then where the query is set.' },
      { kind: 'text', text: "I'll trace the project search from the input to the filter." },
      ...read('src/store/projectGroups.ts', 76),
      ...tool('Grep', { pattern: 'projectQuery', path: 'src' }, 'src/store/projectGroups.ts:18\nsrc/components/ProjectGroups.tsx:64\nsrc/components/Sidebar.tsx:490'),
      ...read('src/components/Sidebar.tsx', 676),
      ...edit('src/store/projectGroups.ts', "const query = projectQuery().trim().toLowerCase()", "const query = fold(projectQuery().trim())\n  const fold = (s: string) => s.normalize('NFD').replace(/\\p{M}/gu, '').toLowerCase()"),
      ...bash('pnpm vitest run src/store/projectGroups.test.ts', 'Run the project group tests', pass(1, 7)),
      { kind: 'text', text: 'Fixed: project search now folds accents before comparing, so **Médecin** matches `medecin`. The change is in `projectSections` (src/store/projectGroups.ts:65), with a test for accented names. All 7 group tests pass.' },
    ]),
    ...turn(46, 44.3, 'Commit that and open a PR.', [
      { kind: 'text', text: 'Committing on the branch and opening the PR.' },
      ...bash('git add -A && git commit -m "Fold accents in project search"', 'Commit the fix', '[accent-search 3f2a9c1] Fold accents in project search\n 2 files changed, 18 insertions(+), 2 deletions(-)'),
      ...bash('git push -u origin accent-search', 'Push the branch', "branch 'accent-search' set up to track 'origin/accent-search'."),
      ...bash('gh pr create --fill', 'Open the PR', 'https://github.com/acme/verun/pull/312'),
      { kind: 'text', text: 'Opened [#312](https://github.com/acme/verun/pull/312): Fold accents in project search. CI is running.' },
    ]),
    ...turn(31, 28.9, 'CI failed on lint, can you check?', [
      ...bash('gh pr checks 312', "Check the PR's CI", 'lint\tfail\t41s\nbuild\tpass\t2m10s\ntest\tpass\t3m02s'),
      ...bash('pnpm lint', 'Run the linter', "src/store/projectGroups.ts\n  66:9  error  'normalize' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)", true),
      ...edit('src/store/projectGroups.ts', "const normalize = (s: string) => s.toLowerCase()\n", ''),
      ...bash('pnpm lint', 'Run the linter', '✓ No problems'),
      ...bash('git commit -am "Drop unused helper" && git push', 'Commit and push the lint fix', '[accent-search 8c41d07] Drop unused helper\n 1 file changed, 1 deletion(-)'),
      { kind: 'text', text: 'Lint failed on an unused helper left from the first attempt. I removed it and pushed; all three checks are green now.' },
    ]),
    { kind: 'userMessage', text: 'Now make the search match task names too, and show which project each match is in.', timestamp: now - 6 * 60_000 },
    { kind: 'thinking', text: 'Task matches need their project for context. visibleProjects feeds both the sidebar and the board, so map its callers before changing the shape.' },
    { kind: 'text', text: "I'll look at how search results render, then extend the matcher to tasks." },
    ...read('src/components/Sidebar.tsx', 676),
    ...read('src/store/projectGroups.ts', 77),
    ...tool('Grep', { pattern: 'visibleProjects', path: 'src' }, 'src/components/Sidebar.tsx:150\nsrc/components/Layout.tsx:3\nsrc/components/TaskBoard.tsx:41'),
    ...read('src/store/tasks.ts', 412),
    ...tool('Glob', { pattern: 'src/**/*Search*.tsx' }, 'src/components/GlobalSearchPanel.tsx'),
    ...bash('pnpm vitest run src/store', 'Run the store tests', pass(38, 412)),
    { kind: 'text', text: 'Search only covers projects today. A subagent will map every caller of `visibleProjects` while I write the task matcher.' },
    ...tool('Agent', { description: 'Map callers of visibleProjects', subagent_type: 'Explore', prompt: 'Find every caller of visibleProjects and what each expects back.' }),
    { kind: 'agentProgress', taskId: 'task-map', toolUseId: `toolu_w${n - 1}`, taskType: 'local_agent', status: 'running', description: 'Map callers of visibleProjects', subagentType: 'Explore', startedAt: now - 3 * 60_000 },
  ]
  const agentId = `toolu_w${n - 1}`
  items.push(
    ...sub(agentId, [{ kind: 'text', text: 'Starting with the sidebar and the board, then the layout shortcuts.' }]),
    ...sub(agentId, tool('Grep', { pattern: 'visibleProjects\\(', path: 'src' }, 'src/components/Sidebar.tsx:150\nsrc/components/Sidebar.tsx:153\nsrc/components/Layout.tsx:118\nsrc/components/TaskBoard.tsx:41')),
    ...sub(agentId, read('src/components/Sidebar.tsx', 676)),
    ...sub(agentId, read('src/components/TaskBoard.tsx', 233)),
    ...sub(agentId, tool('Grep', { pattern: 'projectQuery', path: 'src/components' }, 'src/components/ProjectGroups.tsx:64\nsrc/components/Sidebar.tsx:490')),
    ...sub(agentId, tool('Read', { file_path: WT + 'src/components/Layout.tsx' })),
    { kind: 'agentProgress', taskId: 'task-map', toolUses: 5, totalTokens: 18_400, lastToolName: 'Read', summary: 'reading Layout.tsx' },
    ...edit('src/store/projectGroups.ts', 'export function visibleProjects', '/** Projects in scope, with the tasks that matched the search. */\nexport function visibleProjects'),
    ...edit('src/components/Sidebar.tsx', '<span class="block text-xs text-text-primary truncate">{project.name}</span>', '<span class="block text-xs text-text-primary truncate">{project.name}</span>\n<TaskMatches project={project} />'),
    ...bash('pnpm vitest run src/store/projectGroups.test.ts', 'Run the project group tests'),
  )

  // Only this conversation: the demo seed's earlier prompts have no replies.
  DEMO_OUTPUT_LINES[SESSION] = [{ id: 1, sessionId: SESSION, line: JSON.stringify({ type: 'verun_items', items }), emittedAt: now - 60_000 }]
  const session = DEMO_SESSIONS.find(s => s.id === SESSION)
  if (session) session.status = 'running'
  // The session store settles its statuses after loading; say it's running once the app is up.
  const { emit } = await import('@tauri-apps/api/event')
  for (const ms of [1200, 2500]) setTimeout(() => { void emit('session-status', { sessionId: SESSION, status: 'running' }) }, ms)
}
