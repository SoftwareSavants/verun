// MCP elicitation: an MCP server asking the user for input mid-call. The CLI
// forwards it as a `control_request`; the backend routes it through the
// approval queue as the `McpElicitation` pseudo tool with the raw request as
// `toolInput`.

export const ELICITATION_TOOL_NAME = 'McpElicitation'

export interface Elicitation {
  mode: 'form' | 'url'
  serverName: string
  message: string
  url?: string
  schema?: unknown
  propertyOrder?: string[]
}

export type ElicitationFieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum'

export interface ElicitationField {
  key: string
  label: string
  description?: string
  kind: ElicitationFieldKind
  required: boolean
  options?: { value: string; label: string }[]
  defaultValue?: unknown
}

export type ElicitationValue = string | boolean | undefined

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

export function parseElicitation(input: Record<string, unknown>): Elicitation {
  const order = Array.isArray(input.property_order)
    ? input.property_order.filter((k): k is string => typeof k === 'string')
    : undefined
  return {
    mode: input.mode === 'url' ? 'url' : 'form',
    serverName: str(input.display_name) ?? str(input.mcp_server_name) ?? 'MCP server',
    message: str(input.message) ?? '',
    url: str(input.url),
    schema: input.requested_schema,
    propertyOrder: order,
  }
}

export function elicitationFields(schema: unknown, propertyOrder?: string[]): ElicitationField[] {
  if (!schema || typeof schema !== 'object') return []
  const s = schema as { properties?: Record<string, Record<string, unknown>>; required?: unknown }
  const props = s.properties ?? {}
  const required = new Set(Array.isArray(s.required) ? s.required : [])
  const keys = Object.keys(props)
  const ordered = propertyOrder
    ? [...propertyOrder.filter(k => k in props), ...keys.filter(k => !propertyOrder.includes(k))]
    : keys
  return ordered.map(key => {
    const p = props[key] ?? {}
    const field: ElicitationField = {
      key,
      label: str(p.title) ?? key,
      description: str(p.description),
      kind: fieldKind(p),
      required: required.has(key),
    }
    if (Array.isArray(p.enum)) {
      const names = Array.isArray(p.enumNames) ? p.enumNames : []
      field.options = p.enum.map((v, i) => ({ value: String(v), label: str(names[i]) ?? String(v) }))
    }
    if (p.default !== undefined) field.defaultValue = p.default
    return field
  })
}

function fieldKind(p: Record<string, unknown>): ElicitationFieldKind {
  if (Array.isArray(p.enum)) return 'enum'
  if (p.type === 'boolean' || p.type === 'number' || p.type === 'integer') return p.type
  return 'string'
}

export function buildElicitationContent(
  fields: ElicitationField[],
  values: Record<string, ElicitationValue>,
): { ok: true; content: Record<string, unknown> } | { ok: false; error: string } {
  const content: Record<string, unknown> = {}
  for (const f of fields) {
    const raw = values[f.key]
    if (f.kind === 'boolean') {
      if (typeof raw === 'boolean') content[f.key] = raw
      continue
    }
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) {
      if (f.required) return { ok: false, error: `${f.label} is required` }
      continue
    }
    if (f.kind === 'number' || f.kind === 'integer') {
      const n = Number(text)
      if (!Number.isFinite(n)) return { ok: false, error: `${f.label} must be a number` }
      if (f.kind === 'integer' && !Number.isInteger(n)) return { ok: false, error: `${f.label} must be a whole number` }
      content[f.key] = n
    } else {
      content[f.key] = text
    }
  }
  return { ok: true, content }
}
