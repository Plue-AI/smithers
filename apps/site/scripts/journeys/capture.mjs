#!/usr/bin/env node
/**
 * Re-captures every tutorial image under public/images/learn/ in one command.
 *
 *   node scripts/journeys/capture.mjs            # app, tui
 *   node scripts/journeys/capture.mjs app        # only the app GIFs
 *   node scripts/journeys/capture.mjs tui        # only the TUI GIFs
 *   node scripts/journeys/capture.mjs previews <dir>
 *
 * app: the real app server and built SPA (build first with
 * `pnpm --filter smithers-app run build:web`), offline, with a scripted model
 * behind the chat boundary (app-host.mjs). Playwright records each journey;
 * ffmpeg turns the video into a GIF. A journey that returns a locator is a
 * still: that element is saved as a PNG instead.
 *
 * tui: the TUI docs recorder (apps/tui-docs/scripts/record.mjs) drives the
 * production TUI in a PTY with deterministic model replies; its GIFs are copied here.
 *
 * previews: copies design previews rendered from fixture data by the app's
 * ui-surfaces probe (`UI_EVIDENCE_DIR=<dir> bun test e2e/probes/ui-surfaces.test.ts`).
 * They illustrate Planned or Partly available screens only.
 *
 * Needs Node, Bun >= 1.4, ffmpeg, and apps/app's Playwright Chromium. The TUI
 * recorder also needs Python 3, Chrome, and SMITHERS_WORKSPACE_JJ_EXPORT_BINARY.
 * Every capture is recorded in public/images/learn/captures.json.
 */
import { spawn, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { appJourneys, previews, tuiRecordings } from "./journeys.mjs"

const here = fileURLToPath(new URL(".", import.meta.url))
const site = resolve(here, "../..")
const root = resolve(site, "../..")
const out = join(site, "public/images/learn")
const ledgerPath = join(out, "captures.json")
const SIZE = { width: 1280, height: 800 }
mkdirSync(out, { recursive: true })

const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : {}
const revision = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim()
const today = new Date().toISOString().slice(0, 10)
const note = (file, source, detail) => {
  ledger[file] = { source, detail, revision, captured: today }
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`)
}

/** WebM → small looping GIF (two-pass palette). */
const encode = (video, name) => {
  const gif = join(out, `${name}.gif`)
  const filter = "mpdecimate,fps=8,scale=800:-1:flags=lanczos"
  const palette = "split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle"
  run("ffmpeg", ["-v", "error", "-y", "-i", video, "-vf", `${filter},${palette}`, "-loop", "0", gif])
  return gif
}

async function captureApp() {
  const distDir = join(root, "apps/app/dist")
  if (!existsSync(join(distDir, "index.html"))) throw new Error("Build the app first: pnpm --filter smithers-app run build:web")
  const uiRequire = createRequire(join(root, "apps/app/package.json"))
  const { chromium } = uiRequire("playwright")
  const replies = join(out, ".replies.json")
  writeFileSync(replies, JSON.stringify(appJourneys.flatMap((journey) => journey.replies ?? [])))
  const host = spawn("bun", [join(here, "app-host.mjs"), replies], { stdio: ["ignore", "pipe", "inherit"] })
  const origin = await new Promise((resolveOrigin, reject) => {
    let buffer = ""
    host.stdout.on("data", (chunk) => {
      buffer += chunk
      const ready = /ready (\S+)/.exec(buffer)
      if (ready) resolveOrigin(ready[1])
    })
    host.on("exit", (code) => reject(new Error(`app host exited ${code}`)))
  })
  const browser = await chromium.launch()
  try {
    for (const journey of appJourneys) {
      const videoDir = join(out, `.video-${journey.id}`)
      rmSync(videoDir, { recursive: true, force: true })
      const context = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, colorScheme: "light", recordVideo: { dir: videoDir, size: SIZE } })
      const page = await context.newPage()
      await page.goto(origin + "/")
      const still = await journey.steps(page)
      if (still) await still.screenshot({ path: join(out, `${journey.id}.png`) })
      await context.close()
      const [video] = readdirSync(videoDir).filter((file) => file.endsWith(".webm"))
      if (still) note(`${journey.id}.png`, "app", journey.detail)
      else {
        encode(join(videoDir, video), journey.id)
        note(`${journey.id}.gif`, "app", journey.detail)
      }
      rmSync(videoDir, { recursive: true, force: true })
      console.log(`captured ${journey.id}`)
    }
  } finally {
    await browser.close()
    host.kill("SIGTERM")
    rmSync(replies, { force: true })
  }
}

function captureTui() {
  const docs = join(root, "apps/tui-docs")
  run("node", ["scripts/record.mjs", "--only", tuiRecordings.map((entry) => entry.id).join(",")], { cwd: docs })
  for (const entry of tuiRecordings) {
    copyFileSync(join(docs, "public/recordings", `${entry.id}.gif`), join(out, `tui-${entry.id}.gif`))
    note(`tui-${entry.id}.gif`, "tui", entry.detail)
    console.log(`copied tui-${entry.id}`)
  }
}

function copyPreviews(dir) {
  if (!dir || !existsSync(dir)) throw new Error("Pass the ui-surfaces probe output directory")
  for (const entry of previews) {
    copyFileSync(join(dir, entry.file), join(out, `preview-${entry.id}.png`))
    note(`preview-${entry.id}.png`, "preview", entry.detail)
    console.log(`copied preview-${entry.id}`)
  }
}

const [mode, arg] = process.argv.slice(2)
if (mode === undefined || mode === "app") await captureApp()
if (mode === undefined || mode === "tui") captureTui()
if (mode === "previews") copyPreviews(arg)
writeFileSync(ledgerPath, JSON.stringify(Object.fromEntries(Object.entries(ledger).sort()), null, 2) + "\n")
