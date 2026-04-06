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
        0: '#09090b',
        1: '#0f0f12',
        2: '#17171c',
        3: '#1e1e24',
        4: '#26262e',
      },
      border: {
        DEFAULT: '#1e1e26',
        active: '#2e2e3a',
        subtle: '#16161e',
      },
      accent: {
        DEFAULT: '#3b82f6',
        hover: '#60a5fa',
        muted: 'rgba(59, 130, 246, 0.12)',
      },
      status: {
        running: '#34d399',
        idle: '#52525b',
        done: '#60a5fa',
        error: '#f87171',
      },
      text: {
        primary: '#e4e4e7',
        secondary: '#a1a1aa',
        muted: '#71717a',
        dim: '#52525b',
      },
    },
  },
  safelist: ['btn', 'btn-primary', 'btn-ghost', 'btn-danger'],
  shortcuts: [
    ['btn', 'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer'],
    ['btn-primary', 'btn bg-accent text-white hover:bg-accent-hover active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed'],
    ['btn-ghost', 'btn text-text-secondary hover:text-text-primary hover:bg-surface-3'],
    ['btn-danger', 'btn text-status-error hover:bg-status-error/10'],
  ],
  preflights: [
    {
      getCSS: () => `
        /* Thin scrollbars */
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e1e26; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #2e2e3a; }

        /* Focus ring */
        :focus-visible { outline: 2px solid rgba(59, 130, 246, 0.5); outline-offset: 1px; }

        /* Reset native form element appearance */
        button, input, textarea, select {
          appearance: none;
          -webkit-appearance: none;
          background: none;
          border: none;
          padding: 0;
          margin: 0;
          font: inherit;
          color: inherit;
        }
        button { cursor: pointer; }
        textarea { resize: none; }

        /* Smooth transitions */
        * { -webkit-font-smoothing: antialiased; }

        /* Drag region for titlebar */
        .drag-region { -webkit-app-region: drag; }
        .no-drag { -webkit-app-region: no-drag; }

        /* Markdown prose styling */
        .prose-verun p { margin: 0.4em 0; }
        .prose-verun p:first-child { margin-top: 0; }
        .prose-verun p:last-child { margin-bottom: 0; }
        .prose-verun h1, .prose-verun h2, .prose-verun h3, .prose-verun h4 {
          font-weight: 600; color: #e4e4e7; margin: 0.8em 0 0.3em;
        }
        .prose-verun h1 { font-size: 1.25em; }
        .prose-verun h2 { font-size: 1.1em; }
        .prose-verun h3 { font-size: 1em; }
        .prose-verun strong { font-weight: 600; color: #e4e4e7; }
        .prose-verun em { font-style: italic; }
        .prose-verun code {
          font-family: 'SF Mono', 'Fira Code', monospace;
          font-size: 0.85em;
          background: #17171c;
          border: 1px solid #1e1e26;
          border-radius: 4px;
          padding: 0.15em 0.35em;
        }
        .prose-verun pre {
          background: #0f0f12;
          border: 1px solid #1e1e26;
          border-radius: 8px;
          padding: 0.75em 1em;
          overflow-x: auto;
          margin: 0.5em 0;
        }
        .prose-verun pre code {
          background: none;
          border: none;
          padding: 0;
          font-size: 0.8em;
          line-height: 1.6;
        }
        .prose-verun ul, .prose-verun ol { padding-left: 1.5em; margin: 0.4em 0; }
        .prose-verun li { margin: 0.15em 0; }
        .prose-verun ul { list-style-type: disc; }
        .prose-verun ol { list-style-type: decimal; }
        .prose-verun table {
          width: 100%;
          border-collapse: collapse;
          margin: 0.5em 0;
          font-size: 0.85em;
        }
        .prose-verun th, .prose-verun td {
          border: 1px solid #1e1e26;
          padding: 0.4em 0.7em;
          text-align: left;
        }
        .prose-verun th { background: #17171c; font-weight: 600; color: #e4e4e7; }
        .prose-verun blockquote {
          border-left: 3px solid #3b82f630;
          padding-left: 0.8em;
          margin: 0.4em 0;
          color: #a1a1aa;
        }
        .prose-verun a { color: #3b82f6; text-decoration: none; }
        .prose-verun a:hover { text-decoration: underline; }
        .prose-verun hr { border: none; border-top: 1px solid #1e1e26; margin: 0.8em 0; }

        /* Thinking dots */
        @keyframes pulseDot {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
        .thinking-dots span {
          display: inline-block;
          width: 5px; height: 5px;
          border-radius: 50%;
          background: #3b82f6;
          margin: 0 2px;
          animation: pulseDot 1.4s infinite ease-in-out;
        }
        .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
        .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

        /* Entry animation */
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-in { animation: fadeInUp 0.2s ease-out; }

        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .animate-slide-in { animation: slideInRight 0.25s ease-out; }
      `,
    },
  ],
})
