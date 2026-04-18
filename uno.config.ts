import { defineConfig } from 'unocss'
import presetWind from '@unocss/preset-wind3'
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
        0: 'var(--surface-0)',
        1: 'var(--surface-1)',
        2: 'var(--surface-2)',
        3: 'var(--surface-3)',
        4: 'var(--surface-4)',
      },
      border: {
        DEFAULT: '#18181f',
        active: '#22222b',
        subtle: '#131318',
      },
      accent: {
        DEFAULT: '#2d6e4f',
        hover: '#3a8562',
        muted: 'rgba(45, 110, 79, 0.12)',
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
  safelist: [
    'btn', 'btn-primary', 'btn-ghost', 'btn-danger', 'menu-item', 'input-base', 'section-title',
    // Sidebar task phase icons — dynamically applied
    'text-status-idle', 'text-status-running', 'text-status-done', 'text-status-error',
    'text-text-muted', 'text-amber-400', 'text-emerald-400', 'text-purple-400', 'text-red-400',
    'animate-spin', 'border-l-2',
  ],
  shortcuts: [
    ['toolbar-chrome', 'h-6 rounded-md ring-1 ring-white/8'],
    ['toolbar-btn', 'toolbar-chrome flex items-center text-[11px] text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors disabled:opacity-30 disabled:pointer-events-none'],
    ['btn', 'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer'],
    ['btn-primary', 'btn bg-accent text-white hover:bg-accent-hover active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed'],
    ['btn-ghost', 'btn text-text-secondary hover:text-text-primary hover:bg-surface-3'],
    ['btn-danger', 'btn text-status-error hover:bg-status-error/10'],
    ['menu-item', 'w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors'],
    ['input-base', 'w-full bg-surface-1 border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors'],
    ['section-title', 'text-xs font-medium text-text-muted uppercase tracking-wider'],
  ],
  preflights: [
    {
      getCSS: () => `
        :root {
          --surface-0: #09090b;
          --surface-1: #0f0f12;
          --surface-2: #17171c;
          --surface-3: #1e1e24;
          --surface-4: #26262e;
        }

        /* Active tab frame — inset box-shadow so it doesn't shift layout and doesn't
           get clipped by the tab bar's overflow-x-auto (which implicitly clips overflow-y) */
        .tab-active-frame {
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.08),
            inset 1px 0 0 rgba(255, 255, 255, 0.08),
            inset -1px 0 0 rgba(255, 255, 255, 0.08);
        }

        /* Subtle unread-session pulse */
        @keyframes tabUnreadPulse {
          0%, 100% { background-color: rgba(0, 0, 0, 0.30); }
          50%      { background-color: rgba(45, 110, 79, 0.12); }
        }
        .tab-unread-pulse {
          animation: tabUnreadPulse 3s ease-in-out infinite;
        }

        /* Sidebar task tile indicator — inset left-edge strip (matches the
           selected-state visual language). Hover pauses animation at the
           high-intensity color so the affordance is obvious. */
        @keyframes taskAttentionPulse {
          0%, 100% { box-shadow: inset 2px 0 0 rgba(251, 191, 36, 0.2); }
          50%      { box-shadow: inset 2px 0 0 rgba(251, 191, 36, 0.5); }
        }
        .task-attention-pulse { animation: taskAttentionPulse 2s ease-in-out infinite; }
        .task-attention-pulse:hover {
          animation: none;
          box-shadow: inset 2px 0 0 rgba(251, 191, 36, 0.6);
        }

        @keyframes taskUnreadPulse {
          0%, 100% { box-shadow: inset 2px 0 0 rgba(96, 165, 250, 0.25); }
          50%      { box-shadow: inset 2px 0 0 rgba(96, 165, 250, 0.55); }
        }
        .task-unread-pulse { animation: taskUnreadPulse 2.5s ease-in-out infinite; }
        .task-unread-pulse:hover {
          animation: none;
          box-shadow: inset 2px 0 0 rgba(96, 165, 250, 0.65);
        }

        /* Hide scrollbar but keep scrolling */
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { scrollbar-width: none; }

        /* Tab-bar background — surface-1 everywhere except the bottom 1px, which is
           transparent so the editor panel's border-t can show through and the active
           tab (which fills its full h-8 with surface-0) covers it in its own column */
        .tab-bar-bg {
          background: linear-gradient(
            to bottom,
            var(--surface-1) calc(100% - 1px),
            transparent calc(100% - 1px)
          );
        }

        /* Thin scrollbars */
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e1e26; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #2e2e3a; }

        /* Focus ring */
        :focus-visible { outline: 2px solid rgba(45, 110, 79, 0.5); outline-offset: 1px; }

        /* Reset native form element appearance */
        *, *::before, *::after { box-sizing: border-box; }
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
        input[type="checkbox"] { appearance: auto; -webkit-appearance: checkbox; }

        /* Smooth transitions */
        * { -webkit-font-smoothing: antialiased; }

        /* Instant hover on list rows and tiles — no fade */
        .transition-colors { transition-duration: 0ms !important; }

        /* Drag region for titlebar */
        .drag-region { -webkit-app-region: drag; }
        .no-drag { -webkit-app-region: no-drag; }

        /* Markdown prose styling */
        .prose-verun p { margin: 0.4em 0; }
        .prose-verun p:first-child { margin-top: 0; }
        .prose-verun p:last-child { margin-bottom: 0; }
        .prose-verun h1, .prose-verun h2, .prose-verun h3, .prose-verun h4 {
          color: #e4e4e7; margin: 0.8em 0 0.3em;
        }
        .prose-verun h1 { font-size: 1.3em; font-weight: 700; }
        .prose-verun h2 { font-size: 1.15em; font-weight: 600; }
        .prose-verun h3 { font-size: 1em; font-weight: 600; color: #a1a1aa; }
        .prose-verun h4 { font-size: 0.9em; font-weight: 600; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.03em; }
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
          border-left: 3px solid #2d6e4f30;
          padding-left: 0.8em;
          margin: 0.4em 0;
          color: #a1a1aa;
        }
        .prose-verun a { color: #2d6e4f; text-decoration: none; cursor: pointer; }
        .prose-verun a:hover { text-decoration: underline; }
        .prose-verun img { max-width: 100%; height: auto; border-radius: 8px; margin: 0.5em 0; }
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
          background: #2d6e4f;
          margin: 0 2px;
          animation: pulseDot 1.4s infinite ease-in-out;
        }
        .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
        .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

        /* Chat search highlights */
        mark.chat-search-match {
          background: rgba(234, 179, 8, 0.3);
          color: inherit;
          padding: 0;
          border-radius: 0;
        }
        mark.chat-search-match.chat-search-current {
          background: rgba(234, 179, 8, 0.7);
          box-shadow: 0 0 0 1px rgba(234, 179, 8, 0.9);
        }

        /* Scroll shadow for horizontal overflow */
        .scroll-shadow-x {
          mask-image: linear-gradient(to right, transparent 0, black 12px, black calc(100% - 12px), transparent 100%);
          -webkit-mask-image: linear-gradient(to right, transparent 0, black 12px, black calc(100% - 12px), transparent 100%);
        }

        /* Entry animation */
        @keyframes fadeInUp {
          from { opacity: 0; }
          to { opacity: 1; }
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
