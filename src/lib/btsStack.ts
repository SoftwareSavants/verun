import type { CreateInput, PackageManager } from '@better-t-stack/types'

export type BtsConfig = Partial<Omit<CreateInput, 'projectName'>>

export function pmRunner(pm: PackageManager): 'pnpm dlx' | 'bunx' | 'npx' {
  switch (pm) {
    case 'pnpm':
      return 'pnpm dlx'
    case 'bun':
      return 'bunx'
    case 'npm':
      return 'npx'
  }
}

const SCALAR_FLAGS: Array<[keyof BtsConfig, string]> = [
  ['template', '--template'],
  ['backend', '--backend'],
  ['runtime', '--runtime'],
  ['api', '--api'],
  ['database', '--database'],
  ['orm', '--orm'],
  ['auth', '--auth'],
  ['payments', '--payments'],
  ['packageManager', '--package-manager'],
  ['dbSetup', '--db-setup'],
  ['webDeploy', '--web-deploy'],
  ['serverDeploy', '--server-deploy'],
  ['directoryConflict', '--directory-conflict'],
]

const ARRAY_FLAGS: Array<[keyof BtsConfig, string]> = [
  ['frontend', '--frontend'],
  ['addons', '--addons'],
  ['examples', '--examples'],
]

const BOOL_FLAGS: Array<[keyof BtsConfig, string]> = [
  ['yes', '--yes'],
  ['yolo', '--yolo'],
  ['dryRun', '--dry-run'],
  ['verbose', '--verbose'],
  ['git', '--git'],
  ['install', '--install'],
  ['renderTitle', '--render-title'],
  ['disableAnalytics', '--disable-analytics'],
  ['manualDb', '--manual-db'],
]

export function buildCliArgs(config: BtsConfig, projectName: string): string[] {
  // The CLI rejects `--yes` alongside config flags and `--yolo` overrides every
  // unanswered question with a default. We deliberately omit both: BTS runs in
  // a PTY here, so any question we don't pre-answer via flags is forwarded to
  // the user as a real Clack prompt instead of being silently defaulted.
  const merged: BtsConfig = { git: true, ...config }
  const args: string[] = [projectName]
  for (const [key, flag] of SCALAR_FLAGS) {
    const v = merged[key] as string | undefined
    if (v !== undefined) args.push(flag, v)
  }
  for (const [key, flag] of ARRAY_FLAGS) {
    const v = merged[key] as readonly string[] | undefined
    if (v !== undefined) for (const item of v) args.push(flag, item)
  }
  for (const [key, flag] of BOOL_FLAGS) {
    const v = merged[key] as boolean | undefined
    if (v === true) args.push(flag)
    else if (v === false) args.push(`--no-${flag.slice(2)}`)
  }
  return args
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./@:=]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function buildCommandPreview(config: BtsConfig, projectName: string, pm: PackageManager): string {
  const runner = pmRunner(pm)
  const args = buildCliArgs(config, projectName).map(shellQuote)
  return `${runner} create-better-t-stack ${args.join(' ')}`
}

export interface VerunDefaults {
  startCommand: string
  hooks: { setup: string }
}

export function defaultVerunConfig(pm: PackageManager): VerunDefaults {
  switch (pm) {
    case 'pnpm':
      return { startCommand: 'pnpm dev', hooks: { setup: 'pnpm install' } }
    case 'bun':
      return { startCommand: 'bun dev', hooks: { setup: 'bun install' } }
    case 'npm':
      return { startCommand: 'npm run dev', hooks: { setup: 'npm install' } }
  }
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export function validateCompatibility(c: BtsConfig): ValidationResult {
  const errors: string[] = []
  const push = (m: string) => errors.push(m)

  // ORM <-> database
  if (c.orm === 'mongoose' && c.database && c.database !== 'mongodb') {
    push('Mongoose ORM requires MongoDB database')
  }
  if (c.orm === 'drizzle' && c.database === 'mongodb') {
    push('Drizzle ORM does not support MongoDB')
  }
  if (c.database === 'mongodb' && c.orm && !['mongoose', 'prisma', 'none'].includes(c.orm)) {
    push('MongoDB requires Mongoose or Prisma ORM')
  }
  if (c.database && c.database !== 'none' && c.orm === 'none') {
    push('Database selection requires an ORM')
  }
  if (c.orm && c.orm !== 'none' && c.database === 'none') {
    push('ORM selection requires a database')
  }

  // Convex backend implications
  if (c.backend === 'convex') {
    if (c.database && c.database !== 'none') push("Convex backend requires database 'none'")
    if (c.orm && c.orm !== 'none') push("Convex backend requires orm 'none'")
    if (c.api && c.api !== 'none') push("Convex backend requires api 'none'")
    if (c.dbSetup && c.dbSetup !== 'none') push("Convex backend requires dbSetup 'none'")
    if (c.serverDeploy && c.serverDeploy !== 'none') push("Convex backend requires serverDeploy 'none'")
  }

  // Backend none
  if (c.backend === 'none') {
    if (c.database && c.database !== 'none') push("Backend 'none' requires database 'none'")
    if (c.orm && c.orm !== 'none') push("Backend 'none' requires orm 'none'")
    if (c.api && c.api !== 'none') push("Backend 'none' requires api 'none'")
    if (c.auth && c.auth !== 'none') push("Backend 'none' requires auth 'none'")
    if (c.payments && c.payments !== 'none') push("Backend 'none' requires payments 'none'")
    if (c.dbSetup && c.dbSetup !== 'none') push("Backend 'none' requires dbSetup 'none'")
    if (c.serverDeploy && c.serverDeploy !== 'none') push("Backend 'none' requires serverDeploy 'none'")
  }

  // Backend self <-> fullstack web frontend
  if (c.backend === 'self') {
    const webs = (c.frontend ?? []).filter((v) => !['native-bare', 'native-uniwind', 'native-unistyles'].includes(v))
    const web = webs[0]
    if (!web || !FULLSTACK_FRONTENDS.has(web)) {
      push('Fullstack backend requires Next.js, TanStack Start, Nuxt, or Astro')
    }
    if (c.runtime && c.runtime !== 'none') {
      push('Fullstack backend requires runtime none')
    }
  }

  // Runtime none requires backend in [convex, none, self]
  if (c.runtime === 'none' && c.backend && !['convex', 'none', 'self'].includes(c.backend)) {
    push('Runtime none only works with Convex, fullstack, or no backend')
  }

  // Runtime <-> backend
  if (c.runtime === 'workers' && c.serverDeploy === 'none') {
    push('Workers runtime requires server deployment')
  }
  if (c.serverDeploy === 'cloudflare' && c.runtime && c.runtime !== 'workers') {
    push('Cloudflare server deployment requires workers runtime')
  }

  // tRPC frontend compatibility (CLI rejects nuxt/svelte/solid/astro)
  if (c.api === 'trpc' && c.frontend) {
    const bad = c.frontend.filter((f) => TRPC_BAD_FRONTENDS.has(f))
    if (bad.length) {
      push(`tRPC API not supported with frontend: ${bad.join(', ')}`)
    }
  }

  // dbSetup <-> database
  const dbSetupRules: Array<[string, string[], string]> = [
    ['turso', ['sqlite'], 'Turso requires SQLite database'],
    ['neon', ['postgres'], 'Neon requires PostgreSQL database'],
    ['prisma-postgres', ['postgres'], 'Prisma PostgreSQL requires PostgreSQL'],
    ['planetscale', ['postgres', 'mysql'], 'PlanetScale requires PostgreSQL or MySQL'],
    ['mongodb-atlas', ['mongodb'], 'MongoDB Atlas requires MongoDB'],
    ['supabase', ['postgres'], 'Supabase requires PostgreSQL'],
    ['d1', ['sqlite'], 'D1 requires SQLite database'],
  ]
  for (const [setup, dbs, msg] of dbSetupRules) {
    if (c.dbSetup === setup && c.database && !dbs.includes(c.database)) push(msg)
  }
  if (c.dbSetup === 'docker' && c.database === 'sqlite') {
    push('Docker dbSetup incompatible with SQLite')
  }
  if (c.dbSetup === 'docker' && c.runtime === 'workers') {
    push('Docker dbSetup incompatible with workers runtime')
  }
  // Cloudflare D1 also requires Workers+server-deploy=cloudflare OR self+webDeploy=cloudflare
  if (c.dbSetup === 'd1' && (c.database === undefined || c.database === 'sqlite')) {
    const workersRoute = c.runtime === 'workers' && c.serverDeploy === 'cloudflare'
    const selfRoute = c.backend === 'self' && c.webDeploy === 'cloudflare'
    if (!workersRoute && !selfRoute) {
      push(
        'Cloudflare D1 requires Workers + Cloudflare deploy, or fullstack + Cloudflare web deploy',
      )
    }
  }

  // Auth <-> frontend
  if (c.auth === 'clerk' && c.frontend) {
    const bad = c.frontend.filter((f) => ['nuxt', 'svelte', 'solid', 'astro'].includes(f))
    if (bad.length) push(`Clerk auth incompatible with frontend: ${bad.join(', ')}`)
  }

  // Convex <-> frontend
  if (c.backend === 'convex' && c.frontend) {
    const bad = c.frontend.filter((f) => ['solid', 'astro'].includes(f))
    if (bad.length) push(`Convex backend incompatible with frontend: ${bad.join(', ')}`)
  }

  // Addons: nx and turborepo are mutually exclusive monorepo tools
  if (c.addons && c.addons.includes('nx') && c.addons.includes('turborepo')) {
    push("Nx and Turborepo can't be used together")
  }

  return { valid: errors.length === 0, errors }
}

export const FRONTEND_NATIVE = new Set(['native-bare', 'native-uniwind', 'native-unistyles'])
export const isNativeFrontend = (v: string) => FRONTEND_NATIVE.has(v)

export const FULLSTACK_FRONTENDS = new Set([
  'next',
  'tanstack-start',
  'nuxt',
  'astro',
])
const FULLSTACK_LABELS: Record<string, string> = {
  next: 'Next.js',
  'tanstack-start': 'TanStack Start',
  nuxt: 'Nuxt',
  astro: 'Astro',
}
export const fullstackLabel = (webValue: string | undefined): string | null => {
  if (!webValue) return null
  return FULLSTACK_LABELS[webValue] ?? null
}

const MULTI_KEYS: ReadonlyArray<keyof BtsConfig> = ['frontend', 'addons', 'examples']

/**
 * Compute the config that would result from the user picking `value` in `categoryId`.
 * For multi kinds, toggling an already-selected value removes it. For frontend,
 * the web/native slot is replaced (only one of each can coexist).
 */
export function applyOption(
  config: BtsConfig,
  categoryId: keyof BtsConfig,
  value: string,
  kind: 'single' | 'multi',
): BtsConfig {
  if (kind === 'single') {
    return { ...config, [categoryId]: value } as BtsConfig
  }
  const current = ((config[categoryId] as readonly string[] | undefined) ?? []).slice()
  if (current.includes(value)) {
    const next = current.filter((v) => v !== value)
    return { ...config, [categoryId]: next } as BtsConfig
  }
  if (categoryId === 'frontend') {
    const group = isNativeFrontend(value) ? 'native' : 'web'
    const kept = current.filter((v) =>
      group === 'native' ? !isNativeFrontend(v) : isNativeFrontend(v),
    )
    return { ...config, frontend: [...kept, value] } as BtsConfig
  }
  return { ...config, [categoryId]: [...current, value] } as BtsConfig
}

/**
 * Returns the first validation error that would result from applying `value`
 * in `categoryId`, or null if the result is valid.
 */
export function incompatibleReason(
  config: BtsConfig,
  categoryId: keyof BtsConfig,
  value: string,
  kind: 'single' | 'multi',
): string | null {
  const hypothetical = applyOption(config, categoryId, value, kind)
  const { valid, errors } = validateCompatibility(hypothetical)
  if (valid) return null
  return errors[0] ?? 'Incompatible combination'
}

const DB_NAME: Record<string, string> = {
  sqlite: 'SQLite',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  none: 'no database',
}
const DB_SETUP_NAME: Record<string, string> = {
  turso: 'Turso',
  neon: 'Neon',
  'prisma-postgres': 'Prisma Postgres',
  planetscale: 'PlanetScale',
  'mongodb-atlas': 'MongoDB Atlas',
  supabase: 'Supabase',
  d1: 'Cloudflare D1',
  docker: 'Docker',
}
const DB_SETUP_REQ: Record<string, string[]> = {
  turso: ['sqlite'],
  neon: ['postgres'],
  'prisma-postgres': ['postgres'],
  planetscale: ['postgres', 'mysql'],
  'mongodb-atlas': ['mongodb'],
  supabase: ['postgres'],
  d1: ['sqlite'],
}
const FRONTEND_FRIENDLY: Record<string, string> = {
  next: 'Next.js',
  nuxt: 'Nuxt',
  svelte: 'Svelte',
  solid: 'Solid',
  astro: 'Astro',
  vue: 'Vue',
}
const ORM_FRIENDLY: Record<string, string> = {
  drizzle: 'Drizzle',
  mongoose: 'Mongoose',
  prisma: 'Prisma',
  none: 'no ORM',
}
const FULLSTACK_LIST = 'Next.js, TanStack Start, Nuxt, or Astro'

/**
 * Per-option, personalized "why is this disabled?" message.
 * Phrased from the perspective of the option the user is hovering/clicking,
 * not the whole config. Caller supplies the hypothetical config (option already
 * applied) plus the field/value the user is trying to set. Returns null when
 * the hypothetical is valid.
 */
export function optionDisabledReason(
  next: BtsConfig,
  field: keyof BtsConfig,
  value: string,
): string | null {
  if (validateCompatibility(next).valid) return null

  // ORM clicks
  if (field === 'orm') {
    if (value === 'mongoose' && next.database && next.database !== 'mongodb' && next.database !== 'none') {
      return 'Mongoose only works with MongoDB'
    }
    if (value === 'drizzle' && next.database === 'mongodb') {
      return "Drizzle doesn't support MongoDB"
    }
    if (value === 'none' && next.database && next.database !== 'none') {
      return `${DB_NAME[next.database] ?? next.database} needs an ORM`
    }
    if (next.backend === 'convex' && value !== 'none') return "Convex doesn't use a separate ORM"
    if (next.backend === 'none' && value !== 'none') return 'No backend means no ORM'
  }

  // Database clicks
  if (field === 'database') {
    if (value === 'mongodb' && next.orm === 'drizzle') return "Drizzle doesn't support MongoDB"
    if (value && value !== 'none' && value !== 'mongodb' && next.orm === 'mongoose') {
      return 'Mongoose only works with MongoDB'
    }
    if (value === 'none' && next.orm && next.orm !== 'none') {
      return `${ORM_FRIENDLY[next.orm] ?? next.orm} needs a database`
    }
    if (next.backend === 'convex' && value !== 'none') return 'Convex includes its own database'
    if (next.backend === 'none' && value !== 'none') return 'No backend means no database'
    if (next.dbSetup && next.dbSetup !== 'none') {
      const req = DB_SETUP_REQ[next.dbSetup]
      if (req && value && !req.includes(value)) {
        const dbs = req.map((d) => DB_NAME[d] ?? d).join(' or ')
        return `${DB_SETUP_NAME[next.dbSetup]} requires ${dbs}`
      }
      if (next.dbSetup === 'docker' && value === 'sqlite') return "SQLite doesn't need Docker"
    }
  }

  // dbSetup clicks
  if (field === 'dbSetup' && value !== 'none') {
    if (next.backend === 'convex') return 'Convex hosts its own data'
    if (next.backend === 'none') return 'No backend means no DB setup'
    const req = DB_SETUP_REQ[value]
    if (req && next.database && !req.includes(next.database)) {
      const dbs = req.map((d) => DB_NAME[d] ?? d).join(' or ')
      return `${DB_SETUP_NAME[value]} requires ${dbs}`
    }
    if (value === 'docker' && next.database === 'sqlite') return "SQLite doesn't need Docker"
    if (value === 'docker' && next.runtime === 'workers') return "Docker isn't compatible with Workers runtime"
    if (value === 'd1') {
      const workersRoute = next.runtime === 'workers' && next.serverDeploy === 'cloudflare'
      const selfRoute = next.backend === 'self' && next.webDeploy === 'cloudflare'
      if (!workersRoute && !selfRoute) {
        return 'Cloudflare D1 requires Workers + Cloudflare deploy, or fullstack + Cloudflare web deploy'
      }
    }
  }

  // API clicks
  if (field === 'api' && value !== 'none') {
    if (next.backend === 'convex') return 'Convex provides its own API'
    if (next.backend === 'none') return 'No backend means no API'
    if (value === 'trpc' && next.frontend) {
      const bad = next.frontend
        .filter((f) => TRPC_BAD_FRONTENDS.has(f))
        .map((f) => FRONTEND_FRIENDLY[f] ?? f)
      if (bad.length) return `tRPC doesn't support ${bad.join(' or ')}`
    }
  }

  // Auth clicks
  if (field === 'auth') {
    if (value === 'clerk' && next.frontend) {
      const bad = next.frontend
        .filter((f) => CLERK_BAD_FRONTENDS.has(f))
        .map((f) => FRONTEND_FRIENDLY[f] ?? f)
      if (bad.length) return `Clerk doesn't support ${bad.join(' or ')}`
    }
    if (value !== 'none' && next.backend === 'none') return 'No backend means no auth'
  }

  // Payments clicks
  if (field === 'payments' && value !== 'none' && next.backend === 'none') {
    return 'Payments need a backend'
  }

  // Addons clicks (multi-select; pairwise rules)
  if (field === 'addons' && next.addons) {
    if (value === 'nx' && next.addons.includes('turborepo')) {
      return "Nx and Turborepo can't be used together"
    }
    if (value === 'turborepo' && next.addons.includes('nx')) {
      return "Nx and Turborepo can't be used together"
    }
  }

  // Backend clicks
  if (field === 'backend') {
    if (value === 'self') {
      const webs = (next.frontend ?? []).filter((v) => !isNativeFrontend(v))
      const web = webs[0]
      if (!web || !FULLSTACK_FRONTENDS.has(web)) {
        return `Fullstack backend requires ${FULLSTACK_LIST}`
      }
      if (next.runtime && next.runtime !== 'none') {
        return 'Fullstack backend requires runtime none'
      }
    }
    if (value === 'convex') {
      const things: string[] = []
      if (isSet(next.database)) things.push('database')
      if (isSet(next.orm)) things.push('ORM')
      if (isSet(next.api)) things.push('API')
      if (isSet(next.dbSetup)) things.push('DB setup')
      if (isSet(next.serverDeploy)) things.push('server deploy')
      const badFront = (next.frontend ?? []).filter((f) => CONVEX_BAD_FRONTENDS.has(f))
      if (badFront.length) {
        return `Convex doesn't support ${badFront.map((f) => FRONTEND_FRIENDLY[f] ?? f).join(' or ')}`
      }
      if (things.length) return `Convex includes everything - clear ${things.join(', ')} first`
    }
    if (value === 'none') {
      const things: string[] = []
      if (isSet(next.database)) things.push('database')
      if (isSet(next.orm)) things.push('ORM')
      if (isSet(next.api)) things.push('API')
      if (isSet(next.auth)) things.push('auth')
      if (isSet(next.payments)) things.push('payments')
      if (isSet(next.dbSetup)) things.push('DB setup')
      if (isSet(next.serverDeploy)) things.push('server deploy')
      if (things.length) return `Frontend-only projects don't need ${things.join(', ')}`
    }
  }

  // Frontend clicks
  if (field === 'frontend') {
    if (next.backend === 'convex' && CONVEX_BAD_FRONTENDS.has(value)) {
      return `Convex doesn't support ${FRONTEND_FRIENDLY[value] ?? value}`
    }
    if (next.auth === 'clerk' && CLERK_BAD_FRONTENDS.has(value)) {
      return `Clerk doesn't support ${FRONTEND_FRIENDLY[value] ?? value}`
    }
    if (next.api === 'trpc' && TRPC_BAD_FRONTENDS.has(value)) {
      return `${FRONTEND_FRIENDLY[value] ?? value} doesn't support tRPC`
    }
    if (next.backend === 'self') {
      const webs = (next.frontend ?? []).filter((v) => !isNativeFrontend(v))
      const web = webs[0]
      if (!web || !FULLSTACK_FRONTENDS.has(web)) {
        return `Fullstack backend needs ${FULLSTACK_LIST}`
      }
    }
  }

  // Runtime clicks
  if (field === 'runtime') {
    if (next.backend === 'self' && value !== 'none') {
      return 'Fullstack backend requires runtime none'
    }
    if (value === 'none' && next.backend && !['convex', 'none', 'self'].includes(next.backend)) {
      return 'Runtime none only works with Convex, fullstack, or no backend'
    }
    if (value === 'workers' && next.dbSetup === 'docker') {
      return "Docker isn't compatible with Workers runtime"
    }
    if (value !== 'workers' && next.serverDeploy === 'cloudflare') {
      return 'Cloudflare deploy requires Workers runtime'
    }
  }

  // Server deploy clicks
  if (field === 'serverDeploy') {
    if (value === 'cloudflare' && next.runtime && next.runtime !== 'workers') {
      return 'Cloudflare deploy requires Workers runtime'
    }
    if (value === 'none' && next.runtime === 'workers') {
      return 'Workers runtime needs a deploy target'
    }
    if (value !== 'none' && next.backend === 'convex') return 'Convex deploys itself'
    if (value !== 'none' && next.backend === 'none') return "Frontend-only projects don't have a server"
  }

  // Fallback
  const errs = validateCompatibility(next).errors
  return errs[0] ?? 'Incompatible combination'
}

/** Shortcut for tests: a field is "meaningful" when set and not 'none'. */
const isSet = (v: unknown): boolean => v !== undefined && v !== 'none'

/**
 * Apply pragmatic auto-fixes so neighboring selections stay coherent.
 * Runs after every option change in the UI.
 */
export function coerceDependencies(c: BtsConfig): BtsConfig {
  const out: BtsConfig = { ...c }

  if (out.backend === 'convex') {
    if (isSet(out.database)) out.database = 'none'
    if (isSet(out.orm)) out.orm = 'none'
    if (isSet(out.api)) out.api = 'none'
    if (isSet(out.dbSetup)) out.dbSetup = 'none'
    if (isSet(out.serverDeploy)) out.serverDeploy = 'none'
  } else if (out.backend === 'none') {
    if (isSet(out.database)) out.database = 'none'
    if (isSet(out.orm)) out.orm = 'none'
    if (isSet(out.api)) out.api = 'none'
    if (isSet(out.auth)) out.auth = 'none'
    if (isSet(out.payments)) out.payments = 'none'
    if (isSet(out.dbSetup)) out.dbSetup = 'none'
    if (isSet(out.serverDeploy)) out.serverDeploy = 'none'
  }

  if (out.database === 'mongodb' && out.orm && !['mongoose', 'prisma', 'none'].includes(out.orm)) {
    out.orm = 'mongoose'
  }
  if (
    out.database &&
    out.database !== 'mongodb' &&
    out.database !== 'none' &&
    out.orm === 'mongoose'
  ) {
    out.orm = 'drizzle'
  }
  if (out.database === 'none' && isSet(out.orm)) out.orm = 'none'
  if (out.orm === 'none' && isSet(out.database)) out.database = 'none'

  if (out.runtime === 'workers' && (!out.serverDeploy || out.serverDeploy === 'none')) {
    out.serverDeploy = 'cloudflare'
  }
  if (out.serverDeploy === 'cloudflare' && out.runtime && out.runtime !== 'workers') {
    out.runtime = 'workers'
  }

  const dbSetupDbMap: Array<[string, string]> = [
    ['turso', 'sqlite'],
    ['neon', 'postgres'],
    ['prisma-postgres', 'postgres'],
    ['mongodb-atlas', 'mongodb'],
    ['supabase', 'postgres'],
    ['d1', 'sqlite'],
  ]
  for (const [setup, db] of dbSetupDbMap) {
    if (out.dbSetup === setup && out.database !== db) out.dbSetup = 'none'
  }

  for (const key of MULTI_KEYS) {
    const v = out[key]
    if (v === undefined) continue
    if (Array.isArray(v) && v.length === 0) delete out[key]
  }

  return out
}

const DB_SETUP_DB: Record<string, string> = {
  turso: 'sqlite',
  neon: 'postgres',
  'prisma-postgres': 'postgres',
  'mongodb-atlas': 'mongodb',
  supabase: 'postgres',
  d1: 'sqlite',
}

const CLERK_BAD_FRONTENDS = new Set(['nuxt', 'svelte', 'solid', 'astro'])
const CONVEX_BAD_FRONTENDS = new Set(['solid', 'astro'])
const TRPC_BAD_FRONTENDS = new Set(['nuxt', 'svelte', 'solid', 'astro'])

/**
 * Given a hypothetical config (already reflecting the user's click), return
 * a config where the clicked field is preserved and dependent fields are
 * auto-selected to make the combination valid. Used when the user chooses to
 * click through a disabled option.
 */
export function resolveForOption(
  applied: BtsConfig,
  clickedField: keyof BtsConfig | 'frontend',
): BtsConfig {
  const out: BtsConfig = { ...applied }

  const fix = () => {
    // Backend=self needs a fullstack web frontend and runtime=none.
    if (out.backend === 'self') {
      const webs = (out.frontend ?? []).filter((v) => !isNativeFrontend(v))
      const web = webs[0]
      if (!web || !FULLSTACK_FRONTENDS.has(web)) {
        const natives = (out.frontend ?? []).filter((v) => isNativeFrontend(v))
        out.frontend = ['next', ...natives]
      }
      if (clickedField === 'runtime') {
        if (out.runtime && out.runtime !== 'none') out.backend = 'hono'
      } else if (out.runtime && out.runtime !== 'none') {
        out.runtime = 'none'
      }
    }

    // Runtime=none only works with convex/none/self backend.
    if (out.runtime === 'none' && out.backend && !['convex', 'none', 'self'].includes(out.backend)) {
      if (clickedField === 'runtime') {
        out.backend = 'self'
        const webs = (out.frontend ?? []).filter((v) => !isNativeFrontend(v))
        const web = webs[0]
        if (!web || !FULLSTACK_FRONTENDS.has(web)) {
          const natives = (out.frontend ?? []).filter((v) => isNativeFrontend(v))
          out.frontend = ['next', ...natives]
        }
      } else {
        out.runtime = 'bun'
      }
    }

    // tRPC + incompatible frontend. Clicked side wins.
    if (out.api === 'trpc' && out.frontend) {
      const bad = out.frontend.filter((f) => TRPC_BAD_FRONTENDS.has(f))
      if (bad.length) {
        if (clickedField === 'api') {
          const natives = out.frontend.filter((f) => isNativeFrontend(f))
          out.frontend = ['tanstack-router', ...natives]
        } else {
          out.api = 'orpc'
        }
      }
    }

    // Backend=convex clears data/api/deploy fields and drops solid/astro.
    if (out.backend === 'convex') {
      if (isSet(out.database)) out.database = 'none'
      if (isSet(out.orm)) out.orm = 'none'
      if (isSet(out.api)) out.api = 'none'
      if (isSet(out.dbSetup)) out.dbSetup = 'none'
      if (isSet(out.serverDeploy)) out.serverDeploy = 'none'
      if (out.frontend) {
        const bad = out.frontend.filter((f) => CONVEX_BAD_FRONTENDS.has(f))
        if (bad.length) {
          const kept = out.frontend.filter((f) => !bad.includes(f))
          const hasWeb = kept.some((f) => !isNativeFrontend(f))
          out.frontend = hasWeb ? kept : [...kept, 'next']
        }
      }
    }

    // Backend=none clears every server-side field.
    if (out.backend === 'none') {
      if (isSet(out.database)) out.database = 'none'
      if (isSet(out.orm)) out.orm = 'none'
      if (isSet(out.api)) out.api = 'none'
      if (isSet(out.auth)) out.auth = 'none'
      if (isSet(out.payments)) out.payments = 'none'
      if (isSet(out.dbSetup)) out.dbSetup = 'none'
      if (isSet(out.serverDeploy)) out.serverDeploy = 'none'
    }

    // ORM <-> database. Clicked side wins.
    if (clickedField === 'orm') {
      if (out.orm === 'mongoose' && out.database && out.database !== 'mongodb') out.database = 'mongodb'
      if (out.orm === 'drizzle' && out.database === 'mongodb') out.database = 'sqlite'
      if (out.orm === 'none' && out.database && out.database !== 'none') out.database = 'none'
    } else {
      if (out.database === 'mongodb' && out.orm && !['mongoose', 'prisma', 'none'].includes(out.orm)) {
        out.orm = 'mongoose'
      }
      if (out.database && out.database !== 'mongodb' && out.database !== 'none' && out.orm === 'mongoose') {
        out.orm = 'drizzle'
      }
      if (out.database && out.database !== 'none' && out.orm === 'none') {
        out.orm = out.database === 'mongodb' ? 'mongoose' : 'drizzle'
      }
      if (out.database === 'none' && out.orm && out.orm !== 'none') out.orm = 'none'
    }

    // dbSetup <-> database. Clicked dbSetup drags database along.
    if (clickedField === 'dbSetup') {
      const need = DB_SETUP_DB[out.dbSetup ?? '']
      if (need && out.database !== need) {
        out.database = need as typeof out.database
        if (need === 'mongodb' && !['mongoose', 'prisma'].includes(out.orm ?? '')) {
          out.orm = 'mongoose'
        } else if (need !== 'mongodb' && out.orm === 'mongoose') {
          out.orm = 'drizzle'
        } else if (!isSet(out.orm)) {
          out.orm = need === 'mongodb' ? 'mongoose' : 'drizzle'
        }
      }
      if (out.dbSetup === 'docker' && out.database === 'sqlite') out.database = 'postgres'
      if (out.dbSetup === 'docker' && out.runtime === 'workers') {
        out.runtime = 'node'
        if (out.serverDeploy === 'cloudflare') out.serverDeploy = 'none'
      }
      if (out.dbSetup === 'd1') {
        if (out.backend === 'self') {
          out.webDeploy = 'cloudflare'
        } else {
          out.runtime = 'workers'
          out.serverDeploy = 'cloudflare'
        }
      }
    } else {
      for (const [setup, db] of Object.entries(DB_SETUP_DB)) {
        if (out.dbSetup === setup && out.database !== db) out.dbSetup = 'none'
      }
      if (out.dbSetup === 'd1') {
        const workersRoute = out.runtime === 'workers' && out.serverDeploy === 'cloudflare'
        const selfRoute = out.backend === 'self' && out.webDeploy === 'cloudflare'
        if (!workersRoute && !selfRoute) out.dbSetup = 'none'
      }
    }

    // runtime <-> serverDeploy.
    if (out.runtime === 'workers' && (!out.serverDeploy || out.serverDeploy === 'none')) {
      out.serverDeploy = 'cloudflare'
    }
    if (out.serverDeploy === 'cloudflare' && out.runtime && out.runtime !== 'workers') {
      out.runtime = 'workers'
    }

    // auth=clerk + incompatible frontend. Clicked side wins.
    if (out.auth === 'clerk' && out.frontend) {
      const bad = out.frontend.filter((f) => CLERK_BAD_FRONTENDS.has(f))
      if (bad.length) {
        if (clickedField === 'auth') {
          const natives = out.frontend.filter((f) => isNativeFrontend(f))
          out.frontend = ['next', ...natives]
        } else {
          out.auth = 'none'
        }
      }
    }

    // addons: nx and turborepo are mutually exclusive. Most-recent click wins
    // (applyOption appends, so the just-clicked value is at the end).
    if (out.addons && out.addons.includes('nx') && out.addons.includes('turborepo')) {
      const lastNx = out.addons.lastIndexOf('nx')
      const lastTurbo = out.addons.lastIndexOf('turborepo')
      const drop = lastNx > lastTurbo ? 'turborepo' : 'nx'
      out.addons = out.addons.filter((a) => a !== drop)
    }
  }

  // Iterate to a stable point; stop after a few passes.
  for (let i = 0; i < 4; i++) {
    const before = JSON.stringify(out)
    fix()
    if (JSON.stringify(out) === before) break
  }

  return out
}

export interface ConfigDiff {
  field: keyof BtsConfig
  from: unknown
  to: unknown
}

/** Diff two configs, listing only fields that changed (scalar or array content). */
export function diffConfig(before: BtsConfig, after: BtsConfig): ConfigDiff[] {
  const fields: Array<keyof BtsConfig> = [
    'frontend', 'backend', 'runtime', 'api', 'database', 'orm', 'dbSetup',
    'auth', 'payments', 'webDeploy', 'serverDeploy', 'addons', 'examples',
    'packageManager',
  ]
  const changes: ConfigDiff[] = []
  for (const k of fields) {
    const a = before[k]
    const b = after[k]
    const eq = Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && a.every((v, i) => v === b[i])
      : a === b
    if (!eq) changes.push({ field: k, from: a, to: b })
  }
  return changes
}
