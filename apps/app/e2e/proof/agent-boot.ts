// Boots one install for apps/app/e2e/proof/agent.spec.ts until apps/app/e2e/proof/fixtures.ts (lane proof-harness)
// lands; then the spec switches to fixtures.ts and this file is deleted. It runs j8-boot.ts, the proof boot already on
// main (the bundle named by PROOF_BUNDLE, the GitHub fake, real models with the keys from the 0600 file PROOF_KEYS),
// rather than a second launcher, and waits for its receipt.
import { spawn } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"

export interface Install {
  readonly setupURL: string
  readonly fakeURL: string
  readonly home: string
  readonly revision: string
  /** Typed into Model access by the owner, as a person would; never printed. */
  readonly keys: Readonly<Record<string, string>>
  readonly stop: () => Promise<void>
}

/** j8-boot.ts's receipt, relative to apps/app: Playwright runs from there. */
const RECEIPT = "test-results/proof/j8-run.json"

export async function bootInstall(timeoutMs = 4 * 60_000): Promise<Install> {
  rmSync(RECEIPT, { force: true })
  const child = spawn("bun", ["e2e/proof/j8-boot.ts"], { env: process.env, stdio: ["ignore", "inherit", "inherit"] })
  let exited: number | null | undefined
  const exit = new Promise<void>(resolve => child.once("exit", code => { exited = code; resolve() }))
  const stop = async () => {
    if (exited !== undefined) return
    child.kill("SIGTERM")
    const late = setTimeout(() => child.kill("SIGKILL"), 60_000)
    await exit
    clearTimeout(late)
  }
  const began = Date.now()
  for (;;) {
    try {
      const run = JSON.parse(readFileSync(RECEIPT, "utf8"))
      return { setupURL: run.setupURL, fakeURL: run.fakeURL, home: run.home, revision: run.revision, keys: run.keys, stop }
    } catch { /* not written yet */ }
    if (exited !== undefined) throw new Error(`j8-boot.ts exited ${exited} before its setup handoff`)
    if (Date.now() - began > timeoutMs) { await stop(); throw new Error("no setup handoff from j8-boot.ts") }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}
