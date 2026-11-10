// ?fixture=chat: one realistic chat-mode turn - prose with headings, lists,
// inline file paths (with line numbers), links, a code block, tool rows
// (one with long output), thinking, an error turn and a diff summary - so
// chat UX can be judged on real content instead of user bubbles alone.
import type { OutputItem } from '../types'

const SESSION = 'demo-sess-md-1'

export async function seedChat() {
  const { DEMO_OUTPUT_LINES } = await import('../lib/seedData')
  const now = Date.now()
  const tool = (id: string, name: string, input: object): OutputItem => ({ kind: 'toolStart', tool: name, input: JSON.stringify(input, null, 2), id })
  const result = (id: string, text: string, isError = false): OutputItem => ({ kind: 'toolResult', text, isError, toolUseId: id })
  const longLog = Array.from({ length: 60 }, (_, i) => ` ✓ src/lib/markdown.test.ts > renders case ${i + 1} (${3 + (i % 7)}ms)`).join('\n')
  const items: OutputItem[] = [
    { kind: 'userMessage', text: 'Code blocks in chat render as plain text. Find out why and fix it, then add line numbers.', timestamp: now - 600_000 },
    { kind: 'thinking', text: 'The renderer is marked with a custom DOM pass. Highlighting probably never runs because the language class is stripped when we rebuild the HTML. Check markdown.ts and the code.css theme first.' },
    { kind: 'text', text: "I'll start with the markdown pipeline and the stylesheet." },
    tool('t1', 'Read', { file_path: '/Users/dev/verun/.verun/worktrees/fix-markdown/src/lib/markdown.ts' }),
    result('t1', '1\timport { marked } from \'marked\'\n2\timport hljs from \'highlight.js\'\n...'),
    tool('t2', 'Grep', { pattern: 'hljs', path: 'src' }),
    result('t2', 'src/lib/markdown.ts:2\nsrc/styles/code.css:1'),
    tool('t3', 'Bash', { command: 'pnpm vitest run src/lib/markdown.test.ts', description: 'Run the markdown tests' }),
    result('t3', longLog + '\n\n Test Files  1 passed (1)\n      Tests  60 passed (60)'),
    { kind: 'text', text: [
      '## What was wrong',
      '',
      'Highlighting never ran: `renderMarkdown` in `src/lib/markdown.ts:78` re-serialises the DOM after `marked` runs, and the `language-*` class was dropped on the way, so `hljs` had nothing to match. The theme in `src/styles/code.css` was fine.',
      '',
      '## What I changed',
      '',
      '1. Kept the language class when rebuilding code blocks (`src/lib/markdown.ts:84`).',
      '2. Ran highlight.js on each block after parsing, skipping blocks over 50 KB.',
      '3. Added line numbers as a CSS counter, so copying a block does not copy the numbers.',
      '',
      '```ts',
      "export function highlightBlocks(doc: Document) {",
      "  doc.querySelectorAll('pre code[class*=\"language-\"]').forEach(el => {",
      "    if ((el.textContent ?? '').length > 50_000) return",
      '    hljs.highlightElement(el as HTMLElement)',
      '  })',
      '}',
      '```',
      '',
      'See the [highlight.js docs](https://highlightjs.org/usage/) for the language list. All 60 markdown tests pass.',
      '',
      '| File | Change |',
      '| --- | --- |',
      '| `src/lib/markdown.ts` | keep language class, highlight |',
      '| `src/styles/code.css` | line-number counter |',
    ].join('\n') },
    { kind: 'turnEnd', status: 'completed', timestamp: now - 420_000, cost: 0.41, inputTokens: 18_200, outputTokens: 2_100, durationMs: 180_000 } as unknown as OutputItem,
    { kind: 'userMessage', text: 'Run the whole suite.', timestamp: now - 120_000 },
    tool('t4', 'Bash', { command: 'pnpm test', description: 'Run the full test suite' }),
    result('t4', 'FAIL src/components/ChatView.render.test.tsx > renders code with line numbers\nAssertionError: expected "1" to be undefined', true),
    { kind: 'text', text: 'One render test expected no line numbers. I updated `src/components/ChatView.render.test.tsx:212` to expect the counter and the suite passes now.' },
    { kind: 'turnEnd', status: 'completed', timestamp: now - 60_000, cost: 0.12, durationMs: 60_000 } as unknown as OutputItem,
  ]
  DEMO_OUTPUT_LINES[SESSION] = [{ id: 1, sessionId: SESSION, line: JSON.stringify({ type: 'verun_items', items }), emittedAt: now - 60_000 }]
}
