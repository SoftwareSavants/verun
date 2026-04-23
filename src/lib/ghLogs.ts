// Parses the line-oriented log format emitted by `gh run view --log[-failed]`.
// Each raw line looks like:
//   "{JobName}\t{StepName}\t{BOM?}{ISO timestamp} {content}"
// where some setup lines report StepName as "UNKNOWN STEP". Content can embed
// Actions workflow commands (##[group], ##[error], ##[warning], …) and ANSI
// color escapes, both of which we normalize.

export type LogLevel =
  | 'info' | 'error' | 'warning' | 'notice' | 'debug' | 'command' | 'group' | 'endgroup'

export interface Annotation {
  file?: string
  line?: number
  col?: number
  endLine?: number
  endColumn?: number
  title?: string
}

export interface LogLine {
  step: string | null
  timestamp: string | null // ISO, null when the source didn't include one
  level: LogLevel
  text: string             // cleaned (no ANSI, no ##[...] prefix)
  annotation?: Annotation  // populated only for error/warning/notice with key=val::msg body
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?(.*)$/
const CMD_RE = /^##\[(error|warning|notice|debug|command|group|endgroup)\](.*)$/

// Heuristic detection of error/warning lines that GitHub Actions didn't flag
// as ##[error] / ##[warning] — e.g. rustc, cargo, eslint, tsc, npm all emit
// their diagnostics to stderr as plain text. Matched on the stripped content
// so the line is re-leveled from "info" to the appropriate severity.
const ERROR_RE = /^\s*(?:error(?:\[[^\]]+\])?:|ERR!|ERROR:|FAIL |FATAL:|\u2717 )/
const WARN_RE = /^\s*(?:warning(?:\[[^\]]+\])?:|WARN!|WARNING:)/

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// Workflow commands encode special characters so key=value,key=value parsing
// doesn't collide with values that contain commas, colons, or percent signs.
// Reference: https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions
function decodeGhValue(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

export function parseAnnotationBody(body: string): { fields: Annotation | null; message: string } {
  const sepIdx = body.indexOf('::')
  if (sepIdx < 0) return { fields: null, message: body }
  const head = body.slice(0, sepIdx)
  const message = decodeGhValue(body.slice(sepIdx + 2))
  if (!/^[A-Za-z]+=/.test(head)) return { fields: null, message: body }
  const fields: Annotation = {}
  for (const pair of head.split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = pair.slice(0, eq).trim()
    const val = decodeGhValue(pair.slice(eq + 1))
    switch (key) {
      case 'file': fields.file = val; break
      case 'title': fields.title = val; break
      case 'line': { const n = parseInt(val, 10); if (Number.isFinite(n)) fields.line = n; break }
      case 'col':
      case 'column': { const n = parseInt(val, 10); if (Number.isFinite(n)) fields.col = n; break }
      case 'endLine': { const n = parseInt(val, 10); if (Number.isFinite(n)) fields.endLine = n; break }
      case 'endColumn': { const n = parseInt(val, 10); if (Number.isFinite(n)) fields.endColumn = n; break }
    }
  }
  return { fields, message }
}

export function parseGhLogs(raw: string): LogLine[] {
  const out: LogLine[] = []
  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine) continue
    let step: string | null = null
    let rest = rawLine
    const parts = rawLine.split('\t')
    if (parts.length >= 3) {
      const s = parts[1]
      step = s && s !== 'UNKNOWN STEP' ? s : null
      rest = parts.slice(2).join('\t')
    }
    // Strip UTF-8 BOM if present on the first timestamp of a job.
    rest = rest.replace(/^\ufeff/, '')
    let timestamp: string | null = null
    const tsMatch = rest.match(TS_RE)
    let content = rest
    if (tsMatch) {
      timestamp = tsMatch[1]
      content = tsMatch[2]
    }
    content = stripAnsi(content)
    let level: LogLevel = 'info'
    let annotation: Annotation | undefined
    const cmd = content.match(CMD_RE)
    if (cmd) {
      level = cmd[1] as LogLevel
      content = cmd[2]
      if (level === 'error' || level === 'warning' || level === 'notice') {
        const parsed = parseAnnotationBody(content)
        if (parsed.fields) {
          annotation = parsed.fields
          content = parsed.message
        }
      }
    } else if (ERROR_RE.test(content)) {
      level = 'error'
    } else if (WARN_RE.test(content)) {
      level = 'warning'
    }
    out.push({ step, timestamp, level, text: content, annotation })
  }
  return out
}

export function formatShortTime(iso: string): string {
  // "2026-04-22T13:15:11.2185371Z" -> "13:15:11"
  const m = iso.match(/T(\d{2}:\d{2}:\d{2})/)
  return m ? m[1] : iso
}
