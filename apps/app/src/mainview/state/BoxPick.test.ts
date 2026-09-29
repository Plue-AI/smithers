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
        // A pull request's context is a read, not a box call.
        if (/\/landings\/\d+$/.test(path)) return json(200, { number: 4, title: "Tidy", state: "open" })
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

/* Every card that names a box: launches, plans, registrations. */
const boundBoxes = (store: AppStore): ReadonlyArray<string> => [...new Set([...store.collections.cards.values()].flatMap((card) => {
  if (card.kind === "flow-form") return []
  const payload = card.payload as { readonly workspaceId?: unknown; readonly preparations?: ReadonlyArray<{ readonly workspaceId?: string }> }
  return [
    ...(typeof payload.workspaceId === "string" ? [payload.workspaceId] : []),
    ...(payload.preparations ?? []).flatMap((row) => row.workspaceId === undefined ? [] : [row.workspaceId])
  ]
}))]

const ISSUE = { repo: REPO, number: 7, title: "Flaky test", state: "open" as const, author: "will", issueBody: "It flakes.", labels: [], comments: [] }
const openIssue = (store: AppStore) =>
  store.dispatch({ type: "card.upsert", actor: "user", card: { id: "issue-7", kind: "issue", title: ISSUE.title, status: "active", createdAt: 1, ordinal: 1, payload: ISSUE } }).isPersisted.promise

/*
 * Each human entry point that binds an unbound act to a box (#2475). `given`
 * is the line the pick resumes; `inline` marks an act whose Submit awaits
 * its first box call (held open here), so the test watches the call instead.
 * Excluded on purpose: run/card-bound acts (sourceCard, runs.open, approvals)
 * keep their recorded box; triggers.approve keeps the box its preparation
 * recorded; the gateway seam's bindingFor answers calls already admitted.
 */
const entries: ReadonlyArray<{ readonly flow: string; readonly args: string; readonly given: string; readonly inline?: true; readonly seed?: (store: AppStore) => Promise<unknown> }> = [
  { flow: "flow.run", args: `lint ${REPO}`, given: `lint ${REPO}` },
  { flow: "flow.run", args: `lint ${REPO} {"path":"src"}`, given: `lint ${REPO} {"path":"src"}` },
  { flow: "flow.plan", args: `lint ${REPO}`, given: `lint ${REPO}` },
  { flow: "change.request", args: `fix the flaky test ${REPO}`, given: `fix the flaky test ${REPO}` },
  { flow: "change.request", args: `fix the flaky test from:feature-x ${REPO}`, given: `fix the flaky test from:feature-x ${REPO}` },
  { flow: "flow.create", args: `lint every file ${REPO}`, given: `lint every file ${REPO}` },
  { flow: "feature.prototype", args: `dark mode ${REPO}`, given: `dark mode ${REPO}`, inline: true },
  { flow: "issue.implement", args: `7 ${REPO}`, given: `7 ${REPO}`, seed: openIssue },
  { flow: "issue.repro", args: `7 ${REPO}`, given: `7 ${REPO}`, seed: openIssue },
  { flow: "issue.poc", args: `7 ${REPO}`, given: `7 ${REPO}`, seed: openIssue },
  { flow: "issue.flows", args: `7 ${REPO}`, given: `7 ${REPO}`, seed: openIssue, inline: true },
  { flow: "prs.triage", args: `4 ${REPO}`, given: `4 ${REPO}` },
  { flow: "triggers.run", args: `nightly ${REPO}`, given: `nightly ${REPO}` },
  { flow: "triggers.resume", args: `nightly ${REPO}`, given: `nightly ${REPO}` },
  { flow: "triggers.register", args: `${REPO} --flow lint`, given: JSON.stringify({ repo: REPO, flow: "lint" }) }
]

const twoBoxes = async (entry: (typeof entries)[number]) => {
  const store = await signedIn()
  await loadBox(store, REPO, BOX_A)
  await loadBox(store, REPO, BOX_B)
  await entry.seed?.(store)
  const relay = boxCalls()
  return { store, relay, controller: createAppController(store, silentAgent, relay.services) }
}

describe("every human box-bound entry point takes the pick (#2475)", () => {
  for (const entry of entries) {
    test(`/${entry.flow} ${entry.args}: the pick precedes every call, then Submit runs it once on the chosen box`, async () => {
      const { store, relay, controller } = await twoBoxes(entry)

      const asked = await controller.commands.run(entry.flow, entry.args)
      expect(asked).toEqual({ status: "executed", value: formRenderedText(["workspaceId"]) })
      expect(pickForm(store)?.payload.given).toMatchObject({ repo: REPO, flow: entry.flow, args: entry.given })
      expect(pickForm(store)?.payload.fields[0]?.options?.map((option) => option.value)).toEqual([BOX_A, BOX_B])
      expect(relay.calls).toEqual([])
      expect(boundBoxes(store)).toEqual([])
      expect(store.session().activeRepoKey).toBe(REPO)

      await controller.commands.run("form.set", `${FORM} workspaceId ${BOX_B}`)
      const submitted = controller.commands.run("form.submit", FORM)
      if (entry.inline === undefined) expect((await submitted).status).toBe("executed")
      await waitFor(() => boundBoxes(store).length > 0 || relay.calls.length > 0)
      expect(store.session().activeRepoKey).toBe(`${REPO}#workspace:${BOX_B}`)
      expect(boundBoxes(store).every((box) => box === BOX_B)).toBe(true)
      expect(relay.calls.map((call) => call.body.workspaceId ?? BOX_B).every((box) => box === BOX_B)).toBe(true)
      const seen = { boxes: boundBoxes(store), calls: relay.calls.length }

      // A replayed Submit, while the first is held or after it, runs nothing more.
      expect((await controller.commands.run("form.submit", FORM)).status).toBe("failed")
      expect({ boxes: boundBoxes(store), calls: relay.calls.length }).toEqual(seen)
    })

    test(`/${entry.flow}: the agent keeps the sentence and no form`, async () => {
      const { store, relay, controller } = await twoBoxes(entry)
      const outcome = await controller.commands.runForAgent(entry.flow, entry.args)
      // A consequential act asks the human to confirm instead; nothing has run either way.
      if (outcome.status === "failed") expect(outcome.error).toContain(`Select a box of ${REPO} first.`)
      else expect(outcome).toMatchObject({ status: "executed", value: expect.stringContaining("asked the user to confirm") })
      expect(pickForm(store)).toBeUndefined()
      expect(relay.calls).toEqual([])
      expect(boundBoxes(store)).toEqual([])
    })

    test(`/${entry.flow}: a selected box needs no pick and is the one used`, async () => {
      const { store, relay, controller } = await twoBoxes(entry)
      await store.dispatch({ type: "repo.selected", actor: "user", id: `${REPO}#workspace:${BOX_A}` }).isPersisted.promise
      void controller.commands.run(entry.flow, entry.args)
      await waitFor(() => boundBoxes(store).length > 0 || relay.calls.length > 0)
      expect(pickForm(store)).toBeUndefined()
      expect(boundBoxes(store).every((box) => box === BOX_A)).toBe(true)
      expect(relay.calls.map((call) => call.body.workspaceId ?? BOX_A).every((box) => box === BOX_A)).toBe(true)
    })
  }

  test("a box that is gone by Submit leaves /flow.run unlaunched and the selection unchanged", async () => {
    const { store, relay, controller } = await twoBoxes(entries[0]!)
    await controller.commands.run("flow.run", `lint ${REPO}`)
    await controller.commands.run("form.set", `${FORM} workspaceId ${BOX_B}`)
    await loadBox(store, REPO, BOX_B, "failed")
    await controller.commands.run("form.submit", FORM)
    expect(pickForm(store)?.payload.error).toBe("That box is no longer available.")
    expect(store.session().activeRepoKey).toBe(REPO)
    expect(boundBoxes(store)).toEqual([])
    expect(relay.calls).toEqual([])
  })

  test("a run bound to its source card never offers the pick", async () => {
    const { store, relay, controller } = await twoBoxes(entries[0]!)
    await store.dispatch({ type: "card.upsert", actor: "system", card: { id: "catalog", kind: "workflow-list", title: "Flows", status: "active", createdAt: 1, ordinal: 1,
      payload: { repo: REPO, workspaceId: BOX_A, gatewayBindingVersion: 1, workflows: [{ key: "lint", description: null }] } } }).isPersisted.promise
    expect(await controller.commands.run("flow.run", `sourceCard=catalog lint ${REPO}`)).toMatchObject({ status: "executed", value: expect.stringContaining("run-requested workflow=lint") })
    await waitFor(() => [...store.collections.cards.keys()].some((id) => id.startsWith("flow-request-")))
    expect(pickForm(store)).toBeUndefined()
    expect(boundBoxes(store).every((box) => box === BOX_A)).toBe(true)
  })
})
