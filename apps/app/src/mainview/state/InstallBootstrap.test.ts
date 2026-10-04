import { expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage, settled } from "./TestFixtures"
import { installFixture } from "./seams/InstallFixtures.test-support"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
const controller = scopedControllers()
for (const host of ["local", "cloud"] as const) for (const install of [false, true]) {
  test(`${host} install=${install}: capability controls setup and seed`, async () => {
    const requests: string[] = []
    const bootstrap: AppBootstrap = { apiVersion: 1, host, version: "test", buildSha: "test", capabilities: install ? ["install"] : [], authFlow: "none", sandbox: null }
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const app = controller(store, { available: false, startTurn: async () => ({ status: "error", message: "offline" }), cancelTurn: async () => {}, subscribe: () => () => {} }, {
      bootstrap, fetchImpl: async input => { requests.push(String(input)); return String(input).endsWith("/api/install") ? Response.json(installFixture()) : new Response("", { status: 404 }) }
    })
    await settled()
    expect(requests.filter(path => path.endsWith("/api/install"))).toHaveLength(install ? 1 : 0)
    expect(app.design.world().todos.length).toBe(install ? 0 : 4)
    expect(app.design.world().repo.repo).toBe(install ? "" : "acme/api")
    // The first TODO flow asks the host who answers; it is acknowledged at once and the next one is routed.
    const answer = () => app.todoRoute(1, ["who-answers"], () => "seed" as const, () => "real" as const)
    await answer()
    await settled()
    expect(await answer()).toBe(install ? "real" : "seed")
  })
}
