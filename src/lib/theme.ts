export interface AccentTheme {
  name: string
  accent: string
  hover: string
  muted: string
}

export const ACCENT_THEMES: AccentTheme[] = [
  { name: 'Malachite',   accent: '#2d6e4f', hover: '#3a8562', muted: 'rgba(45, 110, 79, 0.12)' },
  { name: 'Sapphire',    accent: '#1a3a6b', hover: '#244d8a', muted: 'rgba(26, 58, 107, 0.12)' },
  { name: 'Storm',       accent: '#4a6785', hover: '#5a7a9a', muted: 'rgba(74, 103, 133, 0.12)' },
  { name: 'Dusk',        accent: '#5b5ea6', hover: '#6c6fba', muted: 'rgba(91, 94, 166, 0.12)' },
  { name: 'Copper',      accent: '#b87333', hover: '#cc8544', muted: 'rgba(184, 115, 51, 0.12)' },
  { name: 'Garnet',      accent: '#7b2d3b', hover: '#93394a', muted: 'rgba(123, 45, 59, 0.12)' },
  { name: 'Graphite',    accent: '#5c5c6e', hover: '#6e6e82', muted: 'rgba(92, 92, 110, 0.12)' },
]

const STORAGE_KEY = 'verun:accentTheme'

export function getActiveTheme(): AccentTheme {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    const found = ACCENT_THEMES.find(t => t.name === saved)
    if (found) return found
  }
  return ACCENT_THEMES[0] // Malachite
}

export function setActiveTheme(theme: AccentTheme) {
  localStorage.setItem(STORAGE_KEY, theme.name)
  applyTheme(theme)
}

export function applyTheme(theme: AccentTheme) {
  let el = document.getElementById('verun-accent-overrides')
  if (!el) {
    el = document.createElement('style')
    el.id = 'verun-accent-overrides'
    document.head.appendChild(el)
  }
  el.textContent = `
    .bg-accent { background-color: ${theme.accent} !important; }
    .bg-accent-hover { background-color: ${theme.hover} !important; }
    .hover\\:bg-accent-hover:hover { background-color: ${theme.hover} !important; }
    .text-accent { color: ${theme.accent} !important; }
    .text-accent-hover { color: ${theme.hover} !important; }
    .border-accent { border-color: ${theme.accent} !important; }
    .bg-accent-muted { background-color: ${theme.muted} !important; }
    .border-accent\\/10 { border-color: ${theme.accent}1a !important; }
    .border-accent\\/20 { border-color: ${theme.accent}33 !important; }
    .border-accent\\/30 { border-color: ${theme.accent}4d !important; }
    .bg-accent\\/5 { background-color: ${theme.accent}0d !important; }
    .bg-accent\\/15 { background-color: ${theme.accent}26 !important; }
    .bg-accent\\/25 { background-color: ${theme.accent}40 !important; }
    .focus-within\\:border-accent:focus-within { border-color: ${theme.accent} !important; }
    .focus\\:border-accent:focus { border-color: ${theme.accent} !important; }
    .focus-within\\:shadow-\\[0_0_0_3px_rgba\\(59\\,130\\,246\\,0\\.25\\)\\]:focus-within { box-shadow: 0 0 0 3px ${theme.accent}40 !important; }
    :focus-visible { outline-color: ${theme.accent}80 !important; }
    .btn-primary { background-color: ${theme.accent} !important; }
    .btn-primary:hover { background-color: ${theme.hover} !important; }
    .thinking-dots span { background: ${theme.accent} !important; }
    .prose-verun a { color: ${theme.accent} !important; }
    .prose-verun blockquote { border-left-color: ${theme.accent}30 !important; }
  `
}

/** Call once on app startup to restore saved theme */
export function initTheme() {
  const theme = getActiveTheme()
  // Only inject overrides if not the default (UnoCSS handles default)
  if (theme.name !== ACCENT_THEMES[0].name) {
    applyTheme(theme)
  }
}
