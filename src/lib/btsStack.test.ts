import { describe, it, expect } from 'vitest'
import {
  pmRunner,
  buildCliArgs,
  buildCommandPreview,
  defaultVerunConfig,
  validateCompatibility,
  applyOption,
  incompatibleReason,
  optionDisabledReason,
  coerceDependencies,
  resolveForOption,
  diffConfig,
  type BtsConfig,
} from './btsStack'

describe('pmRunner', () => {
  it('maps each PM to its dlx runner', () => {
    expect(pmRunner('pnpm')).toBe('pnpm dlx')
    expect(pmRunner('bun')).toBe('bunx')
    expect(pmRunner('npm')).toBe('npx')
  })
})

describe('buildCliArgs', () => {
  it('puts projectName first', () => {
    const args = buildCliArgs({}, 'my-app')
    expect(args[0]).toBe('my-app')
  })

  it('emits scalar enum flags with kebab-case names', () => {
    const cfg: BtsConfig = {
      backend: 'hono',
      runtime: 'node',
      api: 'trpc',
      database: 'postgres',
      orm: 'drizzle',
      auth: 'better-auth',
      packageManager: 'pnpm',
      webDeploy: 'cloudflare',
      serverDeploy: 'cloudflare',
      dbSetup: 'neon',
    }
    const args = buildCliArgs(cfg, 'app')
    expect(args).toContain('--backend')
    expect(args).toContain('hono')
    expect(args).toContain('--runtime')
    expect(args).toContain('node')
    expect(args).toContain('--api')
    expect(args).toContain('--database')
    expect(args).toContain('--orm')
    expect(args).toContain('--auth')
    expect(args).toContain('--package-manager')
    expect(args).toContain('pnpm')
    expect(args).toContain('--web-deploy')
    expect(args).toContain('--server-deploy')
    expect(args).toContain('--db-setup')
    expect(args).toContain('neon')
  })

  it('repeats array flags (frontend, addons, examples)', () => {
    const cfg: BtsConfig = {
      frontend: ['tanstack-router', 'native-bare'],
      addons: ['biome', 'turborepo'],
      examples: ['todo', 'ai'],
    }
    const args = buildCliArgs(cfg, 'app')
    const frontendIdxs = args.map((a, i) => (a === '--frontend' ? i : -1)).filter((i) => i >= 0)
    expect(frontendIdxs).toHaveLength(2)
    expect(args[frontendIdxs[0] + 1]).toBe('tanstack-router')
    expect(args[frontendIdxs[1] + 1]).toBe('native-bare')
    expect(args.filter((a) => a === '--addons')).toHaveLength(2)
    expect(args.filter((a) => a === '--examples')).toHaveLength(2)
  })

  it('emits boolean negations (--no-git, --no-install)', () => {
    const cfg: BtsConfig = { git: false, install: false }
    const args = buildCliArgs(cfg, 'app')
    expect(args).toContain('--no-git')
    expect(args).toContain('--no-install')
  })

  it('skips undefined keys', () => {
    const args = buildCliArgs({}, 'app')
    expect(args).not.toContain('--backend')
    expect(args).not.toContain('--frontend')
  })

  it('forces --git by default but never injects --yes/--yolo (CLI runs interactively for unanswered prompts)', () => {
    const args = buildCliArgs({}, 'app')
    expect(args).toContain('--git')
    expect(args).not.toContain('--yes')
    expect(args).not.toContain('--yolo')
  })

  it('allows explicit git:false to override the default', () => {
    const args = buildCliArgs({ git: false }, 'app')
    expect(args).toContain('--no-git')
    expect(args).not.toContain('--git')
  })

  it('does not emit --package-manager when unset', () => {
    const args = buildCliArgs({ backend: 'hono' }, 'app')
    expect(args).not.toContain('--package-manager')
  })
})

describe('buildCommandPreview', () => {
  it('prefixes with runner and base command', () => {
    const preview = buildCommandPreview({ backend: 'hono' }, 'app', 'pnpm')
    expect(preview.startsWith('pnpm dlx create-better-t-stack app')).toBe(true)
    expect(preview).toContain('--backend hono')
  })

  it('uses bunx for bun', () => {
    expect(buildCommandPreview({}, 'app', 'bun').startsWith('bunx create-better-t-stack')).toBe(true)
  })

  it('quotes args containing spaces', () => {
    const preview = buildCommandPreview({}, 'my app', 'npm')
    expect(preview).toContain("'my app'")
  })
})

describe('defaultVerunConfig', () => {
  it('pnpm uses pnpm dev and pnpm install', () => {
    expect(defaultVerunConfig('pnpm')).toEqual({ startCommand: 'pnpm dev', hooks: { setup: 'pnpm install' } })
  })
  it('bun uses bun dev and bun install', () => {
    expect(defaultVerunConfig('bun')).toEqual({ startCommand: 'bun dev', hooks: { setup: 'bun install' } })
  })
  it('npm uses npm run dev and npm install', () => {
    expect(defaultVerunConfig('npm')).toEqual({ startCommand: 'npm run dev', hooks: { setup: 'npm install' } })
  })
})

describe('validateCompatibility', () => {
  it('accepts empty config', () => {
    expect(validateCompatibility({}).valid).toBe(true)
  })

  it('rejects mongoose with non-mongodb', () => {
    const r = validateCompatibility({ orm: 'mongoose', database: 'postgres' })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/Mongoose.*MongoDB/i)
  })

  it('rejects drizzle with mongodb', () => {
    const r = validateCompatibility({ orm: 'drizzle', database: 'mongodb' })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/Drizzle.*MongoDB/i)
  })

  it('rejects database set with orm=none', () => {
    const r = validateCompatibility({ database: 'postgres', orm: 'none' })
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/Database.*ORM/i)
  })

  it('rejects orm set with database=none', () => {
    const r = validateCompatibility({ database: 'none', orm: 'drizzle' })
    expect(r.valid).toBe(false)
  })

  it('accepts convex + any runtime', () => {
    expect(validateCompatibility({ backend: 'convex', runtime: 'bun' }).valid).toBe(true)
    expect(validateCompatibility({ backend: 'convex', runtime: 'node' }).valid).toBe(true)
  })

  it('accepts backend=none with any runtime', () => {
    expect(validateCompatibility({ backend: 'none', runtime: 'bun' }).valid).toBe(true)
  })

  it('rejects workers runtime without cloudflare serverDeploy', () => {
    const r = validateCompatibility({ runtime: 'workers', serverDeploy: 'none', backend: 'hono' })
    expect(r.valid).toBe(false)
  })

  it('rejects cloudflare serverDeploy without workers runtime', () => {
    const r = validateCompatibility({ runtime: 'node', serverDeploy: 'cloudflare', backend: 'hono' })
    expect(r.valid).toBe(false)
  })

  it('accepts hono + node + postgres + drizzle', () => {
    expect(
      validateCompatibility({
        backend: 'hono',
        runtime: 'node',
        database: 'postgres',
        orm: 'drizzle',
        frontend: ['tanstack-router'],
      }).valid,
    ).toBe(true)
  })

  it('rejects runtime=none with hono backend', () => {
    expect(validateCompatibility({ runtime: 'none', backend: 'hono' }).valid).toBe(false)
  })

  it('accepts runtime=none with convex backend', () => {
    expect(validateCompatibility({ runtime: 'none', backend: 'convex' }).valid).toBe(true)
  })

  it('accepts runtime=none with backend=none', () => {
    expect(validateCompatibility({ runtime: 'none', backend: 'none' }).valid).toBe(true)
  })

  it('accepts runtime=none with backend=self + fullstack frontend', () => {
    expect(
      validateCompatibility({ runtime: 'none', backend: 'self', frontend: ['next'] }).valid,
    ).toBe(true)
  })

  it('rejects api=trpc with nuxt frontend', () => {
    expect(validateCompatibility({ api: 'trpc', frontend: ['nuxt'], backend: 'self' }).valid).toBe(
      false,
    )
  })

  it('rejects api=trpc with svelte, solid, or astro frontend', () => {
    const frontends: Array<'svelte' | 'solid' | 'astro'> = ['svelte', 'solid', 'astro']
    for (const f of frontends) {
      expect(validateCompatibility({ api: 'trpc', frontend: [f] }).valid).toBe(false)
    }
  })

  it('accepts api=trpc with tanstack-router', () => {
    expect(validateCompatibility({ api: 'trpc', frontend: ['tanstack-router'] }).valid).toBe(true)
  })

  it('rejects dbSetup=d1 with sqlite but bun runtime (no workers/self)', () => {
    expect(
      validateCompatibility({
        dbSetup: 'd1',
        database: 'sqlite',
        orm: 'drizzle',
        backend: 'hono',
        runtime: 'bun',
      }).valid,
    ).toBe(false)
  })

  it('accepts dbSetup=d1 with workers runtime + cloudflare server deploy', () => {
    expect(
      validateCompatibility({
        dbSetup: 'd1',
        database: 'sqlite',
        orm: 'drizzle',
        backend: 'hono',
        runtime: 'workers',
        serverDeploy: 'cloudflare',
      }).valid,
    ).toBe(true)
  })

  it('accepts dbSetup=d1 with backend=self + cloudflare web deploy', () => {
    expect(
      validateCompatibility({
        dbSetup: 'd1',
        database: 'sqlite',
        orm: 'drizzle',
        backend: 'self',
        frontend: ['next'],
        runtime: 'none',
        webDeploy: 'cloudflare',
      }).valid,
    ).toBe(true)
  })

  it('rejects backend=self with bun runtime', () => {
    expect(
      validateCompatibility({ backend: 'self', frontend: ['next'], runtime: 'bun' }).valid,
    ).toBe(false)
  })

  it('accepts backend=self with runtime=none', () => {
    expect(
      validateCompatibility({ backend: 'self', frontend: ['next'], runtime: 'none' }).valid,
    ).toBe(true)
  })

  it('rejects nx and turborepo together', () => {
    expect(validateCompatibility({ addons: ['nx', 'turborepo'] }).valid).toBe(false)
  })

  it('accepts nx alone', () => {
    expect(validateCompatibility({ addons: ['nx'] }).valid).toBe(true)
  })

  it('accepts turborepo alone', () => {
    expect(validateCompatibility({ addons: ['turborepo'] }).valid).toBe(true)
  })
})

describe('applyOption', () => {
  it('sets a scalar field for single kind', () => {
    const next = applyOption({ backend: 'hono' }, 'backend', 'express', 'single')
    expect(next.backend).toBe('express')
  })

  it('adds to array field for multi kind', () => {
    const next = applyOption({ addons: ['turborepo'] }, 'addons', 'biome', 'multi')
    expect(next.addons).toEqual(['turborepo', 'biome'])
  })

  it('replaces the web slot when adding another web frontend', () => {
    const next = applyOption(
      { frontend: ['tanstack-router', 'native-uniwind'] },
      'frontend',
      'next',
      'multi',
    )
    expect(next.frontend).toEqual(['native-uniwind', 'next'])
  })

  it('replaces the native slot when adding another native frontend', () => {
    const next = applyOption(
      { frontend: ['tanstack-router', 'native-uniwind'] },
      'frontend',
      'native-unistyles',
      'multi',
    )
    expect(next.frontend).toEqual(['tanstack-router', 'native-unistyles'])
  })
})

describe('incompatibleReason', () => {
  it('returns null when applying keeps config valid', () => {
    expect(
      incompatibleReason({ backend: 'hono', database: 'postgres' }, 'orm', 'drizzle', 'single'),
    ).toBeNull()
  })

  it('returns a reason when applying would violate a rule', () => {
    const reason = incompatibleReason(
      { database: 'mongodb' },
      'orm',
      'drizzle',
      'single',
    )
    expect(reason).toMatch(/Drizzle.*MongoDB/i)
  })

  it('rejects clerk auth with an incompatible frontend already selected', () => {
    const reason = incompatibleReason(
      { frontend: ['astro'] },
      'auth',
      'clerk',
      'single',
    )
    expect(reason).toMatch(/Clerk/i)
  })
})

describe('coerceDependencies', () => {
  it('switches drizzle -> mongoose when database becomes mongodb', () => {
    const out = coerceDependencies({ database: 'mongodb', orm: 'drizzle' })
    expect(out.orm).toBe('mongoose')
  })

  it('switches mongoose -> drizzle when database becomes non-mongodb', () => {
    const out = coerceDependencies({ database: 'postgres', orm: 'mongoose' })
    expect(out.orm).toBe('drizzle')
  })

  it('clears api/orm/database when backend is convex but preserves runtime', () => {
    const out = coerceDependencies({
      backend: 'convex',
      runtime: 'bun',
      api: 'trpc',
      orm: 'drizzle',
      database: 'sqlite',
    })
    expect(out.runtime).toBe('bun')
    expect(out.api).toBe('none')
    expect(out.orm).toBe('none')
    expect(out.database).toBe('none')
  })

  it('clears dependent fields when backend is none but preserves runtime', () => {
    const out = coerceDependencies({ backend: 'none', runtime: 'node', auth: 'better-auth' })
    expect(out.runtime).toBe('node')
    expect(out.auth).toBe('none')
  })

  it('sets serverDeploy to cloudflare when runtime is workers', () => {
    const out = coerceDependencies({ runtime: 'workers', backend: 'hono', serverDeploy: 'none' })
    expect(out.serverDeploy).toBe('cloudflare')
  })

  it('is idempotent on a valid config', () => {
    const cfg: BtsConfig = { backend: 'hono', runtime: 'bun', database: 'sqlite', orm: 'drizzle' }
    expect(coerceDependencies(cfg)).toEqual(cfg)
  })
})

describe('resolveForOption', () => {
  it('switches database when clicking incompatible ORM', () => {
    const applied: BtsConfig = { database: 'mongodb', orm: 'drizzle' }
    const out = resolveForOption(applied, 'orm')
    expect(out.orm).toBe('drizzle')
    expect(out.database).toBe('sqlite')
  })

  it('swaps web frontend to next when picking backend=self on solid', () => {
    const applied: BtsConfig = { frontend: ['solid'], backend: 'self' }
    const out = resolveForOption(applied, 'backend')
    expect(out.backend).toBe('self')
    expect(out.frontend).toContain('next')
    expect(out.frontend).not.toContain('solid')
  })

  it('pulls database to sqlite when clicking dbSetup=turso', () => {
    const applied: BtsConfig = { database: 'postgres', orm: 'drizzle', dbSetup: 'turso' }
    const out = resolveForOption(applied, 'dbSetup')
    expect(out.dbSetup).toBe('turso')
    expect(out.database).toBe('sqlite')
    expect(out.orm).toBe('drizzle')
  })

  it('clears data fields when picking backend=convex', () => {
    const applied: BtsConfig = {
      backend: 'convex',
      database: 'postgres',
      orm: 'drizzle',
      api: 'trpc',
    }
    const out = resolveForOption(applied, 'backend')
    expect(out.database).toBe('none')
    expect(out.orm).toBe('none')
    expect(out.api).toBe('none')
  })

  it('adds cloudflare server deploy when runtime becomes workers', () => {
    const applied: BtsConfig = { runtime: 'workers', serverDeploy: 'none' }
    const out = resolveForOption(applied, 'runtime')
    expect(out.serverDeploy).toBe('cloudflare')
  })

  it('switches frontend to next when clicking clerk auth with astro', () => {
    const applied: BtsConfig = { frontend: ['astro'], auth: 'clerk' }
    const out = resolveForOption(applied, 'auth')
    expect(out.auth).toBe('clerk')
    expect(out.frontend).toContain('next')
    expect(out.frontend).not.toContain('astro')
  })
})

describe('optionDisabledReason', () => {
  it('returns null when next config is valid', () => {
    expect(optionDisabledReason({ backend: 'hono', database: 'postgres', orm: 'drizzle' }, 'orm', 'drizzle')).toBeNull()
  })

  it('describes Mongoose/postgres mismatch from ORM perspective', () => {
    const next: BtsConfig = { database: 'postgres', orm: 'mongoose' }
    expect(optionDisabledReason(next, 'orm', 'mongoose')).toBe('Mongoose only works with MongoDB')
  })

  it('describes Drizzle/MongoDB mismatch from database perspective', () => {
    const next: BtsConfig = { database: 'mongodb', orm: 'drizzle' }
    expect(optionDisabledReason(next, 'database', 'mongodb')).toBe("Drizzle doesn't support MongoDB")
  })

  it('says SQLite doesn\'t need Docker on the docker dbSetup card', () => {
    const next: BtsConfig = { database: 'sqlite', dbSetup: 'docker' }
    expect(optionDisabledReason(next, 'dbSetup', 'docker')).toBe("SQLite doesn't need Docker")
  })

  it('says Neon requires PostgreSQL on the neon card', () => {
    const next: BtsConfig = { database: 'sqlite', dbSetup: 'neon' }
    expect(optionDisabledReason(next, 'dbSetup', 'neon')).toBe('Neon requires PostgreSQL')
  })

  it('says PlanetScale requires PostgreSQL or MySQL', () => {
    const next: BtsConfig = { database: 'mongodb', orm: 'mongoose', dbSetup: 'planetscale' }
    expect(optionDisabledReason(next, 'dbSetup', 'planetscale')).toBe('PlanetScale requires PostgreSQL or MySQL')
  })

  it('explains Convex includes its own database', () => {
    const next: BtsConfig = { backend: 'convex', database: 'postgres' }
    expect(optionDisabledReason(next, 'database', 'postgres')).toBe('Convex includes its own database')
  })

  it('explains Convex doesn\'t support solid frontend', () => {
    const next: BtsConfig = { backend: 'convex', frontend: ['solid'] }
    expect(optionDisabledReason(next, 'frontend', 'solid')).toBe("Convex doesn't support Solid")
  })

  it('explains Clerk doesn\'t support Astro', () => {
    const next: BtsConfig = { auth: 'clerk', frontend: ['astro'] }
    expect(optionDisabledReason(next, 'auth', 'clerk')).toBe("Clerk doesn't support Astro")
  })

  it('explains Cloudflare deploy requires Workers', () => {
    const next: BtsConfig = { runtime: 'node', serverDeploy: 'cloudflare' }
    expect(optionDisabledReason(next, 'serverDeploy', 'cloudflare')).toBe('Cloudflare deploy requires Workers runtime')
  })

  it('explains Workers needs a deploy target', () => {
    const next: BtsConfig = { runtime: 'workers', serverDeploy: 'none', backend: 'hono' }
    expect(optionDisabledReason(next, 'serverDeploy', 'none')).toBe('Workers runtime needs a deploy target')
  })

  it('explains fullstack backend requires a fullstack frontend', () => {
    const next: BtsConfig = { backend: 'self', frontend: ['solid'] }
    const r = optionDisabledReason(next, 'backend', 'self')
    expect(r).toMatch(/Fullstack/)
    expect(r).toMatch(/Next\.js, TanStack Start, Nuxt, or Astro/)
  })

  it('explains Frontend-only projects don\'t need DB/ORM/auth', () => {
    const next: BtsConfig = { backend: 'none', database: 'postgres', orm: 'drizzle', auth: 'better-auth' }
    const r = optionDisabledReason(next, 'backend', 'none')
    expect(r).toMatch(/Frontend-only/)
    expect(r).toMatch(/database/)
  })

  it('explains runtime=none requires convex/none/self backend', () => {
    const next: BtsConfig = { runtime: 'none', backend: 'hono' }
    expect(optionDisabledReason(next, 'runtime', 'none')).toBe(
      'Runtime none only works with Convex, fullstack, or no backend',
    )
  })

  it('explains tRPC isn\'t supported with Nuxt', () => {
    const next: BtsConfig = { api: 'trpc', frontend: ['nuxt'], backend: 'self' }
    expect(optionDisabledReason(next, 'api', 'trpc')).toBe("tRPC doesn't support Nuxt")
  })

  it('explains tRPC isn\'t supported with multiple incompatible frontends', () => {
    const next: BtsConfig = { api: 'trpc', frontend: ['svelte'] }
    expect(optionDisabledReason(next, 'api', 'trpc')).toBe("tRPC doesn't support Svelte")
  })

  it('explains a frontend doesn\'t support tRPC when api is already trpc', () => {
    const next: BtsConfig = { api: 'trpc', frontend: ['nuxt'] }
    expect(optionDisabledReason(next, 'frontend', 'nuxt')).toBe("Nuxt doesn't support tRPC")
  })

  it('explains backend=self needs runtime=none', () => {
    const next: BtsConfig = { backend: 'self', frontend: ['next'], runtime: 'bun' }
    expect(optionDisabledReason(next, 'backend', 'self')).toBe(
      'Fullstack backend requires runtime none',
    )
  })

  it('explains runtime can\'t be set when backend is self', () => {
    const next: BtsConfig = { backend: 'self', frontend: ['next'], runtime: 'bun' }
    expect(optionDisabledReason(next, 'runtime', 'bun')).toBe(
      'Fullstack backend requires runtime none',
    )
  })

  it('explains nx and turborepo can\'t be used together when clicking nx', () => {
    const next: BtsConfig = { addons: ['turborepo', 'nx'] }
    expect(optionDisabledReason(next, 'addons', 'nx')).toBe(
      "Nx and Turborepo can't be used together",
    )
  })

  it('explains D1 needs Workers + Cloudflare deploy', () => {
    const next: BtsConfig = {
      dbSetup: 'd1',
      database: 'sqlite',
      orm: 'drizzle',
      backend: 'hono',
      runtime: 'bun',
    }
    expect(optionDisabledReason(next, 'dbSetup', 'd1')).toBe(
      'Cloudflare D1 requires Workers + Cloudflare deploy, or fullstack + Cloudflare web deploy',
    )
  })
})

describe('diffConfig', () => {
  it('lists only changed fields', () => {
    const before: BtsConfig = { backend: 'hono', database: 'sqlite', orm: 'drizzle' }
    const after: BtsConfig = { backend: 'convex', database: 'none', orm: 'none' }
    const changes = diffConfig(before, after)
    expect(changes.map((c) => c.field).sort()).toEqual(['backend', 'database', 'orm'])
  })

  it('treats identical arrays as equal', () => {
    const before: BtsConfig = { frontend: ['tanstack-router'] }
    const after: BtsConfig = { frontend: ['tanstack-router'] }
    expect(diffConfig(before, after)).toHaveLength(0)
  })
})
