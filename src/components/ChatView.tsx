import { Component, For, Show, createEffect, on, createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import { clsx } from 'clsx'
import { marked } from 'marked'
import type { OutputItem, SessionStatus } from '../types'
import { ChevronDown, ChevronRight, Terminal, AlertCircle, CheckCircle, AlertTriangle, Copy, Check } from 'lucide-solid'

marked.setOptions({ breaks: true, gfm: true })

function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string
}

interface Props {
  output: OutputItem[]
  sessionStatus?: SessionStatus
}

// ---------------------------------------------------------------------------
// Stable block store — only mutates existing blocks or appends new ones
// ---------------------------------------------------------------------------

interface UserBlock {
  type: 'user'
  text: string
  images?: Array<{ mimeType: string; dataBase64: string }>
}
interface AssistantBlock {
  type: 'assistant'
  text: string
}
interface ThinkingBlock {
  type: 'thinking'
  id: string
  text: string
}
interface ToolBlock {
  type: 'tool'
  id: string
  tool: string
  input: string
  result: { text: string; isError: boolean } | undefined
}
interface SystemBlock {
  type: 'system'
  text: string
}

type DisplayBlock = UserBlock | AssistantBlock | ThinkingBlock | ToolBlock | SystemBlock

function rebuildBlocks(items: OutputItem[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = []
  let currentText = ''
  let currentThinking = ''

  const flushText = () => {
    if (currentText) {
      blocks.push({ type: 'assistant', text: currentText })
      currentText = ''
    }
  }
  const flushThinking = () => {
    if (currentThinking) {
      blocks.push({ type: 'thinking', id: `thinking-${thinkingCounter++}`, text: currentThinking })
      currentThinking = ''
    }
  }

  const lastOpenTool = (): ToolBlock | undefined => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b.type === 'tool' && !b.result) return b
      if (b.type !== 'tool') break
    }
    return undefined
  }

  let toolCounter = 0
  let thinkingCounter = 0

  for (const item of items) {
    switch (item.kind) {
      case 'text':
        flushThinking()
        currentText += item.text
        break
      case 'thinking':
        flushText()
        currentThinking += item.text
        break
      case 'userMessage':
        flushText(); flushThinking()
        blocks.push({ type: 'user', text: item.text, images: item.images })
        break
      case 'toolStart':
        flushText(); flushThinking()
        blocks.push({ type: 'tool', id: `tool-${toolCounter++}`, tool: item.tool, input: item.input, result: undefined })
        break
      case 'toolResult': {
        flushText(); flushThinking()
        const openTool = lastOpenTool()
        if (openTool) {
          openTool.result = { text: item.text, isError: item.isError }
        } else {
          blocks.push({ type: 'tool', id: `tool-${toolCounter++}`, tool: 'Tool', input: '', result: { text: item.text, isError: item.isError } })
        }
        break
      }
      case 'system':
        flushText(); flushThinking()
        blocks.push({ type: 'system', text: item.text })
        break
      case 'turnEnd':
        flushText(); flushThinking()
        if (item.status !== 'completed') {
          blocks.push({ type: 'system', text: `Turn ended: ${item.status}` })
        }
        break
      case 'raw':
        break
    }
  }
  flushText(); flushThinking()
  return blocks
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const CopyButton: Component<{ text: string }> = (props) => {
  const [copied, setCopied] = createSignal(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(props.text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      class="p-1 rounded-md text-text-dim hover:text-text-muted hover:bg-surface-2 transition-colors"
      onClick={handleCopy}
      title="Copy"
    >
      <Show when={copied()} fallback={<Copy size={13} />}>
        <Check size={13} class="text-status-running" />
      </Show>
    </button>
  )
}

const ThinkingBlockView: Component<{ id: string; text: string }> = (props) => {
  const [expanded, setExpanded] = createSignal(expandedThinking.get(props.id) ?? false)
  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    expandedThinking.set(props.id, next)
  }
  return (
    <div class="px-5 py-1">
      <div class="flex-1 min-w-0">
        <button
          class="flex items-center gap-1.5 text-xs text-text-dim hover:text-text-muted transition-colors"
          onClick={toggle}
        >
          <Show when={expanded()} fallback={<ChevronRight size={11} />}>
            <ChevronDown size={11} />
          </Show>
          <span class="italic">Thinking</span>
          <Show when={!expanded()}>
            <span class="text-text-dim/60 truncate max-w-sm">
              — {props.text.split('\n')[0].slice(0, 80)}
            </span>
          </Show>
        </button>
        <Show when={expanded()}>
          <pre
            class="text-xs text-text-dim whitespace-pre-wrap font-mono leading-relaxed mt-1.5 max-h-60 overflow-y-auto pl-4 border-l border-border-subtle"
            ref={(el) => {
              const saved = thinkingScrollPositions.get(props.id)
              if (saved) requestAnimationFrame(() => { el.scrollTop = saved })
            }}
            onScroll={(e) => {
              thinkingScrollPositions.set(props.id, e.currentTarget.scrollTop)
            }}
          >
            {props.text}
          </pre>
        </Show>
      </div>
    </div>
  )
}

// Stable UI state — survives block rebuilds
const expandedThinking = new Map<string, boolean>()
const thinkingScrollPositions = new Map<string, number>()
const expandedTools = new Map<string, boolean>()
const toolScrollPositions = new Map<string, { input: number; output: number }>()

const ToolBlockView: Component<{ id: string; tool: string; input: string; result?: { text: string; isError: boolean } }> = (props) => {
  const [expanded, setExpanded] = createSignal(expandedTools.get(props.id) ?? false)
  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    expandedTools.set(props.id, next)
  }
  const hasResult = () => !!props.result
  const isLongResult = () => (props.result?.text.split('\n').length || 0) > 8

  const statusIcon = () => {
    if (!hasResult()) return <div class="w-3 h-3 rounded-full border-2 border-accent/40 animate-pulse" />
    if (props.result!.isError) return <AlertCircle size={13} class="text-status-error" />
    return <CheckCircle size={13} class="text-status-running" />
  }

  return (
    <div class="px-5 py-1">
      <div class="flex-1 min-w-0 border border-border rounded-lg overflow-hidden bg-surface-1">
        <button
          class="w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-surface-2"
          onClick={toggle}
        >
          <Show when={expanded()} fallback={<ChevronRight size={11} class="text-text-dim" />}>
            <ChevronDown size={11} class="text-text-dim" />
          </Show>
          <Terminal size={11} class="text-accent" />
          <span class="font-medium text-accent">{props.tool}</span>
          <Show when={props.input && !expanded()}>
            <span class="text-text-dim truncate max-w-md font-mono text-[11px]">
              {props.input.split('\n')[0].slice(0, 60)}
            </span>
          </Show>
          <div class="ml-auto shrink-0">{statusIcon()}</div>
        </button>

        <Show when={expanded()}>
          <Show when={props.input}>
            <div class="border-t border-border">
              <pre
                class="text-[11px] text-text-muted whitespace-pre-wrap font-mono p-3 max-h-40 overflow-y-auto"
                ref={(el) => {
                  const saved = toolScrollPositions.get(props.id)
                  if (saved) requestAnimationFrame(() => { el.scrollTop = saved.input })
                }}
                onScroll={(e) => {
                  const prev = toolScrollPositions.get(props.id) || { input: 0, output: 0 }
                  toolScrollPositions.set(props.id, { ...prev, input: e.currentTarget.scrollTop })
                }}
              >
                {props.input}
              </pre>
            </div>
          </Show>
          <Show when={hasResult()}>
            <div class="border-t border-border">
              <pre
                class={clsx(
                  'text-[11px] whitespace-pre-wrap break-all font-mono p-3 max-w-full overflow-x-auto',
                  props.result!.isError ? 'text-status-error/80' : 'text-text-muted',
                  !isLongResult() ? '' : 'max-h-48 overflow-y-auto'
                )}
                ref={(el) => {
                  const saved = toolScrollPositions.get(props.id)
                  if (saved) requestAnimationFrame(() => { el.scrollTop = saved.output })
                }}
                onScroll={(e) => {
                  const prev = toolScrollPositions.get(props.id) || { input: 0, output: 0 }
                  toolScrollPositions.set(props.id, { ...prev, output: e.currentTarget.scrollTop })
                }}
              >
                {props.result!.text}
              </pre>
            </div>
          </Show>
        </Show>

        <Show when={!expanded() && hasResult()}>
          <div class="border-t border-border px-3 py-1.5">
            <pre class={clsx(
              'text-[11px] whitespace-pre-wrap break-all font-mono max-h-16 overflow-hidden truncate',
              props.result!.isError ? 'text-status-error/60' : 'text-text-dim'
            )}>
              {props.result!.text.split('\n').slice(0, 2).join('\n')}
            </pre>
          </div>
        </Show>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main ChatView
// ---------------------------------------------------------------------------

export const ChatView: Component<Props> = (props) => {
  let containerRef!: HTMLDivElement
  let autoScroll = true
  let scrollRafPending = false

  // Use a store for blocks so mutations are granular
  const [blocks, setBlocks] = createStore<DisplayBlock[]>([])
  let lastItemCount = 0

  // Rebuild blocks only when output items change
  createEffect(on(() => props.output.length, (len) => {
    if (len === 0 && lastItemCount !== 0) {
      setBlocks([])
      lastItemCount = 0
      return
    }
    if (len !== lastItemCount) {
      const newBlocks = rebuildBlocks(props.output)
      setBlocks(newBlocks)
      lastItemCount = len
      scheduleAutoScroll()
    }
  }))

  // Auto-scroll when session starts running (thinking dots appear)
  createEffect(on(() => props.sessionStatus, (status) => {
    if (status === 'running') scheduleAutoScroll()
  }))

  const scheduleAutoScroll = () => {
    if (!autoScroll || !containerRef || scrollRafPending) return
    scrollRafPending = true
    requestAnimationFrame(() => {
      scrollRafPending = false
      if (autoScroll && containerRef) {
        containerRef.scrollTop = containerRef.scrollHeight
      }
    })
  }

  const handleScroll = () => {
    if (!containerRef || scrollRafPending) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef
    autoScroll = scrollHeight - scrollTop - clientHeight < 30
  }

  return (
    <div
      ref={containerRef}
      class="w-full h-full overflow-y-auto overflow-x-hidden"
      onScroll={handleScroll}
    >
      <div class="flex flex-col gap-2 py-4">
        <Show when={props.sessionStatus === 'error'}>
          <div class="mx-5 flex items-center gap-2 px-3 py-2 rounded-lg bg-status-error/8 border border-status-error/15">
            <AlertTriangle size={14} class="text-status-error shrink-0" />
            <span class="text-xs text-status-error">Session encountered an error. Create a new session to continue.</span>
          </div>
        </Show>

        <For each={blocks}>
          {(block) => {
            switch (block.type) {
              case 'user':
                return (
                  <div class="flex justify-end px-5 py-1">
                    <div class="max-w-[75%] bg-accent/15 rounded-2xl rounded-br-lg border border-accent/10 overflow-hidden">
                      <Show when={block.images && block.images.length > 0}>
                        <div class="flex gap-1 p-2 pb-0">
                          <For each={block.images || []}>
                            {(img) => (
                              <img
                                src={`data:${img.mimeType};base64,${img.dataBase64}`}
                                class="max-h-48 max-w-64 rounded-lg object-contain"
                              />
                            )}
                          </For>
                        </div>
                      </Show>
                      <Show when={block.text}>
                        <div class="px-4 py-2.5 text-sm text-text-primary whitespace-pre-wrap leading-relaxed select-text">
                          {block.text}
                        </div>
                      </Show>
                    </div>
                  </div>
                )
              case 'assistant':
                return (
                  <div class="px-5 py-1 group">
                    <div
                      class="text-sm text-text-primary leading-relaxed prose-verun select-text break-words overflow-hidden"
                      innerHTML={renderMarkdown(block.text)}
                    />
                    <Show when={props.sessionStatus !== 'running'}>
                      <div class="opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
                        <CopyButton text={block.text} />
                      </div>
                    </Show>
                  </div>
                )
              case 'thinking':
                return <ThinkingBlockView id={(block as ThinkingBlock).id} text={block.text} />
              case 'tool':
                return <ToolBlockView id={block.id} tool={block.tool} input={block.input} result={block.result} />
              case 'system':
                return (
                  <div class="flex justify-center px-5 py-1">
                    <span class="text-[11px] text-text-dim">{block.text}</span>
                  </div>
                )
            }
          }}
        </For>

        <Show when={props.sessionStatus === 'running'}>
          <div class="px-5 py-2">
            <div class="thinking-dots">
              <span /><span /><span />
            </div>
          </div>
        </Show>

        <Show when={blocks.length === 0 && props.sessionStatus !== 'error'}>
          <div class="flex-1 flex items-center justify-center pt-20">
            <p class="text-sm text-text-dim">Send a message to start</p>
          </div>
        </Show>
      </div>
    </div>
  )
}
