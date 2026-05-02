import { describe, test, expect } from 'vitest'
import { detectPluginType, formatCompactCount } from './pluginMeta'

describe('detectPluginType', () => {
  test('detects MCP server', () => {
    expect(detectPluginType('Upstash Context7 MCP server for documentation')).toBe('mcp')
    expect(detectPluginType('Implements the Model Context Protocol')).toBe('mcp')
  })

  test('detects LSP', () => {
    expect(detectPluginType('TypeScript/JavaScript language server')).toBe('lsp')
    expect(detectPluginType('rust-analyzer LSP server for Rust')).toBe('lsp')
  })

  test('returns null for ambiguous text', () => {
    expect(detectPluginType('Create new skills, improve existing skills')).toBeNull()
    expect(detectPluginType('Comprehensive feature development workflow with specialized agents')).toBeNull()
    expect(detectPluginType('Tools for git commit workflows')).toBeNull()
  })
})

describe('formatCompactCount', () => {
  test('formats thousands', () => {
    expect(formatCompactCount(8126)).toBe('8.1K')
    expect(formatCompactCount(52559)).toBe('53K')
    expect(formatCompactCount(299640)).toBe('300K')
  })
  test('formats millions', () => {
    expect(formatCompactCount(1_500_000)).toBe('1.5M')
    expect(formatCompactCount(12_345_678)).toBe('12M')
  })
  test('passes through small numbers', () => {
    expect(formatCompactCount(8)).toBe('8')
    expect(formatCompactCount(123)).toBe('123')
  })
})
