#!/usr/bin/env node
// One-shot: pull colored brand SVGs into src/assets/icons/brands/.
// Re-run to refresh. Prefers Iconify's `logos:` (Gilbarbara's official colored
// logos); falls back to `simple-icons:` with an injected brand hex for a few
// brands not in the colored set.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'src', 'assets', 'icons', 'brands')
mkdirSync(OUT_DIR, { recursive: true })

// slug → source. Four source kinds:
//   - `iconify:<prefix>:<name>[?query]` — pulls from api.iconify.design
//   - `url:<absolute-url>`              — pulls directly from the given URL
//   - `inline:<svg-content>`            — writes the SVG content verbatim
// Prefix any spec with `mono ` to force every fill/stroke to `currentColor`
// after fetching, regardless of the source's actual colors — needed for brand
// marks that ship as a single dark hex (Prisma, MCP, oRPC) which would
// otherwise render black-on-black on dark surfaces.
// Prefix with `swap(#aabbcc) ` to swap one specific hex with `currentColor`
// while leaving the rest of the palette untouched — useful for multi-color
// logos where only the near-black "shape" hex would render invisibly on dark
// surfaces (e.g. Astro's #17191e mountain triangle, while keeping the
// orange/pink gradient swoosh).
// Prefer Iconify's `logos:` (Gilbarbara's official colored set) where it
// exists. For projects not in `logos:` but in `simple-icons:`, tint the shape
// with the brand's marketing hex. For projects missing from both, fetch the
// project's own SVG (favicon / brand asset) from their repo. Use `inline:` for
// brand marks where every available variant ships with chrome we don't want
// (e.g. Next.js: every Iconify variant nests the N inside a filled circle,
// which collapses to a solid disk under `currentColor`).
const ICONS = [
  ['tanstack',     'iconify:simple-icons:tanstack?color=%23FFD94A'],
  ['react-router', 'iconify:logos:react-router'],
  ['next',         'mono url:https://www.svgrepo.com/show/354113/nextjs-icon.svg'],
  ['nuxt',         'iconify:logos:nuxt-icon'],
  ['svelte',       'iconify:logos:svelte-icon'],
  ['solid',        'iconify:logos:solidjs-icon'],
  ['astro',        'swap(#17191e) iconify:logos:astro-icon'],
  ['expo',         'iconify:simple-icons:expo?color=%23ffffff'],
  ['hono',         'iconify:logos:hono'],
  ['elysia',       'url:https://elysiajs.com/assets/elysia.svg'],
  ['express',      'iconify:simple-icons:express?color=%23ffffff'],
  ['fastify',      'iconify:simple-icons:fastify?color=%23ffffff'],
  ['convex',       'iconify:simple-icons:convex?color=%23EE342F'],
  ['bun',          'iconify:logos:bun'],
  ['node',         'iconify:logos:nodejs-icon'],
  ['workers',      'iconify:logos:cloudflare-workers-icon'],
  ['trpc',         'iconify:logos:trpc'],
  ['orpc',         'mono url:https://orpc.unnoq.com/icon.svg'],
  ['sqlite',       'iconify:logos:sqlite'],
  ['postgres',     'iconify:logos:postgresql'],
  ['mysql',        'iconify:logos:mysql-icon'],
  ['mongo',        'iconify:logos:mongodb-icon'],
  ['drizzle',      'iconify:simple-icons:drizzle?color=%23C5F74F'],
  ['prisma',       'mono iconify:logos:prisma'],
  ['mongoose',     'iconify:simple-icons:mongoose?color=%23880000'],
  ['clerk',        'iconify:simple-icons:clerk?color=%236C47FF'],
  ['better-auth',  'iconify:simple-icons:betterauth?color=%2360A5FA'],
  ['turso',        'iconify:simple-icons:turso?color=%234FF8D2'],
  ['neon',         'iconify:logos:neon-icon'],
  ['cloudflare',   'iconify:logos:cloudflare-icon'],
  ['planetscale',  'iconify:simple-icons:planetscale?color=%23ffffff'],
  ['supabase',     'iconify:logos:supabase-icon'],
  ['docker',       'iconify:logos:docker-icon'],
  ['pwa',          'iconify:simple-icons:pwa?color=%235A0FC8'],
  ['tauri',        'iconify:logos:tauri'],
  ['biome',        'iconify:simple-icons:biome?color=%2360A5FA'],
  ['lefthook',     'iconify:simple-icons:lefthook?color=%23ffffff'],
  ['starlight',    'url:https://raw.githubusercontent.com/withastro/starlight/main/docs/public/favicon.svg'],
  ['turborepo',    'iconify:logos:turborepo-icon'],
  ['nx',           'iconify:logos:nx'],
  ['ultracite',    'url:https://raw.githubusercontent.com/haydenbleasel/ultracite/main/apps/docs/favicon.svg'],
  ['oxlint',       'url:https://raw.githubusercontent.com/oxc-project/oxc-assets/main/icon-color-light.svg'],
  ['opentui',      'url:https://raw.githubusercontent.com/sst/opentui/main/packages/web/public/favicon.svg'],
  ['wxt',          'iconify:simple-icons:wxt?color=%2300E699'],
  ['mcp',          'mono iconify:logos:model-context-protocol-icon'],
  ['fumadocs',     'url:https://www.fumadocs.dev/icon.png'],
  ['npm',          'iconify:logos:npm-icon'],
  ['pnpm',         'iconify:logos:pnpm'],
]

const ok = []
const bad = []

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

const normalizeHex = (v) => {
  const s = v.toLowerCase().trim()
  if (!HEX_RE.test(s)) return null
  const h = s.startsWith('#') ? s.slice(1) : s
  if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
  return `#${h}`
}

// Rewrite SVGs whose fills/strokes are entirely pure white OR entirely pure
// black (the monochrome brand marks) so they inherit the host element's text
// color — picks up theme (dark/light) and card state (selected/disabled) via
// `currentColor`. Multi-color brand logos are left untouched so we keep the
// real marketing palette (Bun, Tauri, Postgres, etc).
const PURE_BLACK = new Set(['#000000'])
const PURE_WHITE = new Set(['#ffffff'])

const forceCurrentColor = (svg) => {
  let out = svg
    .replace(/fill="([^"]+)"/gi, (m, v) => (v.toLowerCase() === 'none' ? m : 'fill="currentColor"'))
    .replace(/stroke="([^"]+)"/gi, (m, v) => (v.toLowerCase() === 'none' ? m : 'stroke="currentColor"'))
    .replace(/(fill|stroke)\s*:\s*[^;"\s]+/gi, (_, kind) => `${kind}:currentColor`)
  // Default SVG `fill` is black, so paths without an explicit fill render
  // black regardless of the host's `color`. Inject `fill="currentColor"` on
  // the root <svg> element if it doesn't already have one — children without
  // their own fill attribute inherit it.
  if (!/<svg\b[^>]*\sfill\s*=/i.test(out)) {
    out = out.replace(/<svg\b/i, '<svg fill="currentColor"')
  }
  return out
}

const rewriteMonoToCurrentColor = (svg) => {
  const fillAttrs = [...svg.matchAll(/fill="([^"]+)"/gi)].map((m) => m[1])
  const strokeAttrs = [...svg.matchAll(/stroke="([^"]+)"/gi)].map((m) => m[1])
  const styleColors = [...svg.matchAll(/(?:fill|stroke)\s*:\s*([^;"\s]+)/gi)].map((m) => m[1])
  const all = [...fillAttrs, ...strokeAttrs, ...styleColors]
    .map((v) => v.toLowerCase().trim())
    .filter((v) => v && v !== 'none' && v !== 'currentcolor' && !v.startsWith('url('))
  const norm = all.map(normalizeHex).filter(Boolean)
  if (norm.length === 0 || norm.length !== all.length) return svg
  const uniq = new Set(norm)
  const allBlack = [...uniq].every((c) => PURE_BLACK.has(c))
  const allWhite = [...uniq].every((c) => PURE_WHITE.has(c))
  if (!allBlack && !allWhite) return svg
  return forceCurrentColor(svg)
}

const specToUrl = (spec) => {
  if (spec.startsWith('url:')) return spec.slice('url:'.length)
  if (spec.startsWith('iconify:')) {
    // Iconify's public API wants `prefix/name.svg?…`, not `prefix:name.svg?…`,
    // for query-string variants (color, width, etc). The colon form 404s when
    // a query is attached. Normalize `a:b` → `a/b` before building the URL.
    const rest = spec.slice('iconify:'.length)
    const [pathSpec, query] = rest.split('?')
    const pathPart = pathSpec.replace(':', '/')
    return `https://api.iconify.design/${pathPart}.svg${query ? `?${query}` : ''}`
  }
  throw new Error(`unknown spec kind: ${spec}`)
}

const SWAP_RE = /^swap\(#([0-9a-f]{3}|[0-9a-f]{6})\)\s+/i

const swapHexToCurrentColor = (svg, hex) => {
  const target = normalizeHex(hex)
  if (!target) return svg
  const matchHex = (v) => normalizeHex(v) === target
  return svg
    .replace(/fill="([^"]+)"/gi, (m, v) => (matchHex(v) ? 'fill="currentColor"' : m))
    .replace(/stroke="([^"]+)"/gi, (m, v) => (matchHex(v) ? 'stroke="currentColor"' : m))
    .replace(/(fill|stroke)\s*:\s*([^;"\s]+)/gi, (m, kind, v) => (matchHex(v) ? `${kind}:currentColor` : m))
}

for (const [slug, rawSpec] of ICONS) {
  let spec = rawSpec
  let recolor = (svg) => rewriteMonoToCurrentColor(svg)
  if (spec.startsWith('mono ')) {
    spec = spec.slice('mono '.length)
    recolor = (svg) => forceCurrentColor(svg)
  } else {
    const swapMatch = spec.match(SWAP_RE)
    if (swapMatch) {
      const hex = `#${swapMatch[1]}`
      spec = spec.slice(swapMatch[0].length)
      recolor = (svg) => swapHexToCurrentColor(svg, hex)
    }
  }
  process.stdout.write(`${slug.padEnd(14)} ← ${rawSpec.length > 80 ? rawSpec.slice(0, 77) + '...' : rawSpec}  `)
  try {
    if (spec.startsWith('inline:')) {
      const body = spec.slice('inline:'.length)
      writeFileSync(join(OUT_DIR, `${slug}.svg`), recolor(body))
      console.log('ok')
      ok.push(slug)
      continue
    }
    const url = specToUrl(spec)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // Detect binary image formats (PNG today, extensible) by URL extension so
    // we preserve bytes exactly instead of lossily text-decoding them.
    const ext = (url.match(/\.(png|jpg|jpeg|webp)(?:\?|$)/i)?.[1] ?? 'svg').toLowerCase()
    if (ext === 'svg') {
      const body = await res.text()
      if (body.includes('Not found') || body.length < 40) throw new Error('empty/not-found body')
      writeFileSync(join(OUT_DIR, `${slug}.svg`), recolor(body))
    } else {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 40) throw new Error('empty body')
      writeFileSync(join(OUT_DIR, `${slug}.${ext}`), buf)
    }
    console.log('ok')
    ok.push(slug)
  } catch (err) {
    console.log(`FAIL: ${err.message}`)
    bad.push([slug, err.message])
  }
}

console.log(`\n${ok.length} ok, ${bad.length} failed`)
if (bad.length) {
  for (const [slug, msg] of bad) console.log(`  ${slug}: ${msg}`)
  process.exit(1)
}
