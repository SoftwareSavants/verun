import { describe, test, expect } from 'vitest'
import { elicitationFields, buildElicitationContent, parseElicitation } from './mcpElicitation'

const schema = {
  type: 'object',
  properties: {
    count: { type: 'integer', title: 'Count', minimum: 1 },
    name: { type: 'string', title: 'Name', description: 'Your name' },
    color: { type: 'string', enum: ['red', 'blue'], enumNames: ['Red', 'Blue'] },
    agree: { type: 'boolean', default: true },
  },
  required: ['name'],
}

describe('parseElicitation', () => {
  test('reads form and url requests', () => {
    expect(parseElicitation({ mcp_server_name: 's', message: 'm', requested_schema: schema }).mode).toBe('form')
    const url = parseElicitation({ mcp_server_name: 's', message: 'Sign in', mode: 'url', url: 'https://x' })
    expect(url).toMatchObject({ mode: 'url', url: 'https://x', serverName: 's', message: 'Sign in' })
  })

  test('prefers display name for the server label', () => {
    expect(parseElicitation({ mcp_server_name: 's', display_name: 'Linear', message: 'm' }).serverName).toBe('Linear')
  })
})

describe('elicitationFields', () => {
  test('follows property_order when given', () => {
    const fields = elicitationFields(schema, ['name', 'count', 'color', 'agree'])
    expect(fields.map(f => f.key)).toEqual(['name', 'count', 'color', 'agree'])
  })

  test('falls back to schema order and reads metadata', () => {
    const fields = elicitationFields(schema)
    expect(fields.map(f => f.key)).toEqual(['count', 'name', 'color', 'agree'])
    const name = fields.find(f => f.key === 'name')!
    expect(name).toMatchObject({ label: 'Name', description: 'Your name', required: true, kind: 'string' })
    const color = fields.find(f => f.key === 'color')!
    expect(color.kind).toBe('enum')
    expect(color.options).toEqual([{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }])
    expect(fields.find(f => f.key === 'agree')!.defaultValue).toBe(true)
    expect(fields.find(f => f.key === 'count')!.kind).toBe('integer')
  })

  test('empty or missing schema yields no fields', () => {
    expect(elicitationFields(undefined)).toEqual([])
  })
})

describe('buildElicitationContent', () => {
  const fields = elicitationFields(schema)

  test('coerces values to schema types and drops blanks', () => {
    const r = buildElicitationContent(fields, { count: '3', name: 'Ada', color: 'blue', agree: false })
    expect(r).toEqual({ ok: true, content: { count: 3, name: 'Ada', color: 'blue', agree: false } })
    const blank = buildElicitationContent(fields, { name: 'Ada', count: '' })
    expect(blank).toEqual({ ok: true, content: { name: 'Ada' } })
  })

  test('reports missing required and bad numbers', () => {
    expect(buildElicitationContent(fields, { name: '  ' })).toEqual({ ok: false, error: 'Name is required' })
    expect(buildElicitationContent(fields, { name: 'a', count: '1.5' })).toEqual({ ok: false, error: 'Count must be a whole number' })
  })
})
