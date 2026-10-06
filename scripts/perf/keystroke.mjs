import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { publicOrigin, readHost } from './lib/host.mjs'
import { summarize } from './lib/stats.mjs'
import { writeRun } from './lib/artifact.mjs'

// Literal C-PERF-03 workload; never derived from runtime policy or spec text.
export const markers = Array.from({ length: 200 }, (_, i) => `K${String(i).padStart(5, '0')}`)
export function verifyTexts(a, c, disk) {
  if (a !== c || a !== disk) throw new Error('member documents and machine bytes differ')
  let previous = -1
  for (const marker of markers) {
    const position = a.indexOf(marker)
    if (position <= previous || a.indexOf(marker, position + marker.length) !== -1) throw new Error(`missing, reordered or duplicate ${marker}`)
    previous = position
  }
}

export function configuration(env) {
  const origin = publicOrigin(env.SMITHERS_PERF_ORIGIN)
  const page = new URL(env.SMITHERS_PERF_PAGE, origin)
  if (!env.SMITHERS_PERF_PAGE || page.origin !== origin) throw new Error('same-origin repository page required')
  const argv = JSON.parse(env.SMITHERS_PERF_READ_ARGV || 'null')
  if (!Array.isArray(argv) || !argv.length || argv.some(v => typeof v !== 'string' || !v || v.includes('\0'))) throw new Error('machine read argv required')
  for (const key of ['SMITHERS_PERF_MEMBER_A', 'SMITHERS_PERF_MEMBER_C', 'SMITHERS_PERF_TOKEN', 'SMITHERS_PERF_INSTALL_VERSION']) {
    if (!env[key]) throw new Error(`${key} required`)
  }
  if (env.SMITHERS_PERF_MEMBER_A === env.SMITHERS_PERF_MEMBER_C) throw new Error('distinct member storage states required')
  return { origin, page: page.href, argv }
}

async function fullText(page) {
  // Clipboard reads the complete CodeMirror selection, including virtual lines.
  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+Home')
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Meta+c')
  return page.evaluate(() => navigator.clipboard.readText())
}

export async function run(env = process.env) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const result = { timestamp, check: 'C-PERF-03', status: 'failed', samples: [], clock: 'second Mac: performance.timeOrigin + performance.now()' }
  let browser
  try {
    const config = configuration(env)
    result.origin = config.origin
    result.host = await readHost(config.origin, env.SMITHERS_PERF_TOKEN)
    result.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    result.installVersion = env.SMITHERS_PERF_INSTALL_VERSION
    const require = createRequire(resolve('apps/app/package.json'))
    const { chromium } = require('@playwright/test')
    browser = await chromium.launch()
    result.browser = browser.version()
    const contexts = await Promise.all([env.SMITHERS_PERF_MEMBER_A, env.SMITHERS_PERF_MEMBER_C].map(storageState => browser.newContext({ storageState, permissions: ['clipboard-read', 'clipboard-write'] })))
    const [a, c] = await Promise.all(contexts.map(context => context.newPage()))
    for (const page of [a, c]) {
      await page.goto(config.page)
      await page.getByTestId('composer-input').fill('/file src/target.ts')
      await page.getByTestId('composer-input').press('Enter')
      await page.locator('.cm-content[contenteditable="true"]').waitFor({ timeout: 15000 })
    }
    const initialA = await fullText(a)
    if (initialA !== await fullText(c) || initialA.split('\n').length !== 400 || markers.some(marker => initialA.includes(marker))) throw new Error('matching clean 400-line fixture required')
    await a.locator('.cm-content').click()
    await a.keyboard.press('Meta+Home')
    for (const marker of markers) {
      await a.keyboard.press('Meta+ArrowLeft')
      const scrollTop = await a.locator('.cm-scroller').evaluate(el => el.scrollTop)
      await c.locator('.cm-scroller').evaluate((el, top) => { el.scrollTop = top }, scrollTop)
      await c.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await c.locator('.cm-content').evaluate((el, marker) => {
        window.__keystrokeArrival = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { observer.disconnect(); reject(new Error(`remote marker timeout: ${marker}`)) }, 5000)
          const observer = new MutationObserver(() => {
            if (!el.textContent.includes(marker)) return
            const time = performance.timeOrigin + performance.now()
            clearTimeout(timer); observer.disconnect(); resolve(time)
          })
          observer.observe(el, { subtree: true, childList: true, characterData: true })
        })
        // Attach immediately so a timeout during typing has no unhandled rejection.
        window.__keystrokeArrival.catch(() => {})
      }, marker)
      await a.locator('.cm-content').evaluate(el => {
        window.__keystrokeLast = undefined
        window.__keystrokeListener = () => { window.__keystrokeLast = performance.timeOrigin + performance.now() }
        el.addEventListener('keydown', window.__keystrokeListener)
      })
      await a.keyboard.type(marker)
      const t0 = await a.locator('.cm-content').evaluate(el => {
        el.removeEventListener('keydown', window.__keystrokeListener)
        return window.__keystrokeLast
      })
      const t1 = await c.evaluate(() => window.__keystrokeArrival)
      result.samples.push({ marker, t0, t1, arrival_ms: t1 - t0, clock: result.clock, failed: false })
      await a.keyboard.press('ArrowDown')
    }
    await a.waitForTimeout(2000)
    const textA = await fullText(a), textC = await fullText(c)
    const disk = execFileSync(config.argv[0], config.argv.slice(1), { encoding: 'utf8', timeout: 15000, maxBuffer: 4 << 20 })
    verifyTexts(textA, textC, disk)
    result.summary = summarize(result.samples, ['arrival_ms'], 200)
    if (result.summary.arrival_ms.p95 >= 1000) throw new Error('p95 is not below 1000 ms')
    result.status = 'passed'
  } catch (error) {
    result.error = error.message
  } finally {
    await browser?.close()
  }
  const directory = await writeRun(process.cwd(), result)
  await writeFile(join(directory, 'keystroke.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  const checkDirectory = resolve('.artifacts/checks/C-PERF-03', timestamp)
  await mkdir(checkDirectory, { recursive: true })
  for (const name of ['summary.json', 'keystroke.json']) await writeFile(join(checkDirectory, name), await readFile(join(directory, name)), { flag: 'wx' })
  console.log(`${result.status}: ${directory}${result.error ? ` (${result.error})` : ''}`)
  return result.status === 'passed' ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await run()
