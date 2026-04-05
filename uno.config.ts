import { defineConfig } from 'unocss'
import presetWind from '@unocss/preset-wind'
import presetIcons from '@unocss/preset-icons'

export default defineConfig({
  presets: [
    presetWind(),
    presetIcons({
      scale: 1.2,
      cdn: 'https://esm.sh/',
    }),
  ],
  theme: {
    colors: {
      surface: {
        0: '#0a0a0a',
        1: '#111111',
        2: '#1a1a1a',
        3: '#222222',
      },
      border: {
        DEFAULT: '#2a2a2a',
        active: '#3a3a3a',
      },
      accent: {
        DEFAULT: '#6366f1',
        hover: '#818cf8',
      },
      status: {
        running: '#22c55e',
        idle: '#6b7280',
        done: '#3b82f6',
        error: '#ef4444',
      },
    },
  },
  shortcuts: {
    'btn': 'px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer',
    'btn-primary': 'btn bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed',
    'btn-ghost': 'btn text-gray-400 hover:text-white hover:bg-surface-3',
    'panel': 'bg-surface-1 border border-border rounded-lg',
  },
  preflights: [
    {
      getCSS: () => `
        /* Thin scrollbars */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #3a3a3a; }

        /* Focus ring */
        :focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
      `,
    },
  ],
})
