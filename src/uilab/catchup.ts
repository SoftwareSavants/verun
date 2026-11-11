// ?fixture=catchup: a long chat session you come back to after a while -
// many turns over hours, the last few finished since you last looked - plus
// the MCP mix a real Claude login brings (a dozen claude.ai connectors never
// signed in, one configured server that failed).
import type { OutputItem } from '../types'

const SESSION = 'demo-sess-md-1'

const PROMPTS = [
  'Code blocks in chat render as plain text. Find out why and fix it.',
  'Add line numbers to code blocks too.',
  'The copy button copies the line numbers. Fix that.',
  'Run the whole suite and fix whatever fails.',
  'Now make long code blocks collapsible after 40 lines.',
  'Check light theme contrast for the new styles.',
  'Open a PR with all of this.',
  'CI failed on the PR. Look into it.',
  'Rebase on main and push again.',
]

export async function seedCatchUp(seenTurns = 6) {
  const { DEMO_OUTPUT_LINES } = await import('../lib/seedData')
  const { setSessionMcpServers } = await import('../store/mcpServers')
  const now = Date.now()
  const items: OutputItem[] = []
  const start = now - PROMPTS.length * 40 * 60_000
  PROMPTS.forEach((prompt, t) => {
    const ts = start + t * 40 * 60_000
    const tool = (n: number, name: string, input: object, out: string): OutputItem[] => [
      { kind: 'toolStart', tool: name, input: JSON.stringify(input), id: `t${t}-${n}` },
      { kind: 'toolResult', text: out, isError: false, toolUseId: `t${t}-${n}` },
    ]
    items.push({ kind: 'userMessage', text: prompt, timestamp: ts } as OutputItem)
    items.push({ kind: 'text', text: `Looking at this now (step ${t + 1}).` })
    items.push(...tool(1, 'Read', { file_path: '/Users/dev/verun/.verun/worktrees/fix-markdown/src/lib/markdown.ts' }, '1\timport { marked } from \'marked\''))
    items.push(...tool(2, 'Grep', { pattern: 'hljs', path: 'src' }, 'src/lib/markdown.ts:2'))
    items.push(...tool(3, 'Edit', { file_path: '/Users/dev/verun/.verun/worktrees/fix-markdown/src/lib/markdown.ts' }, 'ok'))
    items.push(...tool(4, 'Bash', { command: 'pnpm vitest run src/lib', description: 'Run the lib tests' }, ' Test Files  12 passed (12)'))
    items.push({ kind: 'text', text: [
      `## Turn ${t + 1}: done`,
      '',
      `Handled "${prompt}" by changing \`src/lib/markdown.ts\` and its tests.`,
      '',
      '- Kept the language class through the DOM rebuild.',
      '- Moved the line numbers into a CSS counter.',
      '- All 312 tests pass.',
      '',
      'Nothing else changed. Next I would check the light theme, unless you want something else first.',
    ].join('\n') })
    items.push({ kind: 'turnEnd', status: 'completed', timestamp: ts + 6 * 60_000, cost: 0.2, durationMs: 6 * 60_000 } as unknown as OutputItem)
  })
  DEMO_OUTPUT_LINES[SESSION] = [{ id: 1, sessionId: SESSION, line: JSON.stringify({ type: 'verun_items', items }), emittedAt: now - 60_000 }]

  // What the user had read: everything up to the end of turn `seenTurns`.
  const seenAt = start + (seenTurns - 1) * 40 * 60_000 + 6 * 60_000
  try { localStorage.setItem('verun:chatSeen', JSON.stringify({ [SESSION]: seenAt })) } catch { /* ignore */ }

  const connectors = ['Apollo.io', 'Attio', 'Booking.com', 'Expedia', 'Google Drive', 'Kiwi.com', 'Otto Travel', 'Super.com', 'Tripadvisor', 'Trivago', 'Wyndham Hotels', 'lastminute.com']
  setSessionMcpServers(SESSION, [
    { name: 'context7', status: 'connected' },
    { name: 'claude-in-chrome', status: 'connected' },
    { name: 'claude.ai Moyasar', status: 'failed', error: 'No MCP endpoint was found at the URL provided.' },
    ...connectors.map(c => ({ name: `claude.ai ${c}`, status: 'needs-auth' })),
  ])
}
