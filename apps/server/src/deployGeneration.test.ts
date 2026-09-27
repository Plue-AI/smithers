import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { classifyLocal, readActivationRecord } from "../scripts/deployGuard"
import { WORKER_IDENTITY } from "./workerIdentity"
import { readWranglerConfig } from "./wranglerConfig"

/*
 * Main deploys one generation: the shared edge. docs/shared-edge-cutover.md
 * records the activation, cutover/activation.json is the owner record the
 * deploy guard admits the one legacy-to-edge switch with, and there is one
 * wrangler config. 5d776f34b once landed the edge without that record and
 * every deploy after it refused (DEPLOY_GUARD_EDGE_BEFORE_CUTOVER).
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const deployed = readWranglerConfig()

describe("the deployed generation", () => {
  test("main's deploy config is the shared edge and the cutover doc records the activation", () => {
    expect(classifyLocal(deployed.main, WORKER_IDENTITY.entry)).toBe("edge")
    expect(read("../docs/shared-edge-cutover.md").split("\n")[0]).toContain("activated by direct switch")
    expect(existsSync(new URL("../wrangler.edge.jsonc", import.meta.url))).toBe(false)
  })

  test("the owner record admits exactly this entry and these retained identities", () => {
    const record = readActivationRecord()
    expect({ ...record.transition }).toEqual({ from: "legacy", to: "edge", entry: deployed.main as "src/edge.ts" })
    expect(record.importDisposition.retainedDurableObjects).toEqual(
      deployed.durable_objects.bindings.map(b => ({ binding: b.name, className: b.class_name })))
  })

  test("the only active upstream is the shared backend", () => {
    expect(Object.keys(WORKER_IDENTITY.vars)).toEqual(["SMITHERS_BACKEND_ORIGIN"])
    expect(read("../wrangler.jsonc")).not.toMatch(/IDENTITY_UPSTREAM_URL|BILLING_UPSTREAM_URL|SMITHERS_CHAT_URL/)
  })

  test("every hosted document selects the shared backend's session application target", () => {
    for (const layout of ["Base", "AppShell"]) {
      expect(read(`../../site/src/layouts/${layout}.astro`)).toContain("smithers-application-target")
    }
  })
})
