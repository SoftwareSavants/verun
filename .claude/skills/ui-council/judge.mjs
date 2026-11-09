#!/usr/bin/env node
// Blind pairwise council: Claude + Codex compare two screenshot sets.
// usage: node .claude/skills/ui-council/judge.mjs <baselineDir> <candidateDir|-> <outDir> [rubricFile]
// Pass "-" as candidateDir for critique mode: judges score and critique the baseline alone.
//
// Each judge sees the sets as "A" and "B" in an order randomized per judge, with
// neutral filenames, so neither the order nor the paths leak which is newer.
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [baseDir, candDir, outDir, rubricArg] = process.argv.slice(2)
if (!baseDir || !candDir || !outDir) {
  console.error('usage: judge.mjs <baselineDir> <candidateDir> <outDir> [rubricFile]')
  process.exit(1)
}
const rubric = readFileSync(rubricArg ?? join(here, 'rubric.md'), 'utf8')
const scenarios = readdirSync(baseDir).filter(f => f.endsWith('.png')).sort()
if (scenarios.length === 0) { console.error(`no screenshots in ${baseDir}`); process.exit(1) }
if (candDir !== '-') {
  const cand = readdirSync(candDir).filter(f => f.endsWith('.png')).sort()
  if (cand.join() !== scenarios.join()) { console.error(`scenario mismatch: ${scenarios} vs ${cand}`); process.exit(1) }
}
mkdirSync(outDir, { recursive: true })

const JUDGES = [
  {
    name: 'claude',
    run: (dir, prompt) => exec('claude', ['-p', prompt, '--model', 'opus', '--allowedTools', 'Read', '--output-format', 'text'], dir),
  },
  {
    name: 'codex',
    run: (dir, prompt, images) => exec('codex', ['exec', '-s', 'read-only', '--skip-git-repo-check', '-C', dir,
      ...images.flatMap(i => ['-i', join(dir, i)]), '-'], dir, prompt),
  },
]

function exec(cmd, args, cwd, stdin) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    if (stdin) { p.stdin.write(stdin); p.stdin.end() }
    let out = '', err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('close', code => code === 0 ? res(out) : rej(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`)))
  })
}

function lastJson(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1])
  for (const c of [...fenced.reverse(), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try { return JSON.parse(c) } catch { /* try next */ }
  }
  throw new Error('no JSON verdict in judge output')
}

async function critique(j) {
  const dir = resolve(outDir, `${j.name}-input`)
  mkdirSync(dir, { recursive: true })
  const images = scenarios.map(s => { copyFileSync(join(baseDir, s), join(dir, s)); return s })
  const prompt = `${rubric}

The screenshots are in the current directory: ${images.join(', ')}. The file name is the scenario.
Look at every image (use your Read tool if you have one) before answering.
Reply with ONLY a JSON object in a \`\`\`json fence matching:
{"score": 1-10, "problems": [string, most severe first], "topFixes": [string, highest impact first]}`
  const raw = await j.run(dir, prompt, images)
  writeFileSync(join(outDir, `${j.name}-raw.txt`), raw)
  return { judge: j.name, ...lastJson(raw) }
}

async function judge(j) {
  const candIsA = Math.random() < 0.5
  const sets = candIsA ? { A: candDir, B: baseDir } : { A: baseDir, B: candDir }
  const dir = resolve(outDir, `${j.name}-input`)
  mkdirSync(dir, { recursive: true })
  const images = []
  for (const s of scenarios) for (const label of ['A', 'B']) {
    const name = `${label}-${s}`
    copyFileSync(join(sets[label], s), join(dir, name))
    images.push(name)
  }
  const prompt = `${rubric}

The screenshots are in the current directory: ${images.join(', ')}.
Files starting with "A-" are design A, "B-" are design B; the rest of the name is the scenario.
Look at every image (use your Read tool if you have one) before answering.
Reply with ONLY a JSON object in a \`\`\`json fence matching:
{"preferred": "A" | "B", "confidence": 1-5, "scoreA": 1-10, "scoreB": 1-10,
 "problemsA": [string], "problemsB": [string], "topFixesForPreferred": [string]}`
  const raw = await j.run(dir, prompt, images)
  writeFileSync(join(outDir, `${j.name}-raw.txt`), raw)
  const v = lastJson(raw)
  const unblind = l => (l === 'A') === candIsA ? 'candidate' : 'baseline'
  return {
    judge: j.name,
    preferred: unblind(v.preferred),
    confidence: v.confidence,
    candidateScore: candIsA ? v.scoreA : v.scoreB,
    baselineScore: candIsA ? v.scoreB : v.scoreA,
    candidateProblems: candIsA ? v.problemsA : v.problemsB,
    baselineProblems: candIsA ? v.problemsB : v.problemsA,
    topFixes: v.topFixesForPreferred,
  }
}

if (candDir === '-') {
  const results = await Promise.all(JUDGES.map(j => critique(j).catch(e => ({ judge: j.name, error: String(e.message) }))))
  writeFileSync(join(outDir, 'verdict.json'), JSON.stringify({ mode: 'critique', results }, null, 2))
  console.log(JSON.stringify({ mode: 'critique', results }, null, 2))
  process.exit(0)
}

const results = await Promise.all(JUDGES.map(j => judge(j).catch(e => ({ judge: j.name, error: String(e.message) }))))
const ok = results.filter(r => !r.error)
const summary = {
  results,
  allPreferCandidate: ok.length === JUDGES.length && ok.every(r => r.preferred === 'candidate'),
  minCandidateScore: ok.length ? Math.min(...ok.map(r => r.candidateScore)) : null,
}
summary.pass = summary.allPreferCandidate && summary.minCandidateScore >= 9
writeFileSync(join(outDir, 'verdict.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
