import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { selectFirstRunRepository } from "./FirstRunRepository"
import { json, memoryStorage, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The boot seam, not selectFirstRunRepository by hand: every test here drives
 * the identity reads ControllerBoot.client.ts drives, because the settle
 * belongs to the read that writes the row (controller/auth-billing.ts) and a
 * boot closure alone loses it whenever a second read starts first.
 */

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(check()).toBe(true)
}

const forms = (store: Awaited<ReturnType<typeof createAppStore>>) =>
  [...store.collections.cards.values()].filter(card => card.kind === "flow-form")

/** The identity seam, answerable by the test: every session read waits for `release`. */
const heldIdentity = (answer: () => Promise<Response> = async () => json(401, { status: "signed-out" })) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  return {
    release: () => release(),
    fetchImpl: async (input: unknown): Promise<Response> => {
      const path = new URL(String(input), "https://app.test").pathname
      if (path.endsWith("/api/user")) {
        await held
        return answer()
      }
      if (path.endsWith("/auth/scopes")) return json(200, { scopes: [] })
      return json(404, { status: "error" })
    }
  }
}

/** ControllerBoot.client.ts's non-blocking branch, with its entry URL empty. */
const bootIdentityRead = (
  store: Awaited<ReturnType<typeof createAppStore>>,
  controller: ReturnType<typeof createAppController>
): void => {
  const settle = () => selectFirstRunRepository(store, controller.settleFirstRunTarget)
  void controller.loadSession().then(settle, settle)
}

test("a focus re-read during the boot identity read still offers sign-in for the parked command", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const identity = heldIdentity()
  const controller = createAppController(store, silentAgent, {
    fetchImpl: identity.fetchImpl,
    // The deadline must not be what saves this: the seam has to announce.
    firstRunSettleMs: 60_000
  })
  try {
    expect(await controller.commands.run("issues.list")).toEqual({ status: "executed", value: "Requested" })
    bootIdentityRead(store, controller)
    // controller/auth-billing.ts watchIdentityAcrossTabs: window focus re-reads
    // the session, starts a newer probe, and the boot read returns at its guard.
    void controller.loadSession()
    identity.release()

    await until(() => store.session().pendingCommand?.requirement === "repo-source")
    expect(forms(store)).toEqual([])
    expect([...store.collections.cards.values()].filter(card => card.kind === "issue-list")).toHaveLength(0)
    expect([...store.collections.messages.values()].filter(message => message.action?.flow === "sign-in")).toHaveLength(1)
  } finally { await controller.dispose() }
})

test("an identity read no boot closure watches still settles the first-run choice", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, {
    fetchImpl: async (input: unknown) => {
      if (new URL(String(input), "https://app.test").pathname.endsWith("/api/user")) throw new Error("identity seam unreachable")
      return json(404, { status: "error" })
    },
    firstRunSettleMs: 60_000
  })
  try {
    expect(await controller.commands.run("issues.list")).toEqual({ status: "executed", value: "Requested" })
    // watchIdentityAcrossTabs' re-read: no closure chains onto this promise, so
    // only the seam that records the answer can announce the choice.
    void controller.loadSession()

    await until(() => store.collections.cards.get("form-issues.list") !== undefined)
    expect(forms(store)).toHaveLength(1)
    expect(store.session().pendingCommand ?? null).toBeNull()
  } finally { await controller.dispose() }
})

test("a first-run park settles at its deadline when identity never answers", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const identity = heldIdentity()
  const controller = createAppController(store, silentAgent, {
    fetchImpl: identity.fetchImpl,
    firstRunSettleMs: 25
  })
  try {
    bootIdentityRead(store, controller)
    // The seam is held for the whole test: the deadline is the only producer.
    expect(await controller.commands.run("issues.list")).toEqual({ status: "executed", value: "Requested" })
    expect(store.session().pendingCommand).toMatchObject({ name: "issues.list", requirement: "first-run-target" })

    await until(() => store.collections.cards.get("form-issues.list") !== undefined)
    expect(store.session().pendingCommand ?? null).toBeNull()
    expect(store.session().activeRepoKey ?? null).toBeNull()
  } finally { identity.release(); await controller.dispose() }
})

test("the boot's non-blocking identity read settles on both sides of the promise", async () => {
  // FirstRunRepository.ts:20 settles a rejected persist the same way; a read
  // that rejects with only an onFulfilled handler parks the command forever.
  const source = await readFile(`${import.meta.dir}/../ControllerBoot.client.ts`, "utf8")
  expect(source).toContain("void controller.loadSession().then(settle, settle)")
})
