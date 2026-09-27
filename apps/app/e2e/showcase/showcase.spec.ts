/*
 * Registers every ./cases/*.case.ts as one test. Without SHOWCASE_RECORD the
 * case is a plain assertion test; with SHOWCASE_RECORD=<dir> the same walk is
 * paced for a viewer, recorded to <dir>/videos/<id>.webm, and described in
 * <dir>/cases/<id>.json for scripts/showcase.ts.
 */
import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadCases } from "./cases"
import { DEFAULT_VIEWPORT, prepare, type ShowcaseRecord } from "./showcase"

const RECORD = process.env.SHOWCASE_RECORD
const revision = (): string => {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() } catch { return "unknown" }
}

for (const definition of loadCases()) {
  test(`showcase:${definition.id}`, async ({ browser }, testInfo) => {
    const viewport = definition.viewport ?? DEFAULT_VIEWPORT
    const videos = RECORD === undefined ? undefined : join(RECORD, "videos", ".raw", definition.id)
    const context = await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      viewport,
      ...(process.env.SHOWCASE_SCALE === undefined ? {} : { deviceScaleFactor: Number(process.env.SHOWCASE_SCALE) }),
      ...(videos === undefined ? {} : { recordVideo: { dir: videos, size: viewport } })
    })
    // Every case starts from an empty profile.
    await context.addInitScript(() => {
      try { if (sessionStorage.getItem("showcase-cleared") === null) { localStorage.clear(); sessionStorage.setItem("showcase-cleared", "1") } } catch { /* no storage */ }
    })
    const page = await context.newPage()
    const errors: Array<string> = []
    page.on("pageerror", error => errors.push(error.message))
    const run = await prepare(page, RECORD !== undefined)
    try {
      await definition.run({ page, app: run.app, backend: run.backend })
      // The video drops the last second or two before the context closes.
      await run.app.beat(2500)
      const { doors, registered } = await run.collect()
      const observed = [...new Set(doors.map(door => door.flow))]
      expect(definition.flows.length, "a case names the flows it demonstrates").toBeGreaterThan(0)
      // The page may only claim what the walk actually invoked.
      expect(definition.flows.filter(flow => !observed.includes(flow)), "flows the case names but never invoked").toEqual([])
      expect(errors, "uncaught page errors").toEqual([])
      if (RECORD !== undefined) {
        const record: ShowcaseRecord = {
          id: definition.id,
          order: definition.order,
          title: definition.title,
          summary: definition.summary,
          flows: definition.flows,
          doors: [...new Set(doors.map(door => door.door).filter(door => door !== ""))],
          observed,
          registered,
          // Every case runs on the T1 test host: fixture routes and the stub chat model.
          fakeBackend: true,
          revision: revision(),
          // Past the shell's one-second entrance, which every case would otherwise open on.
          trimStart: Math.max(0, ((run.bootedAt() ?? 0) + 900) / 1000),
          recordedAt: new Date().toISOString()
        }
        const video = page.video()
        await context.close()
        mkdirSync(join(RECORD, "videos"), { recursive: true })
        mkdirSync(join(RECORD, "cases"), { recursive: true })
        await video?.saveAs(join(RECORD, "videos", `${definition.id}.webm`))
        writeFileSync(join(RECORD, "cases", `${definition.id}.json`), `${JSON.stringify(record, null, 2)}\n`)
      }
    } finally {
      await context.close()
    }
  })
}
