import { describe, it, expect } from 'vitest'
import { BTS_CATEGORIES } from './btsSchema'

describe('BTS_CATEGORIES', () => {
  it('contains the expected set of categories', () => {
    const ids = BTS_CATEGORIES.map((c) => c.id)
    for (const expected of ['webFrontend', 'nativeFrontend', 'backend', 'runtime', 'api', 'database', 'orm', 'auth', 'packageManager', 'install']) {
      expect(ids).toContain(expected)
    }
  })

  it('does not expose template as a category', () => {
    const ids = BTS_CATEGORIES.map((c) => c.id)
    expect(ids).not.toContain('template')
  })

  it('every category has at least one option', () => {
    for (const cat of BTS_CATEGORIES) {
      expect(cat.options.length).toBeGreaterThan(0)
    }
  })

  it('every option has a human-readable label distinct from raw value for known values', () => {
    const web = BTS_CATEGORIES.find((c) => c.id === 'webFrontend')!
    const tanstack = web.options.find((o) => o.value === 'tanstack-router')
    expect(tanstack?.label).toBe('TanStack Router')
  })

  it('every option has an Icon component', () => {
    const missing: string[] = []
    for (const cat of BTS_CATEGORIES) {
      for (const opt of cat.options) {
        if (typeof opt.Icon !== 'function') missing.push(`${cat.id}:${opt.value}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('sorts the none option to the end of each category that has it', () => {
    for (const cat of BTS_CATEGORIES) {
      const noneIdx = cat.options.findIndex((o) => o.value === 'none')
      if (noneIdx !== -1) {
        expect(noneIdx).toBe(cat.options.length - 1)
      }
    }
  })
})
