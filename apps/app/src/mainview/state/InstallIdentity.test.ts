/*
 * On an install the owner is admitted part-way through Setup (GitHub sign-in, then the repository claim), after the
 * page read its identity at boot. The TODO, Draft and Members doors need that identity signed in without a reload.
 */
import { expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { InstallModel } from "./seams/InstallModel"
import { installFixture } from "./seams/InstallFixtures.test-support"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settle, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()
const bootstrap: AppBootstrap = { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null, capabilities: ["identity", "install"] }

test("an install reads the owner's identity again as Setup steps finish, until it answers signed in", async () => {
  let model: InstallModel = { ...installFixture(), steps: installFixture().steps.map(step => ({ id: step.id, state: ["address", "app_manifest", "sign_in"].includes(step.id) ? "done" : "pending" })) }
  let admitted = false, reads = 0
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { bootstrap,
    applicationIdentity: { current: async () => { reads++; return admitted ? { username: "smithersai", admin: false, scopes: null } : null } },
    fetchImpl: async input => String(input).endsWith("/api/install") ? Response.json(model) : new Response("", { status: 404 }) })
  const identity = () => store.collections.identitySessions.get("identity")
  await waitFor(() => reads === 1 && identity()?.state === "signed-out")
  // The repository claim admits the owner; the next served install names one more step done.
  admitted = true
  model = { ...model, steps: model.steps.map(step => step.id === "repository" ? { ...step, state: "done" } : step) }
  await controller.showSetup()
  await waitFor(() => identity()?.state === "signed-in")
  expect(identity()?.login).toBe("smithersai")
  expect(reads).toBe(2)
  // Signed in, a later step reads nothing more.
  model = { ...model, steps: model.steps.map(step => step.id === "models" ? { ...step, state: "done" } : step) }
  await controller.showSetup()
  await settle()
  expect(reads).toBe(2)
})

test("a host without the install capability never reads identity from Setup progress", async () => {
  let reads = 0
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  createAppController(store, silentAgent, { bootstrap: { ...bootstrap, capabilities: ["identity"] },
    applicationIdentity: { current: async () => { reads++; return null } },
    fetchImpl: async input => String(input).endsWith("/api/install") ? Response.json(installFixture()) : new Response("", { status: 404 }) })
  await settle()
  expect(reads).toBe(0)
})
