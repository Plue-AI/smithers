import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
const setup = ['fresh','app','sign_in','choosing_repository','squash_blocked','models_validating','models_failed','source_running','machine_failed','no_capacity','done']
const settings = ['ready','notifications_need_https','github_stale','github_limited','github_refused','degraded','obsidian','obsidian_error','no_capacity','parallel_s2','raised_daily_admissions','member_view']
const directory = `${homedir()}/design-lanes/shots/T-UI-02`
mkdirSync(directory, { recursive: true })
const browser = await chromium.launch()
const results = []
const response = await fetch('https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js')
if (!response.ok) throw new Error('Cannot load axe')
const axe = await response.text()
for (const [kind, ids] of [['setup',setup],['settings',settings]]) for (const id of ids) for (const theme of ['light','dark']) for (const width of [1280,390]) {
  const page = await browser.newPage({viewport: {width,height: width === 390 ? 844 : 800}, colorScheme: theme})
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:5182/cards/views/setup-stories.html?story=${kind}-${id}&theme=${theme}`)
  await page.locator('.setup-view').waitFor()
  await page.addScriptTag({content: axe})
  const violations = await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => ({id:v.id,nodes:v.nodes.map(n => n.target)})))
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  const path = `${directory}/${kind}-${id}-${theme}-${width}.png`
  await page.screenshot({path,fullPage:true})
  results.push({story:`${kind}-${id}`,theme,width,path,overflow,violations,errors})
  await page.close()
}
await browser.close()
writeFileSync(`${directory}/results.json`, JSON.stringify(results,null,2))
console.log(JSON.stringify({screenshots:results.length,failures:results.filter(r => r.overflow || r.violations.length || r.errors.length)},null,2))
