#!/usr/bin/env node
// Capture the council scenarios from the UI lab harness.
// usage: node .claude/skills/ui-council/shoot.mjs <outDir> [baseUrl]
// Requires a dev server: VITE_DEMO_MODE=true VITE_PORT=1527 pnpm exec vite
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [outDir, baseUrl = 'http://localhost:1527'] = process.argv.slice(2)
if (!outDir) { console.error('usage: shoot.mjs <outDir> [baseUrl]'); process.exit(1) }
mkdirSync(outDir, { recursive: true })

export const SCENARIOS = [
  { name: 'main-dark', query: 'theme=dark' },
  { name: 'board-dark', query: 'theme=dark', board: true },
  { name: 'main-light', query: 'theme=light' },
  { name: 'board-light', query: 'theme=light', board: true },
  { name: 'scale-main-dark', query: 'theme=dark&fixture=scale' },
  { name: 'scale-board-dark', query: 'theme=dark&fixture=scale', board: true },
]

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--hide-scrollbars'],
})
const errors = new Set()
for (const s of SCENARIOS) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  page.on('pageerror', e => errors.add(`${s.name}: ${e.message.slice(0, 160)}`))
  await page.goto(`${baseUrl}/uilab.html?${s.query}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  // Wait for seeded tasks and their PR/CI state, not a fixed guess.
  await page.waitForFunction(() => document.body.innerText.includes('Fix markdown rendering'), { timeout: 90000 })
  await new Promise(r => setTimeout(r, 2500))
  if (s.board) {
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Task board'))?.click())
    await page.waitForSelector('main[aria-label="Task board"]', { timeout: 10000 })
    await new Promise(r => setTimeout(r, 500))
  }
  await page.screenshot({ path: join(outDir, `${s.name}.png`) })
  await page.close()
}
await browser.close()
for (const e of errors) console.error('pageerror', e)
console.log(`captured ${SCENARIOS.length} scenarios -> ${outDir}`)
