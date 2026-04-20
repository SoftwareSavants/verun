import { defineConfig } from 'unocss'
import presetWind from '@unocss/preset-wind3'
import presetIcons from '@unocss/preset-icons'

/** Generate a UnoCSS color value that supports `<alpha-value>` opacity utilities by reading
 *  a `--<name>-rgb` CSS var (space-separated channels). */
const c = (name: string) => `rgb(var(--${name}-rgb) / <alpha-value>)`

export default defineConfig({
  presets: [
    presetWind(),
    presetIcons({
      scale: 1.2,
      cdn: 'https://esm.sh/',
    }),
  ],
  theme: {
    fontFamily: {
      sans: 'var(--font-ui)',
      mono: 'var(--font-code)',
    },
    colors: {
      surface: {
        0: c('surface-0'),
        1: c('surface-1'),
        2: c('surface-2'),
        3: c('surface-3'),
        4: c('surface-4'),
      },
      border: {
        DEFAULT: c('border-default'),
        active:  c('border-active'),
        subtle:  c('border-subtle'),
      },
      // Mode-aware overlay channel — white in dark mode, black in light mode.
      // Use `ring-outline/8`, `bg-outline/8`, `border-outline/8` for any faux-glass
      // chrome that previously hardcoded `ring-white/8` (broken on light surfaces).
      outline: c('outline'),
      accent: {
        DEFAULT:    c('accent'),
        hover:      c('accent-hover'),
        muted:      'var(--accent-muted)',
        foreground: c('accent-foreground'),
      },
      status: {
        running: c('status-running'),
        idle:    c('status-idle'),
        done:    c('status-done'),
        error:   c('status-error'),
      },
      text: {
        primary:   c('text-primary'),
        secondary: c('text-secondary'),
        muted:     c('text-muted'),
        dim:       c('text-dim'),
      },
      syntax: {
        keyword:  'var(--syntax-keyword)',
        string:   'var(--syntax-string)',
        function: 'var(--syntax-function)',
        number:   'var(--syntax-number)',
        type:     'var(--syntax-type)',
        comment:  'var(--syntax-comment)',
      },
    },
  },
  safelist: [
    'btn', 'btn-primary', 'btn-ghost', 'btn-danger', 'menu-item', 'input-base', 'section-title',
    // Sidebar task phase icons - dynamically applied
    'text-status-idle', 'text-status-running', 'text-status-done', 'text-status-error',
    'text-text-muted', 'text-amber-400', 'text-emerald-400', 'text-purple-400', 'text-red-400',
    'animate-spin', 'border-l-2',
  ],
  shortcuts: [
    ['toolbar-chrome', 'h-6 rounded-md ring-1 ring-outline/8'],
    ['toolbar-btn', 'toolbar-chrome flex items-center text-[11px] text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors disabled:opacity-30 disabled:pointer-events-none'],
    ['btn', 'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer'],
    ['btn-primary', 'btn bg-accent text-accent-foreground hover:bg-accent-hover active:scale-98 disabled:opacity-40 disabled:cursor-not-allowed'],
    ['btn-ghost', 'btn text-text-secondary hover:text-text-primary hover:bg-surface-3'],
    ['btn-danger', 'btn text-status-error hover:bg-status-error/10'],
    ['menu-item', 'w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors'],
    ['input-base', 'w-full bg-surface-1 border border-border rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent transition-colors'],
    ['section-title', 'text-xs font-medium text-text-muted uppercase tracking-wider'],
  ],
  preflights: [
    {
      getCSS: () => `
        :root {
          /* Default dark palette — overwritten on first applyAppearance().
             Each color is published as both --foo (hex) and --foo-rgb (R G B channels)
             so that UnoCSS opacity utilities (bg-foo/15 etc) can render via rgb(... / 0.15). */
          --surface-0: #09090b; --surface-0-rgb: 9 9 11;
          --surface-1: #0f0f12; --surface-1-rgb: 15 15 18;
          --surface-2: #17171c; --surface-2-rgb: 23 23 28;
          --surface-3: #1e1e24; --surface-3-rgb: 30 30 36;
          --surface-4: #26262e; --surface-4-rgb: 38 38 46;

          --border-default: #18181f; --border-default-rgb: 24 24 31;
          --border-active:  #22222b; --border-active-rgb:  34 34 43;
          --border-subtle:  #131318; --border-subtle-rgb:  19 19 24;

          --accent:            #5eead4; --accent-rgb:            94 234 212;
          --accent-hover:      #82efde; --accent-hover-rgb:      130 239 222;
          --accent-foreground: #000000; --accent-foreground-rgb: 0 0 0;
          --accent-muted:      rgba(94, 234, 212, 0.12);

          --status-running: #34d399; --status-running-rgb: 52 211 153;
          --status-idle:    #52525b; --status-idle-rgb:    82 82 91;
          --status-done:    #60a5fa; --status-done-rgb:    96 165 250;
          --status-error:   #f87171; --status-error-rgb:   248 113 113;

          --text-primary:   #e4e4e7; --text-primary-rgb:   228 228 231;
          --text-secondary: #a1a1aa; --text-secondary-rgb: 161 161 170;
          --text-muted:     #71717a; --text-muted-rgb:     113 113 122;
          --text-dim:       #52525b; --text-dim-rgb:       82 82 91;

          /* Default-mode (dark) outline channel; flipped to "0 0 0" for [data-theme="light"] */
          --outline-rgb: 255 255 255;

          --font-ui:   -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', sans-serif;
          --font-code: 'SF Mono', 'Menlo', monospace;
          --font-base-size:     13px;
          --font-code-size: 13px;

          /* Syntax highlighting (mode-aware fixed palette - applyAppearance overrides these) */
          --syntax-keyword:  #ff7b72;
          --syntax-string:   #a5d6ff;
          --syntax-function: #d2a8ff;
          --syntax-number:   #79c0ff;
          --syntax-type:     #ffa657;
          --syntax-comment:  #7d8590;

          /* Root font-size drives every rem-based UnoCSS utility (text-, p-,
             m-, gap-, w-, h-, ...). Density scales it via --density-scale so a
             single attribute on <html> visibly tightens or loosens the entire
             app — not just the few elements using the .btn shortcut. */
          font-size: calc(var(--font-base-size) * var(--density-scale, 1));
          font-family: var(--font-ui);
          color: var(--text-primary);
          background: var(--surface-0);
        }

        /* Light palette — status colors + outline overlay. Surfaces / foreground / accent come from JS. */
        [data-theme="light"] {
          --outline-rgb:    0 0 0;
          --status-running: #15803d; --status-running-rgb: 21 128 61;
          --status-idle:    #71717a; --status-idle-rgb:    113 113 122;
          --status-done:    #2563eb; --status-done-rgb:    37 99 235;
          --status-error:   #dc2626; --status-error-rgb:   220 38 38;
        }

        /* Density: a single multiplier feeds root font-size and therefore
           every rem-based spacing/sizing utility across the app. Code/terminal
           sizes (in px via --font-code-size) deliberately don't scale - those
           have their own setting. */
        [data-density="compact"]     { --density-scale: 0.88; }
        [data-density="comfortable"] { --density-scale: 1.12; }

        /* Reduced motion — kill all animations + transitions */
        [data-reduced-motion="true"] *,
        [data-reduced-motion="true"] *::before,
        [data-reduced-motion="true"] *::after {
          animation-duration: 0ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0ms !important;
          scroll-behavior: auto !important;
        }

        /* Active tab frame - inset box-shadow so it doesn't shift layout and doesn't
           get clipped by the tab bar's overflow-x-auto (which implicitly clips overflow-y) */
        .tab-active-frame {
          box-shadow:
            inset 0 1px 0 rgb(var(--outline-rgb) / 0.08),
            inset 1px 0 0 rgb(var(--outline-rgb) / 0.08),
            inset -1px 0 0 rgb(var(--outline-rgb) / 0.08);
        }

        /* Subtle unread-session pulse */
        @keyframes tabUnreadPulse {
          0%, 100% { background-color: rgba(0, 0, 0, 0.30); }
          50%      { background-color: rgb(var(--accent-rgb) / 0.12); }
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

        /* Tab-bar background - surface-1 everywhere except the bottom 1px, which is
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
        ::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--surface-4); }

        /* Focus ring */
        :focus-visible { outline: 2px solid rgb(var(--accent-rgb) / 0.5); outline-offset: 1px; }

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
        input[type="color"] { appearance: auto; -webkit-appearance: auto; }
        input[type="range"] { appearance: auto; -webkit-appearance: auto; }

        /* Smooth transitions */
        * { -webkit-font-smoothing: antialiased; }

        /* Instant hover on list rows and tiles - no fade */
        .transition-colors { transition-duration: 0ms !important; }

        /* Drag region for titlebar */
        .drag-region { -webkit-app-region: drag; }
        .no-drag { -webkit-app-region: no-drag; }

        /* Markdown prose styling */
        .prose-verun p { margin: 0.4em 0; }
        .prose-verun p:first-child { margin-top: 0; }
        .prose-verun p:last-child { margin-bottom: 0; }
        .prose-verun h1, .prose-verun h2, .prose-verun h3, .prose-verun h4 {
          color: var(--text-primary); margin: 0.8em 0 0.3em;
        }
        .prose-verun h1 { font-size: 1.3em; font-weight: 700; }
        .prose-verun h2 { font-size: 1.15em; font-weight: 600; }
        .prose-verun h3 { font-size: 1em; font-weight: 600; color: var(--text-secondary); }
        .prose-verun h4 { font-size: 0.9em; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.03em; }
        .prose-verun strong { font-weight: 600; color: var(--text-primary); }
        .prose-verun em { font-style: italic; }
        .prose-verun code {
          font-family: var(--font-code);
          /* Use the user's Code font size (not em-relative to UI size) so the
             "Code font size" setting actually controls code blocks. */
          font-size: var(--font-code-size);
          background: var(--surface-2);
          border: 1px solid var(--border-default);
          border-radius: 4px;
          padding: 0.15em 0.35em;
        }
        .prose-verun pre {
          background: var(--surface-1);
          border: 1px solid var(--border-default);
          border-radius: 8px;
          padding: 0.75em 1em;
          overflow-x: auto;
          margin: 0.5em 0;
        }
        .prose-verun pre code {
          background: none;
          border: none;
          padding: 0;
          font-size: var(--font-code-size);
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
          border: 1px solid var(--border-default);
          padding: 0.4em 0.7em;
          text-align: left;
        }
        .prose-verun th { background: var(--surface-2); font-weight: 600; color: var(--text-primary); }
        .prose-verun blockquote {
          border-left: 3px solid rgb(var(--accent-rgb) / 0.3);
          padding-left: 0.8em;
          margin: 0.4em 0;
          color: var(--text-secondary);
        }
        .prose-verun a { color: var(--accent); text-decoration: none; cursor: pointer; }
        .prose-verun a:hover { text-decoration: underline; }
        .prose-verun img { max-width: 100%; height: auto; border-radius: 8px; margin: 0.5em 0; }
        .prose-verun hr { border: none; border-top: 1px solid var(--border-default); margin: 0.8em 0; }

        /* Thinking dots */
        @keyframes pulseDot {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
        .thinking-dots span {
          display: inline-block;
          width: 5px; height: 5px;
          border-radius: 50%;
          background: var(--accent);
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
