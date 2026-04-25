import type { Component } from 'solid-js'
import {
  CircleDollarSign,
  CloudOff,
  Download,
  GitBranch,
  Layers,
  ListTodo,
  MessageSquare,
  Minus,
  Ruler,
  Smartphone,
  Sparkles,
  SquareDashed,
} from 'lucide-solid'

import svgTanstack from '../assets/icons/brands/tanstack.svg?raw'
import svgReactRouter from '../assets/icons/brands/react-router.svg?raw'
import svgNext from '../assets/icons/brands/next.svg?raw'
import svgNuxt from '../assets/icons/brands/nuxt.svg?raw'
import svgSvelte from '../assets/icons/brands/svelte.svg?raw'
import svgSolid from '../assets/icons/brands/solid.svg?raw'
import svgAstro from '../assets/icons/brands/astro.svg?raw'
import svgExpo from '../assets/icons/brands/expo.svg?raw'
import svgHono from '../assets/icons/brands/hono.svg?raw'
import svgElysia from '../assets/icons/brands/elysia.svg?raw'
import svgExpress from '../assets/icons/brands/express.svg?raw'
import svgFastify from '../assets/icons/brands/fastify.svg?raw'
import svgConvex from '../assets/icons/brands/convex.svg?raw'
import svgBun from '../assets/icons/brands/bun.svg?raw'
import svgNode from '../assets/icons/brands/node.svg?raw'
import svgWorkers from '../assets/icons/brands/workers.svg?raw'
import svgTrpc from '../assets/icons/brands/trpc.svg?raw'
import svgOrpc from '../assets/icons/brands/orpc.svg?raw'
import svgSqlite from '../assets/icons/brands/sqlite.svg?raw'
import svgPostgres from '../assets/icons/brands/postgres.svg?raw'
import svgMysql from '../assets/icons/brands/mysql.svg?raw'
import svgMongo from '../assets/icons/brands/mongo.svg?raw'
import svgDrizzle from '../assets/icons/brands/drizzle.svg?raw'
import svgPrisma from '../assets/icons/brands/prisma.svg?raw'
import svgMongoose from '../assets/icons/brands/mongoose.svg?raw'
import svgClerk from '../assets/icons/brands/clerk.svg?raw'
import svgBetterAuth from '../assets/icons/brands/better-auth.svg?raw'
import svgTurso from '../assets/icons/brands/turso.svg?raw'
import svgNeon from '../assets/icons/brands/neon.svg?raw'
import svgCloudflare from '../assets/icons/brands/cloudflare.svg?raw'
import svgPlanetscale from '../assets/icons/brands/planetscale.svg?raw'
import svgSupabase from '../assets/icons/brands/supabase.svg?raw'
import svgDocker from '../assets/icons/brands/docker.svg?raw'
import svgPwa from '../assets/icons/brands/pwa.svg?raw'
import svgTauri from '../assets/icons/brands/tauri.svg?raw'
import svgBiome from '../assets/icons/brands/biome.svg?raw'
import svgLefthook from '../assets/icons/brands/lefthook.svg?raw'
import svgStarlight from '../assets/icons/brands/starlight.svg?raw'
import svgTurborepo from '../assets/icons/brands/turborepo.svg?raw'
import svgNx from '../assets/icons/brands/nx.svg?raw'
import svgUltracite from '../assets/icons/brands/ultracite.svg?raw'
import svgOxlint from '../assets/icons/brands/oxlint.svg?raw'
import svgOpentui from '../assets/icons/brands/opentui.svg?raw'
import svgWxt from '../assets/icons/brands/wxt.svg?raw'
import svgMcp from '../assets/icons/brands/mcp.svg?raw'
import svgNpm from '../assets/icons/brands/npm.svg?raw'
import svgPnpm from '../assets/icons/brands/pnpm.svg?raw'
import pngFumadocs from '../assets/icons/brands/fumadocs.png?url'

export type CategoryId =
  | 'webFrontend'
  | 'nativeFrontend'
  | 'backend'
  | 'runtime'
  | 'api'
  | 'database'
  | 'orm'
  | 'dbSetup'
  | 'webDeploy'
  | 'serverDeploy'
  | 'auth'
  | 'payments'
  | 'packageManager'
  | 'addons'
  | 'examples'
  | 'install'

type IconComponent = Component<{ size?: number; class?: string }>

export interface CategoryOption {
  value: string
  label: string
  description?: string
  Icon: IconComponent
}

export interface Category {
  id: CategoryId
  label: string
  kind: 'single' | 'multi'
  description?: string
  options: CategoryOption[]
}

const brandFromSvg = (raw: string): IconComponent => (props) => (
  <span
    class={props.class}
    style={{ display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center' }}
    innerHTML={raw.replace('<svg ', `<svg width="${props.size ?? 16}" height="${props.size ?? 16}" `)}
  />
)

const brandFromImage = (url: string): IconComponent => (props) => (
  <img
    src={url}
    class={props.class}
    width={props.size ?? 16}
    height={props.size ?? 16}
    style={{ display: 'inline-block', 'object-fit': 'contain' }}
  />
)

const tinted = (Lucide: IconComponent, color: string): IconComponent => (props) => (
  <span class={props.class} style={{ color, display: 'inline-flex' }}>
    <Lucide size={props.size} />
  </span>
)

interface OptDef {
  value: string
  label: string
  description?: string
  Icon: IconComponent
}

const OPT = (value: string, label: string, description: string, Icon: IconComponent): OptDef => ({
  value,
  label,
  description,
  Icon,
})

const ICON_TANSTACK = brandFromSvg(svgTanstack)
const ICON_REACT_ROUTER = brandFromSvg(svgReactRouter)
const ICON_NEXT = brandFromSvg(svgNext)
const ICON_NUXT = brandFromSvg(svgNuxt)
const ICON_SVELTE = brandFromSvg(svgSvelte)
const ICON_SOLID = brandFromSvg(svgSolid)
const ICON_ASTRO = brandFromSvg(svgAstro)
const ICON_EXPO = brandFromSvg(svgExpo)
const ICON_HONO = brandFromSvg(svgHono)
const ICON_EXPRESS = brandFromSvg(svgExpress)
const ICON_FASTIFY = brandFromSvg(svgFastify)
const ICON_CONVEX = brandFromSvg(svgConvex)
const ICON_BUN = brandFromSvg(svgBun)
const ICON_NODE = brandFromSvg(svgNode)
const ICON_WORKERS = brandFromSvg(svgWorkers)
const ICON_TRPC = brandFromSvg(svgTrpc)
const ICON_SQLITE = brandFromSvg(svgSqlite)
const ICON_POSTGRES = brandFromSvg(svgPostgres)
const ICON_MYSQL = brandFromSvg(svgMysql)
const ICON_MONGO = brandFromSvg(svgMongo)
const ICON_DRIZZLE = brandFromSvg(svgDrizzle)
const ICON_PRISMA = brandFromSvg(svgPrisma)
const ICON_MONGOOSE = brandFromSvg(svgMongoose)
const ICON_CLERK = brandFromSvg(svgClerk)
const ICON_TURSO = brandFromSvg(svgTurso)
const ICON_D1 = brandFromSvg(svgCloudflare)
const ICON_NEON = brandFromSvg(svgNeon)
const ICON_PRISMA_PG = brandFromSvg(svgPrisma)
const ICON_PLANETSCALE = brandFromSvg(svgPlanetscale)
const ICON_SUPABASE = brandFromSvg(svgSupabase)
const ICON_DOCKER = brandFromSvg(svgDocker)
const ICON_CLOUDFLARE = brandFromSvg(svgCloudflare)
const ICON_PWA = brandFromSvg(svgPwa)
const ICON_TAURI = brandFromSvg(svgTauri)
const ICON_STARLIGHT = brandFromSvg(svgStarlight)
const ICON_FUMADOCS = brandFromImage(pngFumadocs)
const ICON_BIOME = brandFromSvg(svgBiome)
const ICON_LEFTHOOK = brandFromSvg(svgLefthook)
const ICON_HUSKY: IconComponent = (props) => <GitBranch size={props.size} class={props.class} />
const ICON_MCP = brandFromSvg(svgMcp)
const ICON_TURBOREPO = brandFromSvg(svgTurborepo)
const ICON_NX = brandFromSvg(svgNx)
const ICON_ULTRACITE = brandFromSvg(svgUltracite)
const ICON_OXLINT = brandFromSvg(svgOxlint)
const ICON_OPENTUI = brandFromSvg(svgOpentui)
const ICON_WXT = brandFromSvg(svgWxt)
const ICON_SKILLS = tinted(Sparkles, '#f59e0b')
const ICON_ELECTROBUN: IconComponent = (props) => <SquareDashed size={props.size} class={props.class} />
const ICON_ELYSIA = brandFromSvg(svgElysia)
const ICON_ORPC = brandFromSvg(svgOrpc)
const ICON_BETTER_AUTH = brandFromSvg(svgBetterAuth)
const ICON_POLAR = tinted(CircleDollarSign, '#0062FF')
const ICON_NPM = brandFromSvg(svgNpm)
const ICON_PNPM = brandFromSvg(svgPnpm)
const ICON_BUN_PM = brandFromSvg(svgBun)
const ICON_TODO = tinted(ListTodo, '#34d399')
const ICON_AI = tinted(MessageSquare, '#a78bfa')
const ICON_SELF = tinted(Layers, '#a1a1aa')
const ICON_NONE_WEB = tinted(CloudOff, '#71717a')
const ICON_NO_NATIVE = tinted(Smartphone, '#71717a')
const ICON_INSTALL = tinted(Download, '#34d399')
const ICON_SKIP_INSTALL = tinted(Minus, '#71717a')
const ICON_RULER = tinted(Ruler, '#a1a1aa')

const WEB_FRONTEND: OptDef[] = [
  OPT('tanstack-router', 'TanStack Router', 'Type-safe React router', ICON_TANSTACK),
  OPT('react-router', 'React Router', 'Declarative React routing', ICON_REACT_ROUTER),
  OPT('tanstack-start', 'TanStack Start', 'Full-stack TanStack Router', ICON_TANSTACK),
  OPT('next', 'Next.js', 'React hybrid rendering framework', ICON_NEXT),
  OPT('nuxt', 'Nuxt', 'Vue full-stack framework', ICON_NUXT),
  OPT('svelte', 'Svelte', 'Cybernetically enhanced web apps', ICON_SVELTE),
  OPT('solid', 'Solid', 'Fast reactive UI library', ICON_SOLID),
  OPT('astro', 'Astro', 'Content-driven web framework', ICON_ASTRO),
  OPT('none', 'No Web Frontend', 'Skip web frontend', ICON_NONE_WEB),
]

const NATIVE_FRONTEND: OptDef[] = [
  OPT('native-bare', 'Expo + Bare', 'Expo with StyleSheet', ICON_EXPO),
  OPT('native-uniwind', 'Expo + Uniwind', 'Expo + Tailwind + HeroUI', ICON_EXPO),
  OPT('native-unistyles', 'Expo + Unistyles', 'Expo + type-safe styling', ICON_EXPO),
  OPT('none', 'No Native Frontend', 'Skip mobile frontend', ICON_NO_NATIVE),
]

const BACKEND: OptDef[] = [
  OPT('hono', 'Hono', 'Ultrafast web framework', ICON_HONO),
  OPT('elysia', 'Elysia', 'TypeScript web framework', ICON_ELYSIA),
  OPT('express', 'Express', 'Popular Node.js framework', ICON_EXPRESS),
  OPT('fastify', 'Fastify', 'Low-overhead Node framework', ICON_FASTIFY),
  OPT('convex', 'Convex', 'Reactive backend-as-a-service', ICON_CONVEX),
  OPT('self', 'Fullstack', "Web framework's own API routes", ICON_SELF),
  OPT('none', 'No Backend', 'Frontend only', ICON_NONE_WEB),
]

const RUNTIME: OptDef[] = [
  OPT('bun', 'Bun', 'Fast JS runtime & toolkit', ICON_BUN),
  OPT('node', 'Node.js', 'Standard JS runtime', ICON_NODE),
  OPT('workers', 'Cloudflare Workers', 'Serverless edge runtime', ICON_WORKERS),
]

const API: OptDef[] = [
  OPT('trpc', 'tRPC', 'End-to-end typesafe APIs', ICON_TRPC),
  OPT('orpc', 'oRPC', 'Typesafe APIs, made simple', ICON_ORPC),
  OPT('none', 'No API', 'Skip API layer', ICON_NONE_WEB),
]

const DATABASE: OptDef[] = [
  OPT('sqlite', 'SQLite', 'File-based SQL database', ICON_SQLITE),
  OPT('postgres', 'PostgreSQL', 'Advanced SQL database', ICON_POSTGRES),
  OPT('mysql', 'MySQL', 'Popular relational database', ICON_MYSQL),
  OPT('mongodb', 'MongoDB', 'NoSQL document database', ICON_MONGO),
  OPT('none', 'No Database', 'Skip database', ICON_NONE_WEB),
]

const ORM: OptDef[] = [
  OPT('drizzle', 'Drizzle', 'TypeScript SQL ORM', ICON_DRIZZLE),
  OPT('prisma', 'Prisma', 'Next-gen ORM', ICON_PRISMA),
  OPT('mongoose', 'Mongoose', 'MongoDB object modeling', ICON_MONGOOSE),
  OPT('none', 'No ORM', 'Skip ORM', ICON_NONE_WEB),
]

const DB_SETUP: OptDef[] = [
  OPT('turso', 'Turso', 'Distributed SQLite (libSQL)', ICON_TURSO),
  OPT('d1', 'Cloudflare D1', 'Serverless SQLite for Workers', ICON_D1),
  OPT('neon', 'Neon Postgres', 'Serverless Postgres w/ branching', ICON_NEON),
  OPT('prisma-postgres', 'Prisma PostgreSQL', 'Managed Postgres via Prisma', ICON_PRISMA_PG),
  OPT('mongodb-atlas', 'MongoDB Atlas', 'Managed MongoDB in the cloud', ICON_MONGO),
  OPT('supabase', 'Supabase', 'Local Postgres (Docker)', ICON_SUPABASE),
  OPT('planetscale', 'PlanetScale', 'Postgres & Vitess on NVMe', ICON_PLANETSCALE),
  OPT('docker', 'Docker', 'Local DB via Docker Compose', ICON_DOCKER),
  OPT('none', 'Basic Setup', 'No cloud DB integration', ICON_NONE_WEB),
]

const WEB_DEPLOY: OptDef[] = [
  OPT('cloudflare', 'Cloudflare', 'Deploy to Workers via Alchemy', ICON_CLOUDFLARE),
  OPT('none', 'None', 'Skip deployment', ICON_NONE_WEB),
]

const SERVER_DEPLOY: OptDef[] = [
  OPT('cloudflare', 'Cloudflare', 'Deploy to Workers via Alchemy', ICON_CLOUDFLARE),
  OPT('none', 'None', 'Skip deployment', ICON_NONE_WEB),
]

const AUTH: OptDef[] = [
  OPT('better-auth', 'Better-Auth', 'Comprehensive TS auth framework', ICON_BETTER_AUTH),
  OPT('clerk', 'Clerk', 'Auth + user management', ICON_CLERK),
  OPT('none', 'No Auth', 'Skip auth', ICON_NONE_WEB),
]

const PAYMENTS: OptDef[] = [
  OPT('polar', 'Polar', 'Billing in 6 lines of code', ICON_POLAR),
  OPT('none', 'No Payments', 'Skip payments', ICON_NONE_WEB),
]

const PACKAGE_MANAGER: OptDef[] = [
  OPT('npm', 'npm', 'Default package manager', ICON_NPM),
  OPT('pnpm', 'pnpm', 'Fast, disk-efficient', ICON_PNPM),
  OPT('bun', 'bun', 'All-in-one toolkit', ICON_BUN_PM),
]

const ADDONS: OptDef[] = [
  OPT('pwa', 'PWA', 'Installable, offline-capable', ICON_PWA),
  OPT('tauri', 'Tauri', 'Native desktop apps', ICON_TAURI),
  OPT('electrobun', 'Electrobun', 'Lightweight desktop shell', ICON_ELECTROBUN),
  OPT('starlight', 'Starlight', 'Stellar docs with Astro', ICON_STARLIGHT),
  OPT('fumadocs', 'Fumadocs', 'Docs site toolkit', ICON_FUMADOCS),
  OPT('lefthook', 'Lefthook', 'Fast Git hooks manager', ICON_LEFTHOOK),
  OPT('husky', 'Husky', 'Native Git hooks', ICON_HUSKY),
  OPT('biome', 'Biome', 'Format + lint', ICON_BIOME),
  OPT('oxlint', 'Oxlint', 'Oxlint + Oxfmt', ICON_OXLINT),
  OPT('turborepo', 'Turborepo', 'High-performance build system', ICON_TURBOREPO),
  OPT('nx', 'Nx', 'Smart monorepo build system', ICON_NX),
  OPT('ultracite', 'Ultracite', 'Biome preset with AI', ICON_ULTRACITE),
  OPT('opentui', 'OpenTUI', 'Terminal UI toolkit', ICON_OPENTUI),
  OPT('wxt', 'WXT', 'Browser extensions', ICON_WXT),
  OPT('skills', 'Skills', 'AI skills for coding assistants', ICON_SKILLS),
  OPT('mcp', 'MCP', 'MCP servers for agents/editors', ICON_MCP),
]

const EXAMPLES: OptDef[] = [
  OPT('todo', 'Todo Example', 'Simple todo app', ICON_TODO),
  OPT('ai', 'AI Example', 'AI SDK integration', ICON_AI),
  OPT('none', 'No Example', 'Skip example', ICON_NONE_WEB),
]

const INSTALL: OptDef[] = [
  OPT('install', 'Install Dependencies', 'Auto-install packages', ICON_INSTALL),
  OPT('skip', 'Skip Install', 'Skip install step', ICON_SKIP_INSTALL),
]

export const BTS_CATEGORIES: Category[] = [
  { id: 'webFrontend', label: 'Web Frontend', kind: 'single', description: 'Pick a browser-side framework', options: WEB_FRONTEND },
  { id: 'nativeFrontend', label: 'Native Frontend', kind: 'single', description: 'React Native via Expo', options: NATIVE_FRONTEND },
  { id: 'backend', label: 'Backend', kind: 'single', description: 'Server framework', options: BACKEND },
  { id: 'runtime', label: 'Runtime', kind: 'single', description: 'Where the backend runs', options: RUNTIME },
  { id: 'api', label: 'API', kind: 'single', description: 'Typed client/server bridge', options: API },
  { id: 'database', label: 'Database', kind: 'single', description: 'Primary datastore', options: DATABASE },
  { id: 'orm', label: 'ORM', kind: 'single', description: 'Query builder / schema toolkit', options: ORM },
  { id: 'dbSetup', label: 'DB Setup', kind: 'single', description: 'Managed DB provider', options: DB_SETUP },
  { id: 'webDeploy', label: 'Web Deploy', kind: 'single', description: 'Static / frontend hosting', options: WEB_DEPLOY },
  { id: 'serverDeploy', label: 'Server Deploy', kind: 'single', description: 'Backend hosting target', options: SERVER_DEPLOY },
  { id: 'auth', label: 'Auth', kind: 'single', description: 'Authentication provider', options: AUTH },
  { id: 'payments', label: 'Payments', kind: 'single', description: 'Monetization / subscriptions', options: PAYMENTS },
  { id: 'packageManager', label: 'Package Manager', kind: 'single', description: 'Dependency manager', options: PACKAGE_MANAGER },
  { id: 'addons', label: 'Addons', kind: 'multi', description: 'Extra tooling (pick any)', options: ADDONS },
  { id: 'examples', label: 'Examples', kind: 'single', description: 'Prewired example feature', options: EXAMPLES },
  { id: 'install', label: 'Install', kind: 'single', description: 'Install dependencies after scaffold', options: INSTALL },
]

export { ICON_RULER }
