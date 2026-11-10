// ?fixture=agents: one demo session whose turn spawned three subagents (one
// still running in the background, one done, one failed) with their own
// nested actions and live progress, left in the 'background' state so the
// agent strip above the composer shows.
import type { OutputItem } from '../types'

const SESSION = 'demo-sess-md-1'

/** `flat`: the same conversation as pre-0.16.1 Verun stored it (subagent items
 * flattened into the main list, no progress items), for before/after comparisons. */
export async function seedAgents(flat = false) {
  const { DEMO_OUTPUT_LINES, DEMO_SESSIONS } = await import('../lib/seedData')
  const now = Date.now()
  const sub = (parent: string, item: OutputItem): OutputItem => ({ kind: 'subagent', parentToolUseId: parent, item })
  const agent = (id: string, input: object): OutputItem => ({ kind: 'toolStart', tool: 'Agent', input: JSON.stringify(input, null, 2), id })
  const items: OutputItem[] = [
    { kind: 'userMessage', text: 'Review the chat renderer change, run the tests, and check the docs links.', timestamp: now - 260_000 },
    { kind: 'text', text: "I'll split this across three agents so they run in parallel." },
    agent('toolu_review', { description: 'Review ChatView diff', subagent_type: 'code-reviewer', prompt: 'Review the diff', run_in_background: true }),
    { kind: 'agentProgress', taskId: 'task-review', toolUseId: 'toolu_review', taskType: 'local_agent', status: 'running', description: 'Review ChatView diff', subagentType: 'code-reviewer', isBackgrounded: true, startedAt: now - 252_000 },
    agent('toolu_tests', { description: 'Run the frontend tests', subagent_type: 'test-runner', prompt: 'Run pnpm test' }),
    { kind: 'agentProgress', taskId: 'task-tests', toolUseId: 'toolu_tests', taskType: 'local_agent', status: 'running', description: 'Run the frontend tests', subagentType: 'test-runner', startedAt: now - 250_000 },
    agent('toolu_links', { description: 'Check docs links', prompt: 'Find broken links' }),
    { kind: 'agentProgress', taskId: 'task-links', toolUseId: 'toolu_links', taskType: 'local_agent', status: 'running', description: 'Check docs links', startedAt: now - 249_000 },
    sub('toolu_review', { kind: 'text', text: 'Starting with the block builder and its tests.' }),
    sub('toolu_review', { kind: 'toolStart', tool: 'Read', input: '{"file_path":"/Users/dev/verun/src/components/ChatView.tsx"}', id: 'toolu_r1' }),
    sub('toolu_tests', { kind: 'toolStart', tool: 'Bash', input: '{"command":"pnpm test --run"}', id: 'toolu_t1' }),
    sub('toolu_links', { kind: 'toolStart', tool: 'Grep', input: '{"pattern":"\\\\]\\\\(http"}', id: 'toolu_l1' }),
    sub('toolu_review', { kind: 'toolResult', text: '1703 lines', isError: false, toolUseId: 'toolu_r1' }),
    sub('toolu_review', { kind: 'toolStart', tool: 'Read', input: '{"file_path":"/Users/dev/verun/src/types/index.ts"}', id: 'toolu_r2' }),
    sub('toolu_links', { kind: 'toolResult', text: 'docs/setup.md:12\ndocs/release.md:40', isError: false, toolUseId: 'toolu_l1' }),
    sub('toolu_tests', { kind: 'toolResult', text: 'Test Files  212 passed (212)\n     Tests  2048 passed (2048)', isError: false, toolUseId: 'toolu_t1' }),
    { kind: 'agentProgress', taskId: 'task-review', toolUses: 12, totalTokens: 41_200, lastToolName: 'Read', summary: 'reading types.ts' },
    { kind: 'toolResult', text: 'All 2048 tests pass across 212 files.\nNo snapshots changed.', isError: false, toolUseId: 'toolu_tests' },
    { kind: 'agentProgress', taskId: 'task-tests', status: 'completed', toolUses: 1, totalTokens: 8_400, endedAt: now - 190_000 },
    { kind: 'toolResult', text: 'Rate limited by docs host after 2 requests', isError: true, toolUseId: 'toolu_links' },
    { kind: 'agentProgress', taskId: 'task-links', status: 'failed', error: 'Rate limited by docs host after 2 requests', toolUses: 2, endedAt: now - 230_000 },
    { kind: 'agentProgress', taskId: 'task-shell', toolUseId: 'toolu_dev', taskType: 'local_bash', status: 'running', description: 'pnpm dev', startedAt: now - 600_000 },
    { kind: 'text', text: 'Tests pass and the link check failed on a rate limit. The reviewer is still working in the background; I will pick up its findings when it reports back.' },
    { kind: 'turnEnd', status: 'completed', timestamp: now - 180_000 },
  ]
  const shown = flat
    ? items.flatMap(i => i.kind === 'subagent' ? [i.item] : i.kind === 'agentProgress' ? [] : [i])
    : items
  const lines = DEMO_OUTPUT_LINES[SESSION]
  const lastId = lines.length ? lines[lines.length - 1].id : 0
  lines.push({ id: lastId + 1, sessionId: SESSION, line: JSON.stringify({ type: 'verun_items', items: shown }), emittedAt: now - 180_000 })
  const session = DEMO_SESSIONS.find(s => s.id === SESSION)
  if (session) session.status = 'background'
}

/** ?fixture=agents-resumed: the 0.16.1 report. An implementer stopped when
 * the last session ended, and Claude resumed it with SendMessage. */
export async function seedResumedAgent() {
  const { DEMO_OUTPUT_LINES, DEMO_SESSIONS } = await import('../lib/seedData')
  const now = Date.now()
  const sub = (parent: string, item: OutputItem): OutputItem => ({ kind: 'subagent', parentToolUseId: parent, item })
  const bash = (id: string, command: string): OutputItem => ({ kind: 'toolStart', tool: 'Bash', input: JSON.stringify({ command }), id })
  const items: OutputItem[] = [
    { kind: 'userMessage', text: 'Implement Task 15', timestamp: now - 900_000 },
    { kind: 'toolStart', tool: 'Agent', id: 'toolu_impl', input: JSON.stringify({ description: 'Implement Task 15 (invoice gets quote options)', subagent_type: 'general-purpose', prompt: 'Implement', run_in_background: true }, null, 2) },
    { kind: 'agentProgress', taskId: 'task-impl', toolUseId: 'toolu_impl', taskType: 'local_agent', status: 'running', description: 'Implement Task 15 (invoice gets quote options)', subagentType: 'general-purpose', isBackgrounded: true, startedAt: now - 890_000 },
    { kind: 'toolResult', text: 'Launched', isError: false, toolUseId: 'toolu_impl' },
    sub('toolu_impl', { kind: 'toolStart', tool: 'Edit', input: '{"file_path":"/Users/dev/app/src/lib/invoicePdf.ts"}', id: 'toolu_e1' }),
    sub('toolu_impl', { kind: 'toolResult', text: 'ok', isError: false, toolUseId: 'toolu_e1' }),
    { kind: 'agentProgress', taskId: 'task-impl', status: 'stopped', summary: 'Background agent "Implement Task 15 (invoice gets quote options)" didn\'t finish before the previous session ended', endedAt: now - 300_000 },
    { kind: 'turnEnd', status: 'completed', timestamp: now - 880_000 },
    { kind: 'userMessage', text: 'continue', timestamp: now - 60_000 },
    { kind: 'text', text: "Picking up where the session stopped: the Task 15 implementer was interrupted mid-run. I'll check how much of Task 15 reached the working tree before resuming it." },
    bash('toolu_b1', 'git status --short'),
    { kind: 'toolResult', text: ' M src/lib/invoicePdf.ts', isError: false, toolUseId: 'toolu_b1' },
    { kind: 'toolStart', tool: 'SendMessage', id: 'toolu_send', input: JSON.stringify({ to: 'task-impl', message: 'Resume Task 15. The session was interrupted before you reported.' }, null, 2) },
    { kind: 'agentProgress', taskId: 'task-impl', toolUseId: 'toolu_send', taskType: 'local_agent', status: 'running', description: 'Implement Task 15 (invoice gets quote options)', subagentType: 'general-purpose', isBackgrounded: true, startedAt: now - 33_000 },
    { kind: 'toolResult', text: '{"success":true,"message":"Resuming agent"}', isError: false, toolUseId: 'toolu_send' },
    { kind: 'text', text: "The Task 15 implementer has resumed to finish its work and run the checks. When it reports, I'll snapshot and send it to review as usual." },
    { kind: 'turnEnd', status: 'completed', timestamp: now - 30_000 },
    sub('toolu_impl', { kind: 'text', text: 'Resuming. First, confirming the tree is as I left it.' }),
    ...Array.from({ length: 14 }, (_, i) => [
      sub('toolu_impl', bash(`toolu_s${i}`, `pnpm exec vitest run src/lib/invoicePdf.test.ts -t "case ${i + 1}"`)),
      sub('toolu_impl', { kind: 'toolResult', text: `✓ invoicePdf > case ${i + 1} (${12 + i}ms)\n\nTest Files  1 passed (1)\n     Tests  1 passed (1)`, isError: false, toolUseId: `toolu_s${i}` }),
    ]).flat(),
    sub('toolu_impl', bash('toolu_r1', 'git status --short -- src/lib')),
    { kind: 'agentProgress', taskId: 'task-impl', toolUseId: 'toolu_send', activity: 'Confirm the revert and the working-tree state', lastToolName: 'Bash', toolUses: 1, totalTokens: 396_451 },
  ]
  const lines = DEMO_OUTPUT_LINES[SESSION]
  const lastId = lines.length ? lines[lines.length - 1].id : 0
  lines.push({ id: lastId + 1, sessionId: SESSION, line: JSON.stringify({ type: 'verun_items', items }), emittedAt: now - 30_000 })
  const session = DEMO_SESSIONS.find(s => s.id === SESSION)
  if (session) session.status = 'background'
}
