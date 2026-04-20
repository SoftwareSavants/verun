import { beforeEach, describe, expect, test } from 'vitest'
import {
  DEFAULT_PREFS,
  THEME_PRESETS,
  applyAppearance,
  deriveAccentForeground,
  deriveAccentVariants,
  deriveForegroundScale,
  deriveSurfaceScale,
  findThemePreset,
  hexToHsl,
  hslToHex,
  loadAppearance,
  resolveMode,
  resolvePalette,
  saveAppearance,
} from './theme'

describe('hexToHsl / hslToHex', () => {
  test('round-trips a known color', () => {
    const { h, s, l } = hexToHsl('#2d6e4f')
    expect(Math.round(h)).toBe(151)
    expect(Math.round(s)).toBe(42)
    expect(Math.round(l)).toBe(30)
    expect(hslToHex({ h, s, l }).toLowerCase()).toBe('#2d6e4f')
  })

  test('handles pure black and white', () => {
    expect(hexToHsl('#000000')).toEqual({ h: 0, s: 0, l: 0 })
    expect(hexToHsl('#ffffff')).toEqual({ h: 0, s: 0, l: 100 })
    expect(hslToHex({ h: 0, s: 0, l: 0 })).toBe('#000000')
    expect(hslToHex({ h: 0, s: 0, l: 100 })).toBe('#ffffff')
  })

  test('ignores leading hash and supports 3-digit hex', () => {
    expect(hexToHsl('fff')).toEqual({ h: 0, s: 0, l: 100 })
    expect(hexToHsl('#000')).toEqual({ h: 0, s: 0, l: 0 })
  })
})

describe('deriveAccentVariants', () => {
  test('hover is lighter than the input', () => {
    const v = deriveAccentVariants('#2d6e4f')
    expect(hexToHsl(v.hover).l).toBeGreaterThan(hexToHsl('#2d6e4f').l)
  })

  test('rgb returns space-separated integer channels', () => {
    expect(deriveAccentVariants('#2d6e4f').rgb).toBe('45 110 79')
  })

  test('muted is rgba with low alpha', () => {
    expect(deriveAccentVariants('#2d6e4f').muted).toMatch(/^rgba\(45, 110, 79, 0\.1/)
  })
})

describe('deriveAccentForeground', () => {
  test('returns black for light accents (e.g. teal #5eead4)', () => {
    expect(deriveAccentForeground('#5eead4')).toBe('#000000')
  })

  test('returns white for dark accents (e.g. forest green #2d6e4f)', () => {
    expect(deriveAccentForeground('#2d6e4f')).toBe('#ffffff')
  })

  test('returns white for saturated dark teals like #0d9488 (teal-600)', () => {
    expect(deriveAccentForeground('#0d9488')).toBe('#ffffff')
  })

  test('returns white for deep blues like #1d4ed8 (Sapphire light)', () => {
    expect(deriveAccentForeground('#1d4ed8')).toBe('#ffffff')
  })

  test('returns black for very light accents like #fde047', () => {
    expect(deriveAccentForeground('#fde047')).toBe('#000000')
  })

  test('extremes: pure white → black, pure black → white', () => {
    expect(deriveAccentForeground('#ffffff')).toBe('#000000')
    expect(deriveAccentForeground('#000000')).toBe('#ffffff')
  })
})

describe('applyAppearance - accent foreground', () => {
  test('publishes --accent-foreground that flips with the chosen accent', () => {
    applyAppearance({
      ...DEFAULT_PREFS,
      themePreset: 'Custom',
      darkOverrides: { accent: '#5eead4' },
      mode: 'dark',
    })
    expect(document.documentElement.style.getPropertyValue('--accent-foreground').trim()).toBe('#000000')

    applyAppearance({
      ...DEFAULT_PREFS,
      themePreset: 'Custom',
      darkOverrides: { accent: '#2d6e4f' },
      mode: 'dark',
    })
    expect(document.documentElement.style.getPropertyValue('--accent-foreground').trim()).toBe('#ffffff')
  })
})

describe('deriveSurfaceScale', () => {
  test('dark mode produces 5 increasing-lightness shades from base', () => {
    const scale = deriveSurfaceScale('#09090b', 'dark')
    expect(scale).toHaveLength(5)
    const lightnesses = scale.map(c => hexToHsl(c).l)
    for (let i = 1; i < lightnesses.length; i++) {
      expect(lightnesses[i]).toBeGreaterThan(lightnesses[i - 1])
    }
    expect(scale[0].toLowerCase()).toBe('#09090b')
  })

  test('light mode produces 5 decreasing-lightness shades from base', () => {
    const scale = deriveSurfaceScale('#fafafa', 'light')
    expect(scale).toHaveLength(5)
    const lightnesses = scale.map(c => hexToHsl(c).l)
    for (let i = 1; i < lightnesses.length; i++) {
      expect(lightnesses[i]).toBeLessThan(lightnesses[i - 1])
    }
    expect(scale[0].toLowerCase()).toBe('#fafafa')
  })

  test('clamps to valid range when base is at the extreme', () => {
    const black = deriveSurfaceScale('#000000', 'dark')
    expect(black.every(c => /^#[0-9a-f]{6}$/.test(c))).toBe(true)
    const white = deriveSurfaceScale('#ffffff', 'light')
    expect(white.every(c => /^#[0-9a-f]{6}$/.test(c))).toBe(true)
  })
})

describe('deriveForegroundScale', () => {
  test('dark mode: primary is brightest, dim is darkest', () => {
    const scale = deriveForegroundScale('#e4e4e7', 'dark')
    const ps = hexToHsl(scale.primary).l
    const ss = hexToHsl(scale.secondary).l
    const ms = hexToHsl(scale.muted).l
    const ds = hexToHsl(scale.dim).l
    expect(ps).toBeGreaterThan(ss)
    expect(ss).toBeGreaterThan(ms)
    expect(ms).toBeGreaterThan(ds)
  })

  test('light mode: primary is darkest, dim is lightest', () => {
    const scale = deriveForegroundScale('#18181b', 'light')
    const ps = hexToHsl(scale.primary).l
    const ss = hexToHsl(scale.secondary).l
    const ms = hexToHsl(scale.muted).l
    const ds = hexToHsl(scale.dim).l
    expect(ps).toBeLessThan(ss)
    expect(ss).toBeLessThan(ms)
    expect(ms).toBeLessThan(ds)
  })
})

describe('THEME_PRESETS', () => {
  test('contains at least three presets with unique names', () => {
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(3)
    const names = THEME_PRESETS.map(p => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('every preset defines a full light + dark palette', () => {
    for (const p of THEME_PRESETS) {
      for (const m of [p.light, p.dark]) {
        expect(m.accent).toMatch(/^#[0-9a-f]{6}$/i)
        expect(m.surface).toMatch(/^#[0-9a-f]{6}$/i)
        expect(m.foreground).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  test('findThemePreset falls back to the first entry for unknown names', () => {
    expect(findThemePreset('NotARealName')).toBe(THEME_PRESETS[0])
    expect(findThemePreset(THEME_PRESETS[1].name)).toBe(THEME_PRESETS[1])
  })

  test('includes a "Custom" preset so the override UI has a discrete trigger', () => {
    const custom = THEME_PRESETS.find(p => p.name === 'Custom')
    expect(custom).toBeDefined()
  })
})

describe('resolveMode', () => {
  test('passes through explicit modes', () => {
    expect(resolveMode('light')).toBe('light')
    expect(resolveMode('dark')).toBe('dark')
  })

  test('system mode resolves to light or dark', () => {
    const mode = resolveMode('system')
    expect(mode === 'light' || mode === 'dark').toBe(true)
  })
})

describe('resolvePalette', () => {
  test('returns the preset palette when no overrides are set', () => {
    const palette = resolvePalette({ ...DEFAULT_PREFS, themePreset: 'Default' }, 'dark')
    expect(palette).toEqual(THEME_PRESETS[0].dark)
  })

  test('overrides are ignored on non-Custom presets so switching back to a preset restores it cleanly', () => {
    const prefs = {
      ...DEFAULT_PREFS,
      themePreset: 'Default',
      darkOverrides: { accent: '#ff00aa' },
    }
    expect(resolvePalette(prefs, 'dark').accent).toBe(THEME_PRESETS[0].dark.accent)
  })

  test('overrides apply when themePreset is "Custom"', () => {
    const prefs = {
      ...DEFAULT_PREFS,
      themePreset: 'Custom',
      darkOverrides: { accent: '#ff00aa' },
    }
    expect(resolvePalette(prefs, 'dark').accent).toBe('#ff00aa')
    // Other modes / keys still come from the Custom preset's base palette
    const custom = THEME_PRESETS.find(p => p.name === 'Custom')!
    expect(resolvePalette(prefs, 'light').accent).toBe(custom.light.accent)
  })

  test('partial overrides only replace the specified keys (Custom preset)', () => {
    const prefs = {
      ...DEFAULT_PREFS,
      themePreset: 'Custom',
      lightOverrides: { surface: '#eeeeee' },
    }
    const out = resolvePalette(prefs, 'light')
    const custom = THEME_PRESETS.find(p => p.name === 'Custom')!
    expect(out.surface).toBe('#eeeeee')
    expect(out.accent).toBe(custom.light.accent)
    expect(out.foreground).toBe(custom.light.foreground)
  })
})

describe('appearance persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('loadAppearance returns DEFAULT_PREFS when nothing stored', () => {
    expect(loadAppearance()).toEqual(DEFAULT_PREFS)
  })

  test('saveAppearance + loadAppearance round-trip', () => {
    const prefs = {
      ...DEFAULT_PREFS,
      mode: 'light' as const,
      themePreset: 'Sapphire',
      darkOverrides: { accent: '#ff6b9d' },
      uiFontSize: 15,
      density: 'compact' as const,
    }
    saveAppearance(prefs)
    expect(loadAppearance()).toEqual(prefs)
  })

  test('loadAppearance merges partial stored prefs with defaults (forward compat)', () => {
    localStorage.setItem('verun:appearance', JSON.stringify({ mode: 'light' }))
    const loaded = loadAppearance()
    expect(loaded.mode).toBe('light')
    expect(loaded.density).toBe(DEFAULT_PREFS.density)
    expect(loaded.codeFontSize).toBe(DEFAULT_PREFS.codeFontSize)
  })

  test('loadAppearance recovers from corrupt JSON by returning defaults', () => {
    localStorage.setItem('verun:appearance', 'not json')
    expect(loadAppearance()).toEqual(DEFAULT_PREFS)
  })

  test('migrates legacy terminalFontSize into codeFontSize', () => {
    localStorage.setItem('verun:appearance', JSON.stringify({ terminalFontSize: 17 }))
    expect(loadAppearance().codeFontSize).toBe(17)
  })

  test('migrates legacy custom accent into per-mode overrides', () => {
    localStorage.setItem('verun:appearance', JSON.stringify({
      accent: { kind: 'custom', hex: '#abcdef' },
      customAccent: '#abcdef',
    }))
    const loaded = loadAppearance()
    expect(loaded.lightOverrides.accent).toBe('#abcdef')
    expect(loaded.darkOverrides.accent).toBe('#abcdef')
  })
})

describe('applyAppearance - outline color flips with mode', () => {
  test('dark mode publishes white outline channels', () => {
    applyAppearance({ ...DEFAULT_PREFS, mode: 'dark' })
    expect(document.documentElement.style.getPropertyValue('--outline-rgb').trim()).toBe('255 255 255')
  })

  test('light mode publishes black outline channels', () => {
    applyAppearance({ ...DEFAULT_PREFS, mode: 'light' })
    expect(document.documentElement.style.getPropertyValue('--outline-rgb').trim()).toBe('0 0 0')
  })
})

describe('applyAppearance - syntax tokens', () => {
  test('publishes a non-empty syntax-token palette in both modes', () => {
    applyAppearance({ ...DEFAULT_PREFS, mode: 'dark' })
    const darkKw = document.documentElement.style.getPropertyValue('--syntax-keyword').trim()
    expect(darkKw).toMatch(/^#[0-9a-f]{6}$/i)

    applyAppearance({ ...DEFAULT_PREFS, mode: 'light' })
    const lightKw = document.documentElement.style.getPropertyValue('--syntax-keyword').trim()
    expect(lightKw).toMatch(/^#[0-9a-f]{6}$/i)
    expect(lightKw).not.toBe(darkKw)
  })
})

describe('applyAppearance - code font size unifies code blocks and terminals', () => {
  test('publishes --font-code-size from prefs.codeFontSize', () => {
    applyAppearance({ ...DEFAULT_PREFS, codeFontSize: 16 })
    expect(document.documentElement.style.getPropertyValue('--font-code-size').trim()).toBe('16px')
  })
})

describe('DEFAULT_PREFS - normal density matches pre-feature look', () => {
  // Before the Appearance feature there was no explicit root font-size, so the
  // browser default (16px) drove all rem-based UnoCSS utilities. Anything lower
  // as the default ui font size would silently shrink the entire UI at normal
  // density, which is what 0.7.x users already have muscle memory for.
  test('uiFontSize default is 16 so rem-based utilities match the browser default', () => {
    expect(DEFAULT_PREFS.uiFontSize).toBe(16)
  })

  test('applyAppearance with defaults publishes --font-base-size: 16px', () => {
    applyAppearance(DEFAULT_PREFS)
    expect(document.documentElement.style.getPropertyValue('--font-base-size').trim()).toBe('16px')
  })
})
