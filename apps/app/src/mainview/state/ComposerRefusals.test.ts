import { describe, expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import type { AppStore } from "./AppStore"
import { json, memoryStorage, settled, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * The composer is an invocation surface, not a second contract.
 *
 * A flow the human TYPES refuses exactly the way a flow the human CLICKS
 * refuses. Dropping the outcome of `commands.run` on the composer path is what
 * made `/issues.view 999999 owner/repo` render nothing while the bare
 * `/issues.view` (which the slash menu routes through the pointer path) stated
 * its refusal — the same flow, the same seam, two behaviours.
 */

/** A signed-in, allowlisted session: the state every repository flow requires. */
const signedInStore = async (): Promise<AppStore> => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "will",
    allowlisted: true,
    admin: true,
    scopesPlain: null
  })
  return store
}

const failedToasts = (store: AppStore) =>
  [...store.collections.toasts.values()].filter((toast) => toast.status === "failed")

/** What the person can still read after the notifications have gone. */
const transcript = (store: AppStore) =>
  [...store.collections.messages.values()].map((message) => message.text).join("\n")

describe("a flow typed into the composer states its refusal", () => {
  test("an upstream 404 on /issues.view <n> <repo> surfaces the seam's own message", async () => {
    const store = await signedInStore()
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async (input) => {
        const path = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          "https://app.test"
        ).pathname
        if (path.includes("/issues/999999")) return json(404, { message: "issue not found" })
        return json(404, { message: `no stub for ${path}` })
      }
    })
    controller.send("/issues.view 999999 codeplanesmithers/canary-sandbox")
    await settled()
    await settled()
    const failed = failedToasts(store)
    expect(failed.length).toBe(1)
    expect(failed[0]?.title).toBe(`${controller.commands.find("issues.view")!.metadata.summary} didn't run`)
    expect(failed[0]?.detail).toContain("Issue #999999")
    expect(failed[0]?.detail).toContain("codeplanesmithers/canary-sandbox")
  })

  test("a malformed argument is refused before the flow runs", async () => {
    const store = await signedInStore()
    let calls = 0
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async () => {
        calls += 1
        return json(200, {})
      }
    })
    controller.send("/env.set NOT_AN_ASSIGNMENT codeplanesmithers/canary-sandbox")
    await settled()
    await settled()
    const failed = failedToasts(store)
    expect(failed.length).toBe(1)
    expect(failed[0]?.title).toBe(`${controller.commands.find("env.set")!.metadata.summary} didn't run`)
    expect(failed[0]?.detail).toContain("NAME=value")
    expect(calls).toBe(0)
  })

  test("a flow that succeeds raises no refusal", async () => {
    const store = await signedInStore()
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async () => json(200, [])
    })
    controller.send("/issues.list open codeplanesmithers/canary-sandbox")
    await settled()
    await settled()
    expect(failedToasts(store).length).toBe(0)
  })

  /*
   * Canary D-6: `/chat.clear --summarize` archived the conversation on a
   * build where summarising was off. The flag had no grammar there, so it was
   * dropped and the consequential half ran anyway — the person watched an act
   * happen under a flag that did nothing. A flag a flow never declared is a
   * misunderstanding, not input, so it refuses and performs nothing.
   */
  test("an unknown flag refuses instead of running the flow without it", async () => {
    const store = await signedInStore()
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async () => json(200, {})
    })
    controller.send("hello")
    await settled()
    const before = store.collections.messages.size
    controller.send("/chat.clear --forever")
    await settled()
    await settled()
    /* Nothing was archived: the earlier turn is still the conversation. */
    expect([...store.collections.messages.values()].map((message) => message.text).join("\n"))
      .not.toContain("Open the archived conversation")
    expect(store.collections.messages.size).toBeGreaterThanOrEqual(before)
    expect(transcript(store)).toContain("--forever")

    /* A flow that DOES take flags refuses the one it never named, and keeps the ones it did. */
    controller.send("/issues.view 3 --bogus codeplanesmithers/canary-sandbox")
    await settled()
    await settled()
    expect(transcript(store)).toContain("--bogus")
  })

  /*
   * Walk W1 (W1-d-doors.json `L99-summarizeSubmission`): the same line added
   * ZERO characters to the transcript on production — no refusal row, no card,
   * no line. The safe half held (`L99-archivedSentencePresent: false`,
   * `L99-priorTurnsStillPresent: true`), so the person was told nothing at all
   * about a flag they typed. The refusal is a toast, and a toast is a
   * notification that leaves; the pause refusal beside it lands in the
   * transcript and stays. This one does too.
   */
  test("the unknown flag's refusal lands in the transcript, names the flag and the door, and archives nothing", async () => {
    const store = await signedInStore()
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async () => json(200, {}),
      /* A notification that auto-dismisses is exactly what the walk could not find afterwards. */
      toastAutoDismissMs: 1
    })
    controller.send("remember that I prefer dark mode")
    await settled()
    const before = [...store.collections.messages.values()].map((message) => message.text)
    controller.send("/chat.clear --forever")
    await settled()
    await settled()
    const after = [...store.collections.messages.values()].map((message) => message.text)
    /* The transcript GREW, and every prior turn is still in it. */
    expect(after.length).toBeGreaterThan(before.length)
    for (const text of before) expect(after).toContain(text)
    const refusal = after.find((text) => text.includes("--forever")) ?? ""
    expect(refusal).toContain("--forever")
    expect(refusal).toContain("/chat.clear")
    /* A refusal is not a decode dump: no schema path, no internal id. */
    expect(refusal).not.toMatch(/Missing key|\[".*"\]|_tag/)
  })

  /*
   * Canary D-4: `/flow.create <description>` answered `POST
   * /api/workflow/provision 200` and one `POST /api/workflow/rpc 200`, and
   * then nothing — no line, no toast, no card, no flow. One rpc is the
   * shape of a refused `Plan`: the gateway's launch plans, approves and runs,
   * so a door that stopped after one call never got past the plan. The
   * workspace's own sentence was returned, toasted for four seconds and lost.
   *
   * The refusal here is UNTYPED — no `detail` naming a control error — which
   * is the case the door cannot translate, so the workspace's own words are
   * what a person gets. The typed miss it CAN translate (FlowNotFound on the
   * authoring flow) is pinned in `FlowCreateEntry.test.ts`.
   *
   * The door SAVES the request and answers, so the sentence lands on the
   * durable card the request minted rather than in the transcript — the same
   * card the retry door hangs on, and it outlives the toast either way.
   */
  test("a flow-authoring door the workspace refuses says so on the card it minted", async () => {
    const store = await signedInStore()
    const rpc: Array<string> = []
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async (input, init) => {
        const path = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          "https://app.test"
        ).pathname
        if (path === "/api/workflow/provision") return json(200, { status: "ready" })
        if (path === "/api/workflow/rpc") {
          rpc.push(String(JSON.parse(String(init?.body ?? "{}")).procedure))
          return json(200, { ok: false, error: { message: "The workspace gateway refused this plan." } })
        }
        return json(404, { message: `no stub for ${path}` })
      }
    })
    controller.send("/flow.create a nightly lint flow codeplanesmithers/canary-sandbox")
    const refused = () => {
      const card = [...store.collections.cards.values()].find((entry) => entry.kind === "run-trace" && entry.payload.authoring !== undefined)
      return card?.kind === "run-trace" ? card.payload.authoring?.launchError : undefined
    }
    for (let tick = 0; tick < 200 && refused() === undefined; tick += 1) await settled()
    /* One rpc: the launch stopped at its plan, so no run was ever started. */
    expect(rpc).toEqual(["Plan"])
    expect(refused()).toBe("The workspace gateway refused this plan.")
  })

  /*
   * The persistent door is the transcript step, not the toast. A toast is a
   * notification and may auto-dismiss; the sign-in step stays in the
   * transcript with its button, and the button is bound to the flow THIS host
   * registers — cloud.sign-in natively, the GitHub step on the web, where the
   * GitHub sign-in IS the Cloud sign-in. The refusal's own prose names no
   * slash recipe: a missing step is a button, never "type /x".
   */
  test("a seam's cloud sign-in refusal offers a persistent sign-in action", async () => {
    const store = await signedInStore()
    const controller = createAppController(store, silentAgent, {
      fetchImpl: async () => json(401, { status: "signed-out" }),
      toastAutoDismissMs: 1
    })
    store.dispatch({ type: "cloud.session.loaded", actor: "system", state: "signed-out", username: null, expiresAt: null, scopes: null })
    controller.send("/box.list")
    await settled()
    await settled()
    const prompts = [...store.collections.messages.values()].filter(message => message.action !== undefined)
    expect(prompts).not.toHaveLength(0)
    const action = prompts[prompts.length - 1]?.action
    const flow = action?.flow ?? ""
    expect(["cloud.sign-in", "auth.sign-in"]).toContain(flow)
    /* The door it names is one this host actually has, or it is a dead end. */
    expect(controller.commands.find(flow)).toBeDefined()
    for (const toast of failedToasts(store)) expect(toast.detail).not.toContain("/cloud.sign-in")
  })
})
