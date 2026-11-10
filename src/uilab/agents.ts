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
