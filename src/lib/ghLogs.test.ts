import { describe, test, expect } from 'vitest'
import { parseGhLogs, formatShortTime, parseAnnotationBody } from './ghLogs'

describe('parseGhLogs', () => {
  test('extracts step, timestamp and text from canonical line', () => {
    const raw = 'Lint\tRun pnpm lint\t2026-04-22T13:15:11.2185371Z starting lint'
    const [line] = parseGhLogs(raw)
    expect(line.step).toBe('Run pnpm lint')
    expect(line.timestamp).toBe('2026-04-22T13:15:11.2185371Z')
    expect(line.text).toBe('starting lint')
    expect(line.level).toBe('info')
  })

  test('normalizes UNKNOWN STEP into null step', () => {
    const raw = 'Lint\tUNKNOWN STEP\t2026-04-22T13:15:11.2185371Z Current runner version: 2.333.1'
    expect(parseGhLogs(raw)[0].step).toBeNull()
  })

  test('drops the UTF-8 BOM that gh emits on the first line of a job', () => {
    const raw = 'Lint\tUNKNOWN STEP\t\ufeff2026-04-22T13:15:11.2185371Z hello'
    const [line] = parseGhLogs(raw)
    expect(line.timestamp).toBe('2026-04-22T13:15:11.2185371Z')
    expect(line.text).toBe('hello')
  })

  test('extracts workflow command level (##[error], ##[warning], ##[group], ...)', () => {
    const raw = [
      'Lint\tLint\t2026-04-22T13:15:11.2185371Z ##[group]Run pnpm lint',
      'Lint\tLint\t2026-04-22T13:15:11.2185371Z ##[error]ESLint found 3 errors',
      'Lint\tLint\t2026-04-22T13:15:11.2185371Z ##[warning]Deprecated option',
      'Lint\tLint\t2026-04-22T13:15:11.2185371Z ##[endgroup]',
    ].join('\n')
    const lines = parseGhLogs(raw)
    expect(lines.map(l => l.level)).toEqual(['group', 'error', 'warning', 'endgroup'])
    expect(lines[0].text).toBe('Run pnpm lint')
    expect(lines[1].text).toBe('ESLint found 3 errors')
  })

  test('strips ANSI color escapes', () => {
    const raw = 'Lint\tLint\t2026-04-22T13:15:11.2185371Z \x1b[31merror\x1b[0m: missing semicolon'
    expect(parseGhLogs(raw)[0].text).toBe('error: missing semicolon')
  })

  test('handles lines without timestamp (e.g. ghclean separators)', () => {
    const lines = parseGhLogs('no-prefix plain line')
    expect(lines[0].step).toBeNull()
    expect(lines[0].timestamp).toBeNull()
    expect(lines[0].text).toBe('no-prefix plain line')
  })

  test('skips blank lines', () => {
    const raw = '\nLint\tLint\t2026-04-22T13:15:11Z a\n\nLint\tLint\t2026-04-22T13:15:12Z b\n'
    expect(parseGhLogs(raw).length).toBe(2)
  })
})

describe('formatShortTime', () => {
  test('extracts HH:MM:SS', () => {
    expect(formatShortTime('2026-04-22T13:15:11.2185371Z')).toBe('13:15:11')
  })
})

describe('parseAnnotationBody', () => {
  test('returns the whole body as message when no fields are present', () => {
    const r = parseAnnotationBody('ESLint found 3 errors')
    expect(r.fields).toBeNull()
    expect(r.message).toBe('ESLint found 3 errors')
  })

  test('parses file, line, col, title, then message after ::', () => {
    const r = parseAnnotationBody('file=src/foo.ts,line=17,col=3,title=TS2322::Type mismatch')
    expect(r.fields).toEqual({ file: 'src/foo.ts', line: 17, col: 3, title: 'TS2322' })
    expect(r.message).toBe('Type mismatch')
  })

  test('decodes gh escapes (%2C comma, %3A colon, %25 percent, %0A newline)', () => {
    const r = parseAnnotationBody('file=a,b.ts,title=foo%2Cbar::line1%0Aline2')
    expect(r.fields?.title).toBe('foo,bar')
    expect(r.message).toBe('line1\nline2')
  })

  test('ignores junk head that is not key=value pairs', () => {
    const r = parseAnnotationBody('not::key::value')
    expect(r.fields).toBeNull()
    expect(r.message).toBe('not::key::value')
  })

  test('accepts endLine, endColumn and accepts "column" alias', () => {
    const r = parseAnnotationBody('file=a.ts,line=1,column=2,endLine=3,endColumn=4::msg')
    expect(r.fields).toEqual({ file: 'a.ts', line: 1, col: 2, endLine: 3, endColumn: 4 })
    expect(r.message).toBe('msg')
  })
})

describe('parseGhLogs annotation', () => {
  test('attaches structured fields to error lines when the annotation carries them', () => {
    const raw = 'Build\tRun build\t2026-04-22T13:15:11Z ##[error]file=src/foo.ts,line=17,col=3,title=TS2322::Type mismatch'
    const [line] = parseGhLogs(raw)
    expect(line.level).toBe('error')
    expect(line.text).toBe('Type mismatch')
    expect(line.annotation).toEqual({ file: 'src/foo.ts', line: 17, col: 3, title: 'TS2322' })
  })

  test('leaves annotation undefined for plain ##[error] without fields', () => {
    const raw = 'Build\tRun build\t2026-04-22T13:15:11Z ##[error]boom'
    const [line] = parseGhLogs(raw)
    expect(line.level).toBe('error')
    expect(line.text).toBe('boom')
    expect(line.annotation).toBeUndefined()
  })

  test('upgrades plain rustc/cargo error lines from info to error', () => {
    const raw = [
      'Build\tBuild\t2026-04-22T13:15:11Z error[E0425]: cannot find function `kill` in crate `libc`',
      'Build\tBuild\t2026-04-22T13:15:11Z error: could not compile `verun` (lib) due to 1 previous error',
      'Build\tBuild\t2026-04-22T13:15:11Z    Compiling serde v1.0.228',
    ].join('\n')
    const lines = parseGhLogs(raw)
    expect(lines[0].level).toBe('error')
    expect(lines[1].level).toBe('error')
    expect(lines[2].level).toBe('info')
  })

  test('upgrades plain warning lines from info to warning', () => {
    const raw = 'Build\tBuild\t2026-04-22T13:15:11Z warning: unused import `foo`'
    const [line] = parseGhLogs(raw)
    expect(line.level).toBe('warning')
  })
})
