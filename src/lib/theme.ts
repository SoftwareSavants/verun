import { createSignal } from 'solid-js'

export type ThemeMode = 'system' | 'light' | 'dark'
export type Density = 'compact' | 'normal' | 'comfortable'

export interface ModePalette {
  accent: string
  surface: string
  foreground: string
}

export interface ThemePreset {
  name: string
  light: ModePalette
  dark: ModePalette
}

export interface PaletteOverrides {
  accent?: string
  surface?: string
  foreground?: string
}

export interface AppearancePrefs {
  mode: ThemeMode
  themePreset: string
  lightOverrides: PaletteOverrides
  darkOverrides: PaletteOverrides
  uiFont: string
  codeFont: string
  uiFontSize: number
  codeFontSize: number
  density: Density
  cursorBlink: boolean
  reducedMotion: boolean
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    name: 'Default',
    dark:  { accent: '#5eead4', surface: '#09090b', foreground: '#e4e4e7' },
    light: { accent: '#0d9488', surface: '#fafafa', foreground: '#18181b' },
  },
  {
    name: 'Sapphire',
    dark:  { accent: '#3b82f6', surface: '#08090d', foreground: '#e2e8f0' },
    light: { accent: '#1d4ed8', surface: '#f4f7fb', foreground: '#0f172a' },
  },
  {
    name: 'Copper',
    dark:  { accent: '#d4843b', surface: '#0d0a08', foreground: '#e7e5e4' },
    light: { accent: '#b87333', surface: '#fbf8f3', foreground: '#1c1917' },
  },
  {
    name: 'Garnet',
    dark:  { accent: '#e11d48', surface: '#0a0809', foreground: '#e7e5e4' },
    light: { accent: '#9f1239', surface: '#fbf6f7', foreground: '#1c1917' },
  },
  {
    name: 'Dusk',
    dark:  { accent: '#a78bfa', surface: '#0a0a0f', foreground: '#e2e2f0' },
    light: { accent: '#5b5ea6', surface: '#f7f7fb', foreground: '#1c1733' },
  },
  {
    name: 'True Black',
    dark:  { accent: '#2d6e4f', surface: '#000000', foreground: '#e4e4e7' },
    light: { accent: '#2d6e4f', surface: '#ffffff', foreground: '#18181b' },
  },
  // Custom is a real preset (mirrors Default's palette) and acts as the
  // discrete trigger for showing the per-mode override UI in Settings. With
  // no overrides set, picking Custom looks identical to Default - the user
  // then tweaks individual colors from there.
  {
    name: 'Custom',
    dark:  { accent: '#5eead4', surface: '#09090b', foreground: '#e4e4e7' },
    light: { accent: '#0d9488', surface: '#fafafa', foreground: '#18181b' },
  },
]

// "Variable" suffix matches the family name shipped by @fontsource-variable/*
// packages bundled in src/index.tsx, so the choice works on machines that
// don't have the font installed system-wide.
export const UI_FONT_PRESETS: { name: string; stack: string }[] = [
  { name: 'System',          stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', sans-serif" },
  { name: 'Inter',           stack: "'Inter Variable', 'Inter', -apple-system, sans-serif" },
  { name: 'IBM Plex Sans',   stack: "'IBM Plex Sans', -apple-system, sans-serif" },
  { name: 'Helvetica Neue',  stack: "'Helvetica Neue', -apple-system, sans-serif" },
]

export const CODE_FONT_PRESETS: { name: string; stack: string }[] = [
  { name: 'SF Mono',        stack: "'SF Mono', 'Menlo', monospace" },
  { name: 'JetBrains Mono', stack: "'JetBrains Mono Variable', 'JetBrains Mono', 'SF Mono', monospace" },
  { name: 'Fira Code',      stack: "'Fira Code Variable', 'Fira Code', 'SF Mono', monospace" },
  { name: 'Cascadia Code',  stack: "'Cascadia Code Variable', 'Cascadia Code', 'SF Mono', monospace" },
]

export const DEFAULT_PREFS: AppearancePrefs = {
  mode: 'system',
  themePreset: 'Default',
  lightOverrides: {},
  darkOverrides: {},
  uiFont: 'System',
  codeFont: 'SF Mono',
  uiFontSize: 13,
  codeFontSize: 13,
  density: 'normal',
  cursorBlink: false,
  reducedMotion: false,
}

const STORAGE_KEY = 'verun:appearance'
const APPEARANCE_EVENT = 'verun:appearance-changed'

// Fixed syntax-highlighting palette. Independent of theme so previewed code
// always reads as code, but mode-aware so contrast stays right.
const SYNTAX_DARK = {
  keyword:  '#ff7b72',
  string:   '#a5d6ff',
  function: '#d2a8ff',
  number:   '#79c0ff',
  type:     '#ffa657',
  comment:  '#7d8590',
}
const SYNTAX_LIGHT = {
  keyword:  '#cf222e',
  string:   '#0a3069',
  function: '#8250df',
  number:   '#0550ae',
  type:     '#953800',
  comment:  '#6e7781',
}

// ---------------------------------------------------------------------------
// HSL helpers - used for deriving scales from a single base color
// ---------------------------------------------------------------------------

function expandHex(hex: string): string {
  const h = hex.replace(/^#/, '').toLowerCase()
  if (h.length === 3) return h.split('').map(c => c + c).join('')
  return h
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const h = expandHex(hex)
  const r = parseInt(h.slice(0, 2), 16) / 255
  const g = parseInt(h.slice(2, 4), 16) / 255
  const b = parseInt(h.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let hue = 0
  let sat = 0
  const lit = (max + min) / 2
  if (d !== 0) {
    sat = lit > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: hue = ((g - b) / d + (g < b ? 6 : 0)); break
      case g: hue = ((b - r) / d + 2); break
      case b: hue = ((r - g) / d + 4); break
    }
    hue *= 60
  }
  return { h: hue, s: sat * 100, l: lit * 100 }
}

export function hslToHex({ h, s, l }: { h: number; s: number; l: number }): string {
  const sat = clamp(s, 0, 100) / 100
  const lit = clamp(l, 0, 100) / 100
  const c = (1 - Math.abs(2 * lit - 1)) * sat
  const hh = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  let r1 = 0, g1 = 0, b1 = 0
  if (hh < 1) [r1, g1, b1] = [c, x, 0]
  else if (hh < 2) [r1, g1, b1] = [x, c, 0]
  else if (hh < 3) [r1, g1, b1] = [0, c, x]
  else if (hh < 4) [r1, g1, b1] = [0, x, c]
  else if (hh < 5) [r1, g1, b1] = [x, 0, c]
  else [r1, g1, b1] = [c, 0, x]
  const m = lit - c / 2
  const to255 = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${to255(r1)}${to255(g1)}${to255(b1)}`
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}

function hexToRgbChannels(hex: string): { r: number; g: number; b: number } {
  const h = expandHex(hex)
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

// ---------------------------------------------------------------------------
// Derivation: turn one base color into the full scale
// ---------------------------------------------------------------------------

export function deriveAccentVariants(hex: string): { hover: string; muted: string; rgb: string } {
  const hsl = hexToHsl(hex)
  const hover = hslToHex({ h: hsl.h, s: hsl.s, l: clamp(hsl.l + 8, 0, 100) })
  const { r, g, b } = hexToRgbChannels(hex)
  return {
    hover,
    muted: `rgba(${r}, ${g}, ${b}, 0.12)`,
    rgb: `${r} ${g} ${b}`,
  }
}

/** Pick black or white text for sitting on top of an accent-colored background.
 *  Threshold is 0.4 (perceptual, not the strict WCAG 0.179 crossover): saturated
 *  mid-tones like teal-600 / blue-500 read better with white text even when the
 *  raw contrast math slightly favors black, so we bias toward white until the
 *  accent gets genuinely light. Matches Tailwind/Material conventions for
 *  primary buttons in the *-500..*-700 range. */
export function deriveAccentForeground(hex: string): '#000000' | '#ffffff' {
  const { r, g, b } = hexToRgbChannels(hex)
  const lin = (c: number) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return L > 0.4 ? '#000000' : '#ffffff'
}

export function deriveSurfaceScale(baseHex: string, mode: 'light' | 'dark'): [string, string, string, string, string] {
  const hsl = hexToHsl(baseHex)
  const dir = mode === 'dark' ? 1 : -1
  const steps = [0, 2.2, 4.6, 7.5, 11]
  return steps.map(step => hslToHex({ h: hsl.h, s: hsl.s, l: clamp(hsl.l + dir * step, 0, 100) })) as [string, string, string, string, string]
}

export function deriveForegroundScale(baseHex: string, mode: 'light' | 'dark'): { primary: string; secondary: string; muted: string; dim: string } {
  const hsl = hexToHsl(baseHex)
  const dir = mode === 'dark' ? -1 : 1  // step toward the surface
  const steps = { primary: 0, secondary: 16, muted: 32, dim: 48 }
  return {
    primary:   hslToHex({ h: hsl.h, s: hsl.s, l: clamp(hsl.l + dir * steps.primary,   0, 100) }),
    secondary: hslToHex({ h: hsl.h, s: hsl.s, l: clamp(hsl.l + dir * steps.secondary, 0, 100) }),
    muted:     hslToHex({ h: hsl.h, s: hsl.s, l: clamp(hsl.l + dir * steps.muted,     0, 100) }),
    dim:       hslToHex({ h: hsl.h, s: hsl.s, l: clamp(hsl.l + dir * steps.dim,       0, 100) }),
  }
}

// ---------------------------------------------------------------------------
// Mode + palette resolution
// ---------------------------------------------------------------------------

export function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'dark'
}

export function findThemePreset(name: string): ThemePreset {
  return THEME_PRESETS.find(p => p.name === name) ?? THEME_PRESETS[0]
}

/** Resolve the final palette for a given prefs+mode.
 *
 *  Per-mode overrides only take effect when `themePreset === 'Custom'`. This
 *  keeps overrides "owned by" the Custom slot — switching to a curated preset
 *  shows the curated colors without the user having to clear their tweaks,
 *  and switching back to Custom restores them. */
export function resolvePalette(prefs: AppearancePrefs, mode: 'light' | 'dark'): ModePalette {
  const preset = findThemePreset(prefs.themePreset)
  const base = preset[mode]
  if (prefs.themePreset !== 'Custom') return { ...base }
  const overrides = mode === 'light' ? prefs.lightOverrides : prefs.darkOverrides
  return {
    accent:     overrides.accent     ?? base.accent,
    surface:    overrides.surface    ?? base.surface,
    foreground: overrides.foreground ?? base.foreground,
  }
}

// ---------------------------------------------------------------------------
// Persistence (with one-shot migration from the old per-color-preset shape)
// ---------------------------------------------------------------------------

interface LegacyPrefs {
  accent?: { kind: 'preset' | 'custom'; name?: string; hex?: string }
  customAccent?: string
  surface?: unknown
  customSurface?: string
  foreground?: unknown
  customForeground?: string
  terminalFontSize?: number
}

function migrate(parsed: Partial<AppearancePrefs> & LegacyPrefs): Partial<AppearancePrefs> {
  const out: Partial<AppearancePrefs> = { ...parsed }
  if (parsed.terminalFontSize !== undefined && parsed.codeFontSize === undefined) {
    out.codeFontSize = parsed.terminalFontSize
  }
  // If the user previously had a Custom accent, preserve it as both-mode override.
  if (parsed.accent?.kind === 'custom' && parsed.customAccent) {
    out.lightOverrides = { ...(out.lightOverrides ?? {}), accent: parsed.customAccent }
    out.darkOverrides  = { ...(out.darkOverrides  ?? {}), accent: parsed.customAccent }
  }
  // Drop legacy fields so they don't linger in storage after the next save.
  delete (out as LegacyPrefs).accent
  delete (out as LegacyPrefs).customAccent
  delete (out as LegacyPrefs).surface
  delete (out as LegacyPrefs).customSurface
  delete (out as LegacyPrefs).foreground
  delete (out as LegacyPrefs).customForeground
  delete (out as LegacyPrefs).terminalFontSize
  return out
}

export function loadAppearance(): AppearancePrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFS
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return DEFAULT_PREFS
  try {
    const parsed = JSON.parse(raw) as Partial<AppearancePrefs> & LegacyPrefs
    return { ...DEFAULT_PREFS, ...migrate(parsed) }
  } catch {
    return DEFAULT_PREFS
  }
}

export function saveAppearance(prefs: AppearancePrefs) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
}

// ---------------------------------------------------------------------------
// Solid signal + setter
// ---------------------------------------------------------------------------

const [_appearance, _setAppearance] = createSignal<AppearancePrefs>(loadAppearance())
export const appearance = _appearance

export function setAppearance(partial: Partial<AppearancePrefs>) {
  const next = { ..._appearance(), ...partial }
  _setAppearance(next)
  saveAppearance(next)
  applyAppearance(next)
}

// ---------------------------------------------------------------------------
// DOM application
// ---------------------------------------------------------------------------

function fontStack(name: string, presets: { name: string; stack: string }[]): string {
  const preset = presets.find(p => p.name === name)
  if (preset) return preset.stack
  // Custom - wrap in quotes if it looks like a single family name
  if (/^[A-Za-z][\w\s-]*$/.test(name)) return `'${name}', sans-serif`
  return name
}

function setColorVar(root: HTMLElement, name: string, hex: string) {
  root.style.setProperty(`--${name}`, hex)
  const { r, g, b } = hexToRgbChannels(hex)
  root.style.setProperty(`--${name}-rgb`, `${r} ${g} ${b}`)
}

export function applyAppearance(prefs: AppearancePrefs) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const mode = resolveMode(prefs.mode)
  root.dataset.theme = mode
  root.dataset.density = prefs.density
  if (prefs.reducedMotion) root.dataset.reducedMotion = 'true'
  else delete root.dataset.reducedMotion

  const palette = resolvePalette(prefs, mode)

  // Accent (paired with rgb channels for opacity utilities)
  const accent = deriveAccentVariants(palette.accent)
  setColorVar(root, 'accent', palette.accent)
  setColorVar(root, 'accent-hover', accent.hover)
  setColorVar(root, 'accent-foreground', deriveAccentForeground(palette.accent))
  root.style.setProperty('--accent-muted', accent.muted)

  // Surface scale
  const scale = deriveSurfaceScale(palette.surface, mode)
  for (let i = 0; i < scale.length; i++) {
    setColorVar(root, `surface-${i}`, scale[i])
  }

  // Foreground scale
  const fg = deriveForegroundScale(palette.foreground, mode)
  setColorVar(root, 'text-primary', fg.primary)
  setColorVar(root, 'text-secondary', fg.secondary)
  setColorVar(root, 'text-muted', fg.muted)
  setColorVar(root, 'text-dim', fg.dim)

  // Borders derive from surface scale (slightly above surface-0 for separators)
  setColorVar(root, 'border-default', scale[2])
  setColorVar(root, 'border-active',  scale[3])
  setColorVar(root, 'border-subtle',  scale[1])

  // Theme-aware "outline" channel for faux-glass dividers / rings / kbd chips.
  // Dark surfaces need a light overlay; light surfaces need a dark overlay,
  // otherwise utilities like `ring-outline/8` go invisible.
  root.style.setProperty('--outline-rgb', mode === 'light' ? '0 0 0' : '255 255 255')

  // Syntax tokens (mode-aware fixed palette) - used by code-block previews and
  // any inline code rendering that wants real highlighting instead of a flat
  // accent tint.
  const syntax = mode === 'light' ? SYNTAX_LIGHT : SYNTAX_DARK
  root.style.setProperty('--syntax-keyword',  syntax.keyword)
  root.style.setProperty('--syntax-string',   syntax.string)
  root.style.setProperty('--syntax-function', syntax.function)
  root.style.setProperty('--syntax-number',   syntax.number)
  root.style.setProperty('--syntax-type',     syntax.type)
  root.style.setProperty('--syntax-comment',  syntax.comment)

  // Fonts + sizes (code font drives both code blocks and terminals)
  root.style.setProperty('--font-ui',   fontStack(prefs.uiFont,   UI_FONT_PRESETS))
  root.style.setProperty('--font-code', fontStack(prefs.codeFont, CODE_FONT_PRESETS))
  root.style.setProperty('--font-base-size', `${prefs.uiFontSize}px`)
  root.style.setProperty('--font-code-size', `${prefs.codeFontSize}px`)

  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: prefs }))
}

// ---------------------------------------------------------------------------
// System color-scheme tracking (for mode === 'system')
// ---------------------------------------------------------------------------

let mediaQuery: MediaQueryList | null = null
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null

function attachSystemListener() {
  if (typeof window === 'undefined' || !window.matchMedia) return
  if (mediaQuery && mediaListener) return  // already attached
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  mediaListener = () => {
    if (_appearance().mode === 'system') applyAppearance(_appearance())
  }
  mediaQuery.addEventListener('change', mediaListener)
}

export function onAppearanceChanged(cb: (prefs: AppearancePrefs) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<AppearancePrefs>).detail)
  window.addEventListener(APPEARANCE_EVENT, handler)
  return () => window.removeEventListener(APPEARANCE_EVENT, handler)
}

/** Call once on app startup to apply saved appearance + start listening to system theme */
export function initTheme() {
  attachSystemListener()
  applyAppearance(_appearance())
}
