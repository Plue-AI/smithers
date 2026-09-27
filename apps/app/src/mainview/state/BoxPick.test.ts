/*
 * THE FORM LAW for a box-bound act (#2327). When several boxes of a
 * repository could be meant, a human's act renders the box.select form for
 * exactly those boxes instead of refusing with "Select a box of <repo>
 * first.". Nothing reaches a box before the pick; Submit selects the chosen
 * box and runs the act that asked once, on that box. No box is created and
 * none is chosen for the person.
 */
import { describe, expect, test } from "bun:test"
import type { AppStore } from "./AppStore"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { formRenderedText } from "./controller/forms"
import { json, loadBox, memoryStorage, silentAgent, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()

const REPO = "will/flows"
const BOX_A = "0b0c0d0e-0000-4000-8000-00000000000a"
const BOX_B = "0b0c0d0e-0000-4000-8000-00000000000b"
const BOX_OTHER = "0b0c0d0e-0000-4000-8000-00000000000c"
const BOX_ELSEWHERE = "0b0c0d0e-0000-4000-8000-00000000000d"
const FORM = "form-box.select"

const signedIn = async (): Promise<AppStore> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: REPO, org: "will", ownerKind: "user", name: "flows", head: null }] }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: REPO }).isPersisted.promise
  return store
}

/** Every box call is recorded and held open: the pick must precede them all. */
const boxCalls = () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  return {
    calls,
    services: {
      toastDebounceMs: 0,
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "https://app.test").pathname
        if (path.startsWith("/api/workflow/")) {
          calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> })
          return new Promise<Response>(() => {})
        }
        return json(404, { status: "error" })
      }
    }
  }
}

const pickForm = (store: AppStore) => {
  const card = store.collections.cards.get(FORM)
  return card?.kind === "flow-form" ? card : undefined
}

const inboxRequests = (store: AppStore) => store.session().approvalsInboxRequests ?? []

describe("a box-bound act with several boxes to mean", () => {
  const cases = [
    { name: "several running boxes", seed: [[BOX_A, "running"], [BOX_B, "running"], [BOX_OTHER, "suspended"]], offered: [BOX_A, BOX_B] },
    { name: "several stopped or suspended boxes", seed: [[BOX_A, "stopped"], [BOX_B, "suspended"]], offered: [BOX_A, BOX_B] }
  ] as const

  for (const scenario of cases) {
    test(`${scenario.name}: the Inbox renders the pick, then runs once on the chosen box`, async () => {
      const store = await signedIn()
      for (const [id, status] of scenario.seed) await loadBox(store, REPO, id, status)
      await loadBox(store, "will/other", BOX_ELSEWHERE)
      const relay = boxCalls()
      const controller = createAppController(store, silentAgent, relay.services)

      const asked = await controller.commands.run("approvals.list", REPO)
      expect(asked).toEqual({ status: "executed", value: formRenderedText(["workspaceId"]) })
      const form = pickForm(store)
      expect(form?.payload.flow).toBe("box.select")
      expect(form?.payload.fields.map((field) => field.name)).toEqual(["workspaceId"])
      expect(form?.payload.fields[0]?.options?.map((option) => option.value)).toEqual([...scenario.offered])
      expect(form?.payload.given).toMatchObject({ repo: REPO, flow: "approvals.list", args: REPO })
      // Nothing ran and nothing was chosen before the pick.
      expect(relay.calls).toEqual([])
      expect(inboxRequests(store)).toEqual([])
      expect(store.session().activeRepoKey).toBe(REPO)

      expect((await controller.commands.run("form.set", `${FORM} workspaceId ${BOX_B}`)).status).toBe("executed")
      expect((await controller.commands.run("form.submit", FORM)).status).toBe("executed")
      expect(store.session().activeRepoKey).toBe(`${REPO}#workspace:${BOX_B}`)
      expect(inboxRequests(store).map((request) => request.workspaceId)).toEqual([BOX_B])
      await waitFor(() => relay.calls.length > 0)
      expect(relay.calls.every((call) => call.body.workspaceId === BOX_B)).toBe(true)
      expect(pickForm(store)?.status).toBe("acted")

      // A second Submit runs nothing more.
      const again = await controller.commands.run("form.submit", FORM)
      expect(again.status).toBe("failed")
      expect(inboxRequests(store)).toHaveLength(1)
    })
  }

  test("a box that is gone by Submit runs nothing and selects nothing", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    await loadBox(store, REPO, BOX_B)
    const relay = boxCalls()
    const controller = createAppController(store, silentAgent, relay.services)
    await controller.commands.run("approvals.list", REPO)
    await controller.commands.run("form.set", `${FORM} workspaceId ${BOX_B}`)
    await loadBox(store, REPO, BOX_B, "failed")
    await controller.commands.run("form.submit", FORM)
    expect(pickForm(store)?.payload.error).toBe("That box is no longer available.")
    expect(store.session().activeRepoKey).toBe(REPO)
    expect(inboxRequests(store)).toEqual([])
    expect(relay.calls).toEqual([])
  })

  test("the agent keeps the sentence: which box an act runs on is the human's pick", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    await loadBox(store, REPO, BOX_B)
    const relay = boxCalls()
    const controller = createAppController(store, silentAgent, relay.services)
    const outcome = await controller.commands.runForAgent("approvals.list", REPO)
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") expect(outcome.error).toContain(`Select a box of ${REPO} first.`)
    expect(pickForm(store)).toBeUndefined()
    expect(relay.calls).toEqual([])
  })

  test("one box needs no pick", async () => {
    const store = await signedIn()
    await loadBox(store, REPO, BOX_A)
    const relay = boxCalls()
    const controller = createAppController(store, silentAgent, relay.services)
    expect(await controller.commands.run("approvals.list", REPO)).toEqual({ status: "executed", value: "Approvals requested." })
    expect(pickForm(store)).toBeUndefined()
    expect(inboxRequests(store).map((request) => request.workspaceId)).toEqual([BOX_A])
  })
})
