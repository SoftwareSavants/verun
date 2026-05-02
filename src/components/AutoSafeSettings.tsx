import { Show } from 'solid-js'
import { autoSafe, updateGlobal } from '../store/autoSafe'
import { RadioCard } from './RadioCard'
import { ChipList } from './ChipList'
import { BashPatternList } from './BashPatternList'
import { HARD_BLOCK_PATTERNS } from '../types'
import type {
  AutoSafePolicy,
  ReadScope,
  WriteScope,
  WebSearchMode,
  WebFetchMode,
  McpMode,
} from '../types'

const READ_OPTS = [
  { value: 'repo', label: 'Anywhere in the repo' },
  { value: 'any', label: 'Anywhere on disk' },
  { value: 'ask', label: 'Always ask' },
] as const satisfies ReadonlyArray<{ value: ReadScope; label: string }>

const WRITE_OPTS = [
  { value: 'worktree', label: 'Inside the worktree only' },
  { value: 'repo', label: 'Anywhere in the repo' },
  { value: 'any', label: 'Anywhere on disk' },
  { value: 'ask', label: 'Always ask' },
] as const satisfies ReadonlyArray<{ value: WriteScope; label: string }>

export function AutoSafeSettings() {
  const set = (next: Partial<AutoSafePolicy>) => updateGlobal({ ...autoSafe.global, ...next })

  return (
    <Show when={autoSafe.hydrated} fallback={<div class="p-4 text-sm text-text-dim">Loading…</div>}>
      <div class="flex flex-col gap-4 p-4">
        <header>
          <h2 class="text-base font-medium">Auto-safe policy</h2>
          <p class="text-xs text-text-dim">Controls which tool calls Claude can run without asking. Project settings can override these.</p>
        </header>

        <RadioCard<ReadScope>
          title="Read tools"
          description="Read, Glob, Grep, LSP — where Claude is allowed to read files without asking."
          value={autoSafe.global.read.scope}
          options={READ_OPTS}
          onChange={(scope) => set({ read: { scope } })}
        />

        <RadioCard<WriteScope>
          title="Write tools"
          description="Edit, Write, NotebookEdit — where Claude is allowed to modify files without asking."
          value={autoSafe.global.write.scope}
          options={WRITE_OPTS}
          onChange={(scope) => set({ write: { scope } })}
        />

        <RadioCard<WebSearchMode>
          title="Web search"
          description="WebSearch — searching the web without asking."
          value={autoSafe.global.websearch.mode}
          options={[
            { value: 'allow', label: 'Auto-allow' },
            { value: 'ask', label: 'Always ask' },
          ]}
          onChange={(mode) => set({ websearch: { mode } })}
        />

        <RadioCard<WebFetchMode>
          title="Web fetch"
          description="WebFetch — fetching URLs without asking."
          value={autoSafe.global.webfetch.mode}
          options={[
            { value: 'allow', label: 'Auto-allow any URL' },
            {
              value: 'domains',
              label: 'Auto-allow these domains only:',
              child: (
                <ChipList
                  values={autoSafe.global.webfetch.domains}
                  onChange={(domains) => set({ webfetch: { mode: 'domains', domains } })}
                  placeholder="Add domain (e.g. github.com)"
                />
              ),
            },
            { value: 'ask', label: 'Always ask' },
          ]}
          onChange={(mode) =>
            set({ webfetch: { mode, domains: autoSafe.global.webfetch.domains } })
          }
        />

        <RadioCard<McpMode>
          title="MCP tools"
          description="Tools provided by MCP servers."
          value={autoSafe.global.mcp.mode}
          options={[
            { value: 'allow', label: 'Auto-allow any server' },
            {
              value: 'servers',
              label: 'Auto-allow these servers only:',
              child: (
                <ChipList
                  values={autoSafe.global.mcp.servers}
                  onChange={(servers) => set({ mcp: { mode: 'servers', servers } })}
                  placeholder="Add server (e.g. atlassian)"
                />
              ),
            },
            { value: 'ask', label: 'Always ask' },
          ]}
          onChange={(mode) => set({ mcp: { mode, servers: autoSafe.global.mcp.servers } })}
        />

        <BashPatternList
          mode="global"
          patterns={autoSafe.global.bash.patterns}
          hardBlocks={HARD_BLOCK_PATTERNS}
          builtinSuggestions={autoSafe.defaults.bash.patterns.map((p) => ({
            id: p.id,
            label: p.pattern,
          }))}
          onChange={(patterns) => set({ bash: { patterns } })}
        />
      </div>
    </Show>
  )
}
