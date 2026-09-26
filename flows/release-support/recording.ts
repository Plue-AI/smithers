import { randomUUID } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { relative } from "node:path"
import { chromium } from "playwright"
import { digest } from "./content.ts"
import { atomicWrite, inside } from "./io.ts"
import type { Evidence, Recording } from "./schema.ts"

/** Record an explicitly supplied local product scenario in an isolated browser. */
export const recordUi = async (
  root: string,
  recording: typeof Recording.Type,
  evidence: Evidence,
  signal?: AbortSignal
): Promise<Evidence> => {
  const url = new URL(recording.url)
  if (
    !/^https?:$/.test(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username ||
    url.password
  ) throw new Error("UI recording requires a local URL without credentials")
  const directory = `.flows/releases/recordings/${evidence.version}/${randomUUID()}`
  const output = await inside(root, directory)
  await mkdir(output, { recursive: true })
  const browser = await chromium.launch()
  const stop = () => {
    void browser.close()
  }
  signal?.addEventListener("abort", stop, { once: true })
  const assets: Array<Evidence["recordings"][number]> = []
  const capture = async (name: string, bytes: Buffer) => {
    const path = `${directory}/${name}`
    await atomicWrite(root, path, bytes)
    assets.push({ path, digest: digest(bytes) })
  }
  try {
    signal?.throwIfAborted()
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: "dark",
      recordVideo: { dir: output, size: { width: 1280, height: 800 } }
    })
    const page = await context.newPage()
    const errors: Array<string> = []
    page.on("pageerror", (error) => errors.push(error.message))
    // A recording is local-only, including redirects and page resources.
    await context.route("**/*", async (route) => {
      const target = new URL(route.request().url())
      if (["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) await route.continue()
      else await route.abort("blockedbyclient")
    })
    const response = await page.goto(recording.url, { waitUntil: "networkidle", timeout: 30_000 })
    if (!response?.ok()) throw new Error(`UI recording page returned HTTP ${response?.status()}`)
    await page.locator(recording.readySelector).waitFor({ state: "visible", timeout: 30_000 })
    await capture("start.png", await page.screenshot())
    if (!recording.steps.length) await capture("middle.png", await page.screenshot())
    for (const [index, step] of recording.steps.entries()) {
      signal?.throwIfAborted()
      const target = page.locator(step.selector)
      if (step.kind === "click") await target.click({ timeout: 30_000 })
      else if (step.kind === "fill") await target.fill(step.value, { timeout: 30_000 })
      else await target.filter({ hasText: step.value }).waitFor({ state: "visible", timeout: 30_000 })
      if (index === Math.floor(recording.steps.length / 2)) await capture("middle.png", await page.screenshot())
    }
    if (errors.length) throw new Error(`UI recording had page errors: ${errors.join("; ")}`)
    await capture("end.png", await page.screenshot())
    const video = page.video()
    await context.close()
    if (!video) throw new Error("UI recording produced no video")
    const videoPath = await video.path()
    const bytes = await readFile(videoPath)
    if (bytes.length < 1000) throw new Error("UI recording produced an empty video")
    assets.push({ path: relative(root, videoPath).split("\\").join("/"), digest: digest(bytes) })
    return {
      ...evidence,
      recordings: assets,
      documents:
        `${evidence.documents}\nRecording: ${recording.url}; ${recording.steps.length} scenario steps completed. Assets require human visual review; do not infer unseen behavior from filenames.`,
      sources: [...evidence.sources, ...assets.map((asset) => asset.path)]
    }
  } finally {
    signal?.removeEventListener("abort", stop)
    await browser.close()
  }
}
