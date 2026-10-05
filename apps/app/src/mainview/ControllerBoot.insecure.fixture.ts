/*
 * The real boot on a plain-HTTP LAN origin, run in its own process (ControllerBoot.insecure.test.ts) because it
 * replaces the process's `crypto`. A teammate's browser at http://<mac>.local:4000 is not a secure context: it has
 * crypto.getRandomValues and no crypto.randomUUID, crypto.subtle, Web Locks, StorageManager, clipboard or service
 * worker (spec §16.3.2). Only the network is faked.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { ENVELOPE_STORAGE_KEY } from "./chain/TransactionalStorage"
import { installFixture } from "./state/seams/InstallFixtures.test-support"

GlobalRegistrator.register({ url: "http://williams-mac-mini.local:4000/" })
const secure = globalThis.crypto
const insecure = { getRandomValues: <T extends ArrayBufferView | null>(array: T): T => secure.getRandomValues(array) }
for (const scope of new Set<object>([globalThis, window])) Object.defineProperty(scope, "crypto", { configurable: true, value: insecure })
for (const api of ["locks", "storage", "clipboard", "serviceWorker"]) Object.defineProperty(navigator, api, { configurable: true, value: undefined })
if ("randomUUID" in crypto || "subtle" in crypto || navigator.locks !== undefined) throw new Error("the fixture still exposes a secure-context API")

const install = installFixture()
const pending = new Set(["repository", "models", "source", "machine"])
const served = { ...install, github: { ...install.github, signed_in: false }, repository: undefined,
  steps: install.steps.map(step => pending.has(step.id) ? { id: step.id, state: "pending" as const } : step) }
const bootstrap = { apiVersion: 1, host: "local", version: "test", buildSha: "0".repeat(40), authFlow: "redirect", sandbox: null,
  capabilities: ["identity", "install"] }
const reads: string[] = []
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  reads.push(url.pathname)
  if (url.pathname === "/api/bootstrap") return Response.json(bootstrap)
  if (url.pathname === "/api/install") return Response.json(served)
  if (url.pathname === "/api/user") return Response.json({ code: "unauthenticated", class: "permission", message: "Sign in" }, { status: 401 })
  return Response.json({ code: "not_found", class: "user", message: "Not found" }, { status: 404 })
}) as typeof fetch

const { runControllerBoot } = await import("./ControllerBoot.client")
const controller = await runControllerBoot()
for (let tick = 0; tick < 200 && controller.installSnapshots.get().model === undefined; tick++) await new Promise(done => setTimeout(done, 5))
const model = controller.installSnapshots.get().model
if (model === undefined) throw new Error(`no install model after boot; reads: ${reads.join(" ")}`)
if (!model.steps.some(step => step.state !== "done")) throw new Error("the install read lost its pending steps")
if (!reads.includes("/api/install")) throw new Error("boot never read the install")
if (localStorage.getItem(ENVELOPE_STORAGE_KEY) !== null) throw new Error("a page without Web Locks wrote the saved store")
console.log(`insecure boot reached Setup: ${model.steps.filter(step => step.state !== "done").map(step => step.id).join(",")}`)
process.exit(0)
