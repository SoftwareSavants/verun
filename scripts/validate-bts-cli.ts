#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BACKEND_VALUES,
  RUNTIME_VALUES,
  FRONTEND_VALUES,
  DATABASE_VALUES,
  ORM_VALUES,
  AUTH_VALUES,
  API_VALUES,
  DATABASE_SETUP_VALUES,
  WEB_DEPLOY_VALUES,
  SERVER_DEPLOY_VALUES,
} from '@better-t-stack/types'
import {
  validateCompatibility,
  isNativeFrontend,
  type BtsConfig,
} from '../src/lib/btsStack'

const BASELINE: BtsConfig = {
  frontend: ['tanstack-router'],
  backend: 'hono',
  runtime: 'bun',
  api: 'trpc',
  database: 'sqlite',
  orm: 'drizzle',
  auth: 'better-auth',
  packageManager: 'bun',
  addons: ['turborepo'],
  examples: [],
  payments: 'none',
  webDeploy: 'none',
  serverDeploy: 'none',
  dbSetup: 'none',
}

interface Case {
  label: string
  config: BtsConfig
}

function pivot(field: keyof BtsConfig, value: string): BtsConfig {
  if (field === 'frontend') {
    const isNative = isNativeFrontend(value)
    const kept = (BASELINE.frontend ?? []).filter((v) =>
      isNative ? !isNativeFrontend(v) : isNativeFrontend(v),
    )
    return {
      ...BASELINE,
      frontend: value === 'none' ? (kept.length ? kept : []) : [...kept, value],
    }
  }
  if (field === 'addons' || field === 'examples') {
    return { ...BASELINE, [field]: value === 'none' ? [] : [value] } as BtsConfig
  }
  return { ...BASELINE, [field]: value } as BtsConfig
}

function buildCases(): Case[] {
  const cases: Case[] = []
  cases.push({ label: 'baseline', config: BASELINE })

  const matrix: Array<[keyof BtsConfig, readonly string[]]> = [
    ['backend', BACKEND_VALUES],
    ['runtime', RUNTIME_VALUES],
    ['frontend', FRONTEND_VALUES],
    ['database', DATABASE_VALUES],
    ['orm', ORM_VALUES],
    ['auth', AUTH_VALUES],
    ['api', API_VALUES],
    ['dbSetup', DATABASE_SETUP_VALUES],
    ['serverDeploy', SERVER_DEPLOY_VALUES],
    ['webDeploy', WEB_DEPLOY_VALUES],
  ]
  for (const [field, values] of matrix) {
    for (const v of values) {
      cases.push({ label: `${field}=${v}`, config: pivot(field, v) })
    }
  }

  // Targeted edge cases
  cases.push({ label: 'edge:mongo+drizzle', config: { ...BASELINE, database: 'mongodb', orm: 'drizzle' } })
  cases.push({ label: 'edge:mongo+mongoose', config: { ...BASELINE, database: 'mongodb', orm: 'mongoose' } })
  cases.push({ label: 'edge:postgres+mongoose', config: { ...BASELINE, database: 'postgres', orm: 'mongoose' } })
  cases.push({ label: 'edge:none-orm+postgres', config: { ...BASELINE, database: 'postgres', orm: 'none' } })
  cases.push({ label: 'edge:postgres+none-db', config: { ...BASELINE, database: 'none', orm: 'drizzle' } })
  cases.push({ label: 'edge:convex+postgres', config: { ...BASELINE, backend: 'convex', database: 'postgres', orm: 'drizzle' } })
  cases.push({ label: 'edge:convex+solid', config: { ...BASELINE, backend: 'convex', frontend: ['solid'], database: 'none', orm: 'none', api: 'none' } })
  cases.push({ label: 'edge:convex+astro', config: { ...BASELINE, backend: 'convex', frontend: ['astro'], database: 'none', orm: 'none', api: 'none' } })
  cases.push({ label: 'edge:none-backend+postgres', config: { ...BASELINE, backend: 'none', database: 'postgres' } })
  cases.push({ label: 'edge:none-backend+auth', config: { ...BASELINE, backend: 'none', auth: 'better-auth' } })
  cases.push({ label: 'edge:turso+postgres', config: { ...BASELINE, dbSetup: 'turso', database: 'postgres' } })
  cases.push({ label: 'edge:turso+sqlite', config: { ...BASELINE, dbSetup: 'turso', database: 'sqlite' } })
  cases.push({ label: 'edge:neon+sqlite', config: { ...BASELINE, dbSetup: 'neon', database: 'sqlite' } })
  cases.push({ label: 'edge:neon+postgres', config: { ...BASELINE, dbSetup: 'neon', database: 'postgres' } })
  cases.push({ label: 'edge:supabase+postgres', config: { ...BASELINE, dbSetup: 'supabase', database: 'postgres' } })
  cases.push({ label: 'edge:planetscale+sqlite', config: { ...BASELINE, dbSetup: 'planetscale', database: 'sqlite' } })
  cases.push({ label: 'edge:mongodb-atlas+postgres', config: { ...BASELINE, dbSetup: 'mongodb-atlas', database: 'postgres' } })
  cases.push({ label: 'edge:d1+postgres', config: { ...BASELINE, dbSetup: 'd1', database: 'postgres' } })
  cases.push({ label: 'edge:docker+sqlite', config: { ...BASELINE, dbSetup: 'docker', database: 'sqlite' } })
  cases.push({ label: 'edge:docker+postgres', config: { ...BASELINE, dbSetup: 'docker', database: 'postgres' } })
  cases.push({ label: 'edge:clerk+astro', config: { ...BASELINE, auth: 'clerk', frontend: ['astro'] } })
  cases.push({ label: 'edge:clerk+nuxt', config: { ...BASELINE, auth: 'clerk', frontend: ['nuxt'] } })
  cases.push({ label: 'edge:clerk+next', config: { ...BASELINE, auth: 'clerk', frontend: ['next'] } })
  cases.push({ label: 'edge:workers+no-deploy', config: { ...BASELINE, runtime: 'workers', serverDeploy: 'none' } })
  cases.push({ label: 'edge:workers+cloudflare', config: { ...BASELINE, runtime: 'workers', serverDeploy: 'cloudflare' } })
  cases.push({ label: 'edge:cloudflare+node', config: { ...BASELINE, runtime: 'node', serverDeploy: 'cloudflare' } })
  cases.push({ label: 'edge:self+solid', config: { ...BASELINE, backend: 'self', frontend: ['solid'] } })
  cases.push({ label: 'edge:self+next', config: { ...BASELINE, backend: 'self', frontend: ['next'] } })
  cases.push({ label: 'edge:self+nuxt', config: { ...BASELINE, backend: 'self', frontend: ['nuxt'] } })
  cases.push({ label: 'edge:self+astro', config: { ...BASELINE, backend: 'self', frontend: ['astro'] } })
  cases.push({ label: 'edge:self+tanstack-start', config: { ...BASELINE, backend: 'self', frontend: ['tanstack-start'] } })

  return cases
}

interface Result {
  label: string
  oursValid: boolean
  cliValid: boolean
  cliError: string
  cliExitCode: number | null
}

const CLI_ERROR_RE = /CLIError:\s+([^\n]+)/

function parseCliResult(output: string): { ok: boolean; error: string } {
  if (output.includes('"reproducibleCommand"')) return { ok: true, error: '' }
  const m = output.match(CLI_ERROR_RE)
  if (m) return { ok: false, error: m[1].trim() }
  return { ok: false, error: 'unknown CLI output (no reproducibleCommand, no CLIError)' }
}

async function runCli(
  cfg: BtsConfig,
  name: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; error: string; code: number | null }> {
  return new Promise((resolve) => {
    const payload = { ...cfg, projectName: name, install: false, git: false, dryRun: true }
    const proc = spawn('bunx', ['create-better-t-stack@latest', 'create-json', '--input', JSON.stringify(payload)], {
      cwd,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let combined = ''
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    proc.stdout?.on('data', (d) => { combined += d.toString() })
    proc.stderr?.on('data', (d) => { combined += d.toString() })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      const { ok, error } = parseCliResult(combined)
      resolve({ ok, error, code })
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: String(err), code: null })
    })
  })
}

async function main() {
  const limit = parseInt(process.env.LIMIT ?? '0', 10)
  const concurrency = parseInt(process.env.CONCURRENCY ?? '4', 10)
  const timeoutMs = parseInt(process.env.TIMEOUT ?? '90000', 10)
  let cases = buildCases()
  if (limit > 0) cases = cases.slice(0, limit)

  const tmp = mkdtempSync(join(tmpdir(), 'bts-validate-'))
  console.log(`Working dir: ${tmp}`)
  console.log(`Running ${cases.length} cases (concurrency=${concurrency}, timeout=${timeoutMs}ms)...`)
  console.log('')

  const results: Result[] = []
  let i = 0
  let done = 0

  async function worker() {
    while (i < cases.length) {
      const idx = i++
      const c = cases[idx]
      const ours = validateCompatibility(c.config)
      const projectName = `t${idx}`
      const projDir = join(tmp, `case-${idx}`)
      mkdirSync(projDir, { recursive: true })
      const cli = await runCli(c.config, projectName, projDir, timeoutMs)
      done++
      const r: Result = {
        label: c.label,
        oursValid: ours.valid,
        cliValid: cli.ok,
        cliError: cli.error,
        cliExitCode: cli.code,
      }
      results.push(r)
      const tick = ours.valid === cli.ok ? '.' : 'X'
      const o = ours.valid ? 'ok' : 'no'
      const v = cli.ok ? 'ok' : 'no'
      process.stdout.write(`[${String(done).padStart(3)}/${cases.length}] ${tick} ours=${o} cli=${v}  ${c.label}\n`)
      try { rmSync(projDir, { recursive: true, force: true }) } catch {}
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  const mismatches = results.filter((r) => r.oursValid !== r.cliValid)
  console.log('')
  console.log('--- SUMMARY ---')
  console.log(`Total: ${results.length} | Mismatches: ${mismatches.length}`)
  if (mismatches.length > 0) {
    console.log('')
    console.log('--- MISMATCHES ---')
    for (const m of mismatches) {
      const reason = m.cliError ? ` :: ${m.cliError}` : ''
      const ourErrs = validateCompatibility(buildCases().find((c) => c.label === m.label)!.config).errors
      const ourErr = ourErrs[0] ? ` :: our reason: ${ourErrs[0]}` : ''
      console.log(`  ${m.label}: ours=${m.oursValid} cli=${m.cliValid}${reason}${ourErr}`)
    }
  }

  rmSync(tmp, { recursive: true, force: true })
  process.exit(mismatches.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
