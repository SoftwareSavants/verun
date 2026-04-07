import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

let highlighter: HighlighterCore | null = null
let loading: Promise<HighlighterCore> | null = null

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  rs: 'rust', py: 'python', rb: 'ruby', go: 'go',
  java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', cpp: 'cpp', h: 'c',
  cs: 'csharp', php: 'php', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  md: 'markdown', html: 'html', css: 'css', scss: 'scss',
  sql: 'sql', graphql: 'graphql', xml: 'xml', svg: 'xml',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  dockerfile: 'dockerfile', makefile: 'makefile',
}

// Lazy-load only the grammars we need
const LANG_TO_IMPORT: Record<string, () => Promise<any>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
}

async function getHighlighter(): Promise<HighlighterCore> {
  if (highlighter) return highlighter
  if (loading) return loading

  loading = createHighlighterCore({
    themes: [import('shiki/themes/github-dark.mjs')],
    langs: [],
    engine: createOnigurumaEngine(import('shiki/wasm')),
  })

  highlighter = await loading
  return highlighter
}

const loadedLangs = new Set<string>()

export function langFromPath(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const basename = filePath.split('/').pop()?.toLowerCase() ?? ''

  // Handle special filenames
  if (basename === 'dockerfile') return 'dockerfile'
  if (basename === 'makefile') return 'makefile'

  return EXT_TO_LANG[ext] ?? null
}

export interface HighlightToken {
  content: string
  color?: string
}

export async function highlightLine(
  line: string,
  lang: string | null,
): Promise<HighlightToken[]> {
  if (!lang || !LANG_TO_IMPORT[lang]) {
    return [{ content: line }]
  }

  try {
    const hl = await getHighlighter()

    // Load language grammar on first use
    if (!loadedLangs.has(lang)) {
      const langModule = await LANG_TO_IMPORT[lang]()
      await hl.loadLanguage(langModule.default ?? langModule)
      loadedLangs.add(lang)
    }

    const result = hl.codeToTokensBase(line, {
      lang,
      theme: 'github-dark',
    })

    if (result.length > 0) {
      return result[0].map(token => ({
        content: token.content,
        color: token.color,
      }))
    }
  } catch {
    // Fall back to plain text
  }

  return [{ content: line }]
}
