import type { ITheme, Terminal as XTerm } from '@xterm/xterm'
import { onAppearanceChanged, appearance, resolveMode } from './theme'

function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

const ANSI_DARK = {
  black:         '#0a0a0a',
  red:           '#ef4444',
  green:         '#22c55e',
  yellow:        '#eab308',
  blue:          '#3b82f6',
  magenta:       '#a855f7',
  cyan:          '#06b6d4',
  white:         '#e5e5e5',
  brightBlack:   '#525252',
  brightRed:     '#f87171',
  brightGreen:   '#4ade80',
  brightYellow:  '#facc15',
  brightBlue:    '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan:    '#22d3ee',
  brightWhite:   '#fafafa',
} as const

const ANSI_LIGHT = {
  black:         '#1a1a1a',
  red:           '#dc2626',
  green:         '#15803d',
  yellow:        '#a16207',
  blue:          '#1d4ed8',
  magenta:       '#7e22ce',
  cyan:          '#0e7490',
  white:         '#404040',
  brightBlack:   '#737373',
  brightRed:     '#ef4444',
  brightGreen:   '#16a34a',
  brightYellow:  '#ca8a04',
  brightBlue:    '#2563eb',
  brightMagenta: '#9333ea',
  brightCyan:    '#0891b2',
  brightWhite:   '#171717',
} as const

/** Read the active terminal theme from the resolved CSS variables + mode-aware ANSI palette. */
export function getXtermTheme(): ITheme {
  const accentRgb = cssVar('--accent-rgb', '45 110 79').replace(/\s+/g, ', ')
  const mode = resolveMode(appearance().mode)
  const ansi = mode === 'light' ? ANSI_LIGHT : ANSI_DARK
  return {
    background: cssVar('--surface-0', '#0a0a0a'),
    foreground: cssVar('--text-primary', '#e5e5e5'),
    cursor:     cssVar('--text-primary', '#e5e5e5'),
    selectionBackground: `rgba(${accentRgb}, 0.5)`,
    ...ansi,
  }
}

export function getXtermFontConfig(): { fontFamily: string; fontSize: number; cursorBlink: boolean } {
  const prefs = appearance()
  const family = cssVar('--font-code', "'SF Mono', 'Menlo', monospace")
  return {
    fontFamily: family,
    fontSize: prefs.codeFontSize,
    cursorBlink: prefs.cursorBlink,
  }
}

/** Subscribe an xterm instance to live appearance updates. Returns cleanup. */
export function subscribeXtermToAppearance(term: XTerm, onResize?: () => void): () => void {
  return onAppearanceChanged(() => {
    const cfg = getXtermFontConfig()
    term.options.theme = getXtermTheme()
    term.options.fontFamily = cfg.fontFamily
    term.options.fontSize = cfg.fontSize
    term.options.cursorBlink = cfg.cursorBlink
    // The WebGL renderer caches a texture atlas keyed on font + theme. Without
    // invalidating it, font/color changes don't visibly repaint until the next
    // resize. The canvas renderer ignores this method.
    const t = term as XTerm & { clearTextureAtlas?: () => void }
    t.clearTextureAtlas?.()
    onResize?.()
    // fitAddon.fit() only triggers an internal refresh if rows/cols changed.
    // Force a full repaint of the visible buffer so theme/font tweaks land
    // even when geometry stays the same.
    term.refresh(0, term.rows - 1)
  })
}
