import { Show, createEffect } from 'solid-js'
import { autoSafe, loadProjectOverride, updateProjectOverride } from '../store/autoSafe'
import { RadioCard } from './RadioCard'
import { ChipList } from './ChipList'
import { BashPatternList } from './BashPatternList'
import type {
  AutoSafeProjectOverride as Override,
  ReadScope,
  WriteScope,
  WebSearchMode,
  WebFetchMode,
  McpMode,
} from '../types'

export interface AutoSafeProjectOverrideProps {
  projectId: string
}

type ReadKey = 'global' | ReadScope
type WriteKey = 'global' | WriteScope
type WebSearchKey = 'global' | WebSearchMode
type WebFetchKey = 'global' | WebFetchMode
type McpKey = 'global' | McpMode

export function AutoSafeProjectOverride(props: AutoSafeProjectOverrideProps) {
  createEffect(() => {
    void loadProjectOverride(props.projectId)
  })

  const ov = (): Override | undefined => autoSafe.overrides[props.projectId]

  const merge = async (patch: Partial<Override>) => {
    // Build the next override with the patch applied; remove keys whose
    // patch value is `undefined` so the override stays sparse.
    const current = ov() ?? { version: 1 as const }
    const next: Override = { ...current, version: 1, ...patch }
    for (const k of Object.keys(patch) as Array<keyof Override>) {
      if (patch[k] === undefined) {
        delete (next as unknown as Record<string, unknown>)[k]
      }
    }
    const isEmpty = Object.keys(next).filter((k) => k !== 'version').length === 0
    await updateProjectOverride(props.projectId, isEmpty ? null : next)
  }

  const readValue = (): ReadKey => ov()?.read?.scope ?? 'global'
  const writeValue = (): WriteKey => ov()?.write?.scope ?? 'global'
  const websearchValue = (): WebSearchKey => ov()?.websearch?.mode ?? 'global'
  const webfetchValue = (): WebFetchKey => ov()?.webfetch?.mode ?? 'global'
  const mcpValue = (): McpKey => ov()?.mcp?.mode ?? 'global'

  return (
    <Show when={autoSafe.hydrated} fallback={<div class="text-sm text-text-dim">Loading…</div>}>
      <div class="flex flex-col gap-4">
        <header>
          <h3 class="text-sm font-medium">Auto-safe policy override</h3>
          <p class="text-xs text-text-dim">Override global auto-safe settings for this project.</p>
        </header>

        <RadioCard<ReadKey>
          title="Read tools"
          value={readValue()}
          options={[
            { value: 'global', label: `Use global setting (${autoSafe.global.read.scope})` },
            { value: 'repo', label: 'Anywhere in the repo' },
            { value: 'any', label: 'Anywhere on disk' },
            { value: 'ask', label: 'Always ask' },
          ]}
          onChange={(v) => merge({ read: v === 'global' ? undefined : { scope: v } })}
        />

        <RadioCard<WriteKey>
          title="Write tools"
          value={writeValue()}
          options={[
            { value: 'global', label: `Use global setting (${autoSafe.global.write.scope})` },
            { value: 'worktree', label: 'Inside the worktree only' },
            { value: 'repo', label: 'Anywhere in the repo' },
            { value: 'any', label: 'Anywhere on disk' },
            { value: 'ask', label: 'Always ask' },
          ]}
          onChange={(v) => merge({ write: v === 'global' ? undefined : { scope: v } })}
        />

        <RadioCard<WebSearchKey>
          title="Web search"
          value={websearchValue()}
          options={[
            { value: 'global', label: `Use global setting (${autoSafe.global.websearch.mode})` },
            { value: 'allow', label: 'Auto-allow' },
            { value: 'ask', label: 'Always ask' },
          ]}
          onChange={(v) => merge({ websearch: v === 'global' ? undefined : { mode: v } })}
        />

        <RadioCard<WebFetchKey>
          title="Web fetch"
          value={webfetchValue()}
          options={[
            { value: 'global', label: `Use global setting (${autoSafe.global.webfetch.mode})` },
            { value: 'allow', label: 'Auto-allow any URL' },
            {
              value: 'domains',
              label: 'Auto-allow these domains only:',
              child: (
                <ChipList
                  values={ov()?.webfetch?.domains ?? []}
                  onChange={(domains) => merge({ webfetch: { mode: 'domains', domains } })}
                  placeholder="Add domain"
                />
              ),
            },
            { value: 'ask', label: 'Always ask' },
          ]}
          onChange={(v) =>
            merge({
              webfetch:
                v === 'global'
                  ? undefined
                  : { mode: v, domains: ov()?.webfetch?.domains ?? [] },
            })
          }
        />

        <RadioCard<McpKey>
          title="MCP tools"
          value={mcpValue()}
          options={[
            { value: 'global', label: `Use global setting (${autoSafe.global.mcp.mode})` },
            { value: 'allow', label: 'Auto-allow any server' },
            {
              value: 'servers',
              label: 'Auto-allow these servers only:',
              child: (
                <ChipList
                  values={ov()?.mcp?.servers ?? []}
                  onChange={(servers) => merge({ mcp: { mode: 'servers', servers } })}
                  placeholder="Add server"
                />
              ),
            },
            { value: 'ask', label: 'Always ask' },
          ]}
          onChange={(v) =>
            merge({
              mcp:
                v === 'global'
                  ? undefined
                  : { mode: v, servers: ov()?.mcp?.servers ?? [] },
            })
          }
        />

        <BashPatternList
          mode="project"
          global={autoSafe.global.bash.patterns}
          projectBash={ov()?.bash ?? { disabledGlobal: [], extra: [] }}
          onProjectBashChange={(bash) => merge({ bash })}
        />
      </div>
    </Show>
  )
}
