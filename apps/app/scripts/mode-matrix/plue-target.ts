import { createServer } from "node:net"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ExecutionReceipt, ModeConfig } from "../../e2e/real/coverage/matrix"
import { appEntryPath } from "../../e2e/real/support/app-entry"
import { buildShaFromHtml } from "../../../server/scripts/canary/BuildStamp"

export interface PlueSession {
  readonly modeConfig: ModeConfig
  readonly close: () => Promise<void>
}

const port = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createServer()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (typeof address !== "object" || address === null) return reject(new Error("no loopback port"))
    server.close((error) => error ? reject(error) : resolvePort(address.port))
  })
})

const plueOrigin = (target: string): string => {
  const origin = new URL(target)
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("SMITHERS_MODE_MATRIX_PLUE_URL must be a credential-free HTTP(S) origin")
  }
  return origin.origin
}

const get = async (origin: string, path: string): Promise<Response> => {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${origin}${path} returned ${response.status}`)
  return response
}

/** The Worker serves bootstrap, not the Bun host's /api/health; its buildSha names the deployment. */
const observeDeployment = async (origin: string): Promise<string> => {
  const body = await (await get(origin, "/api/bootstrap")).json() as { readonly host?: unknown; readonly buildSha?: unknown }
  if (body.host !== "cloud" || typeof body.buildSha !== "string" || !/^[0-9a-f]{40,64}$/.test(body.buildSha)) {
    throw new Error(`${origin}/api/bootstrap did not identify a cloud host with an exact build`)
  }
  return body.buildSha
}

const observeDocument = async (origin: string, path: string): Promise<string> => {
  const html = await (await get(origin, path)).text()
  if (!html.includes('<div id="root"')) throw new Error(`${origin}${path} did not serve the app document`)
  return html
}

const writeReceipt = (outputDir: string, receipt: Omit<ExecutionReceipt, "observedAt">, tokenEnvironment: string): ModeConfig => {
  const path = join(outputDir, `${receipt.mode}.execution.json`)
  writeFileSync(path, `${JSON.stringify({ ...receipt, observedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
  return { mode: receipt.mode, origin: receipt.origin, endpoint: receipt.endpoint, auth: { kind: "application-token", environment: tokenEnvironment }, executionReceipt: path }
}

/** web-plue runs nothing from this checkout: the receipt records the deployed build and page the Worker served. */
export const startWebPlue = async (outputDir: string, target: string, tokenEnvironment: string, apiTarget: string): Promise<PlueSession> => {
  const origin = plueOrigin(target)
  const endpoint = plueOrigin(apiTarget)
  const buildSha = await observeDeployment(origin)
  if (await observeDeployment(endpoint) !== buildSha) throw new Error("web and API backend revisions differ")
  if (buildShaFromHtml(await observeDocument(origin, appEntryPath("production"))) !== buildSha) {
    throw new Error("web renderer and backend revisions differ")
  }
  return {
    modeConfig: writeReceipt(outputDir, {
      mode: "web-plue", revision: buildSha, origin, endpoint, ready: true, startedRoles: ["web"],
      freshLaunch: false, restarted: false, dataPreserved: false
    }, tokenEnvironment),
    close: async () => undefined
  }
}

/** local-plue serves this checkout's renderer and relays its API to the Plue target. */
export const startLocalPlue = async (appDir: string, revision: string, outputDir: string, target: string, tokenEnvironment: string): Promise<PlueSession> => {
  const origin = plueOrigin(target)
  const webPort = await port()
  const localOrigin = `http://127.0.0.1:${webPort}`
  const vite = Bun.spawn([Bun.which("node") ?? "node", join(appDir, "node_modules", "vite", "bin", "vite.js"), "--configLoader", "runner", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    cwd: resolve(appDir), env: { ...process.env, SMITHERS_DEV_BACKEND_ORIGIN: origin },
    stdin: "ignore", stdout: "inherit", stderr: "inherit"
  })
  try {
    const deadline = Date.now() + 120_000
    let lastFailure: unknown
    for (;;) {
      if (vite.exitCode !== null) throw new Error(`local Plue Vite process exited ${vite.exitCode}`)
      try {
        await observeDocument(localOrigin, "/")
        await observeDeployment(localOrigin)
        break
      } catch (error) { lastFailure = error }
      if (Date.now() >= deadline) {
        throw new Error(`local Plue Vite process did not become ready: ${lastFailure instanceof Error ? lastFailure.message : String(lastFailure)}`)
      }
      await Bun.sleep(250)
    }
    return {
      modeConfig: writeReceipt(outputDir, {
        mode: "local-plue", revision, origin: localOrigin, endpoint: origin, ready: true, startedRoles: ["local-ui"],
        freshLaunch: false, restarted: false, dataPreserved: false
      }, tokenEnvironment),
      close: async () => { if (vite.exitCode === null) vite.kill("SIGTERM"); await vite.exited }
    }
  } catch (error) {
    if (vite.exitCode === null) vite.kill("SIGTERM")
    await vite.exited
    throw error
  }
}
