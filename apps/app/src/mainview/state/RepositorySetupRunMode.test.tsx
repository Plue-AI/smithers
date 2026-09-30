import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { initialSetup, type RepositorySetup } from "@smthrs/rpc/RepositorySetup"
import type { StorageApi } from "@tanstack/db"
import { RepositorySetupCard } from "../cards/RepositorySetupCard"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { recordingAgent, waitFor } from "./TestFixtures"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

const createAppController = scopedControllers()
const id = "setup:maintainer:example%2Frepo:issues"
const fixModeOf = (payload: RepositorySetup) => payload.draft.steps.find(step => step.id === "fix")?.mode
const STORAGE_FULL =
  "This browser has no room left for Smithers' saved data, so that change was not saved. Free space for this site in your browser settings, then make the change again."

/*
 * This browser's saved data, with one way to make a SINGLE commit fail the way
 * a browser makes one fail: a quota rejection the commit after it survives.
 * That is the shape the walk recorded — the run-mode pick reached nothing while
 * the two edits made seconds later reached revision 16 — so a whole-store
 * outage is the wrong model for this defect. A commit writes the staged
 * envelope first, so counting staged writes counts commits.
 */
const flakyStorage = (): StorageApi & { refuseCommit: (skip: number) => void; refuseCommitNaming: (marker: string) => void } => {
  const data = new Map<string, string>()
  let countdown: number | undefined
  let marker: string | undefined
  const refuse = (): never => {
    throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError", code: 22 })
  }
  return {
    refuseCommit: (skip) => { countdown = skip },
    /** Refuse the one commit whose envelope carries this text, whenever it comes. */
    refuseCommitNaming: (text) => { marker = text },
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (key.endsWith(".staged")) {
        if (marker !== undefined && value.includes(marker)) { marker = undefined; refuse() }
        if (countdown === 0) { countdown = undefined; refuse() }
        if (countdown !== undefined) countdown -= 1
      }
      data.set(key, value)
    },
    removeItem: (key) => void data.delete(key)
  }
}

/*
 * The whole composed path, as the production walk drove it: a real store on the
 * real transactional storage host, the real controller and command registry,
 * and the real card mounted as a live projection of the store. A pick is made
 * by firing the select's own change event, so it travels card `onRunCommand` →
 * `AppController.runCommand` → registry → `configureRepositorySetup` →
 * `upsert` → the persisted payload, with nothing doubled in between.
 */
async function walk(options: { readonly explodeAfterCardWrite?: boolean; readonly observedRun?: boolean; readonly holdCardWrite?: boolean } = {}) {
  const storage = flakyStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  /*
   * A bug that runs AFTER the bytes are already durable. `upsert` re-arms this
   * card's schedule observation once the write has landed, and the only thing
   * that step can do wrong is throw — at which point the person's change IS
   * saved. Armed from the persisted promise of the card write itself, so the
   * throw is guaranteed to land on the far side of a successful commit.
   */
  let bombs = 0
  let arming = false
  const explode = options.explodeAfterCardWrite === true
  let holdWrite = false
  let releaseWrite: (() => void) | undefined
  let writeGate = Promise.resolve()
  const cards = store.collections.cards
  const controllerStore = !explode && !options.holdCardWrite ? store : {
    ...store,
    collections: { ...store.collections, cards: new Proxy(cards, {
      get: (target, property) => {
        if (property !== "get") { const held = Reflect.get(target, property); return typeof held === "function" ? held.bind(target) : held }
        return (key: string) => {
          if (bombs === 0) return target.get(key)
          bombs -= 1
          throw new TypeError("the card projection is not ready")
        }
      }
    }) },
    dispatch: (transition: Parameters<typeof store.dispatch>[0]) => {
      const transaction = store.dispatch(transition)
      if (transition.type !== "card.upsert" || (!arming && !holdWrite)) return transaction
      const shouldExplode = arming
      arming = false
      holdWrite = false
      return new Proxy(transaction, { get: (target, property, receiver) => property === "isPersisted"
        ? { ...target.isPersisted, promise: (shouldExplode ? target.isPersisted.promise : writeGate.then(() => target.isPersisted.promise)).then(value => { if (shouldExplode) bombs = 1; return value }) }
        : Reflect.get(target, property, receiver) })
    }
  } as typeof store
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maintainer", admin: false, scopesPlain: null }).isPersisted.promise
  /*
   * A finished inspection whose host receipt names the run it produced. That
   * is what renders this card's `Run` button, the door `runs.open` hangs on.
   */
  const observed = options.observedRun === true
  if (observed) {
    // The person's own repository list: without it the run's trailing owner/repo
    // is not a repository the door recognises, and the press renders a form.
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
      { id: "example/repo", org: "example", ownerKind: "user", name: "repo", head: null }
    ] }).isPersisted.promise
  }
  /*
   * The card's own background watch reads this run once when it mounts. The
   * press under test is the SECOND read, and its summary carries a word of its
   * own so the commit that records it can be picked out from the first.
   */
  let runReads = 0
  /*
   * A hold on the run read the PRESS makes, so a second act can be admitted
   * and settle while the press is still in flight. Two lost acts overlapping
   * in time is the only state in which one act's line can stand in for
   * another's, and on a live card it is a race; here it is the precondition.
   */
  let gate: Promise<void> | undefined
  let openGate: (() => void) | undefined
  await store.dispatch({ type: "card.upsert", actor: "user", card: {
    id, kind: "repository-setup", title: "Handle issues", status: "active", createdAt: 1, ordinal: store.nextOrdinal(),
    payload: {
      ...initialSetup("example/repo", "issues", "maintainer"), inspectedAt: 1234,
      ...(observed ? {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        request: { id: "request-1", operation: "inspect" as const, revision: 1, digest: "digest-1", state: "completed" as const },
        receipt: {
          requestId: "request-1", runId: "run-1", revision: 1, operation: "inspect" as const, phase: "completed" as const,
          digest: "digest-1", updatedAt: 2, results: [], evidence: []
        }
      } : {})
    }
  } }).isPersisted.promise
  const controller = createAppController(controllerStore, recordingAgent([]), {
    workflowPollMs: 1,
    toastDebounceMs: 0,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "https://app.test")
      if (url.pathname.endsWith("/repository-setup/state")) {
        return Response.json({ owner: "maintainer", repo: "example/repo", job: "issues", registration: { state: "known" }, setup: { state: "none" } })
      }
      if (url.pathname === "/api/workflow/provision") return Response.json({ status: "ready", repo: "example/repo", gatewayId: "gateway-1" })
      if (url.pathname === "/api/workflow/rpc") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { procedure?: string; payload?: { selector?: { _tag?: string } } } : undefined
        if (body?.procedure === "Projection.Snapshot" && body.payload?.selector?._tag === "run-summary") {
          runReads += 1
          if (runReads > 1 && gate !== undefined) await gate
          return Response.json({ ok: true, payload: { cursor: { projection: "run-summary", runId: null, value: runReads }, rows: [{
            runId: "run-1", flowId: "issues", status: "completed", createdAt: 1, updatedAt: 2, turns: 0, calls: 0, callsFailed: 0,
            editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0, verdict: "completed",
            diagnosis: runReads === 1 ? "Verdict   done." : "Verdict   read again."
          }] } })
        }
        return Response.json({ ok: false, error: { message: `no ${body?.procedure ?? "procedure"}` } })
      }
      return Response.json({}, { status: 404 })
    },
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: ["agent", "identity", "cloud"], authFlow: "redirect", sandbox: null }
  })
  await waitFor(() => { const card = store.collections.cards.get(id); return card?.kind === "repository-setup" && card.payload.recovery?.state === "completed" })

  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = () => {
    const card = store.collections.cards.get(id)!
    flushSync(() => root.render(<RepositorySetupCard card={card as never} onRunCommand={(name, args) => { controller.runCommand(name, args) }} />))
  }
  render()
  const subscription = store.collections.cards.subscribeChanges(() => render())
  const select = () => {
    const label = [...host.querySelectorAll("label")].find(node => node.textContent?.includes("When to run Fix for real"))!
    return label.querySelector("select")!
  }
  const pick = (mode: string) => {
    const node = select()
    node.value = mode
    node.dispatchEvent(new Event("change", { bubbles: true }))
  }
  const press = (label: string) => {
    const button = [...host.querySelectorAll("button")].find(node => node.textContent === label)!
    button.dispatchEvent(new Event("click", { bubbles: true }))
  }
  /** The run button the receipt renders, which is bound to `runs.open`. */
  const pressRunAccess = () => {
    const button = [...host.querySelectorAll<HTMLButtonElement>(".setup-actions button")].find(node => node.textContent === "Run")!
    button.dispatchEvent(new Event("click", { bubbles: true }))
  }
  const setup = () => (store.collections.cards.get(id) as { payload: RepositorySetup }).payload
  const transcript = () => [...store.collections.messages.values()].map(message => (message as { text?: string }).text ?? "")
  const toastDetails = () => [...store.collections.toasts.values()].map(toast => (toast as { detail?: string }).detail ?? "")
  const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms))
  /** Refuse the commit that saves the edited card; the command's own intent record commits first. */
  const refuseCardWrite = () => { storage.refuseCommit(1) }
  /** Refuse the commit that records the command itself, before the door ever runs. */
  const refuseCommandWrite = () => { storage.refuseCommit(0) }
  /** Refuse the commit that records a pressed setup operation, wherever it lands. */
  const refuseOperationWrite = (operation: string) => { storage.refuseCommitNaming(JSON.stringify(`"operation":"${operation}"`).slice(1, -1)) }
  const close = async () => {
    subscription.unsubscribe(); flushSync(() => root.unmount()); host.remove()
    await Promise.resolve(controller.dispose()).catch(() => {})
    await Promise.resolve(store.dispose?.()).catch(() => {})
  }
  /*
   * Refuse the commit that records the run the PRESS read: the second read's
   * summary is the one carrying "read again", so the commit that stores it is
   * the commit `runs.open` awaits.
   */
  const refuseObservationWrite = () => { storage.refuseCommitNaming("read again") }
  /** The next card write lands, and the step that runs after it throws. */
  const explodeAfterNextCardWrite = () => { arming = true }
  const holdNextCardWrite = () => { writeGate = new Promise<void>(resolve => { releaseWrite = resolve }); holdWrite = true }
  const releaseCardWrite = () => { releaseWrite?.() }
  /** Hold the press's own run read, and let it go. */
  const holdRunRead = () => { gate = new Promise<void>(resolve => { openGate = resolve }) }
  const releaseRunRead = () => { openGate?.(); gate = undefined }
  return { store, controller, holdRunRead, releaseRunRead, holdNextCardWrite, releaseCardWrite, pick, press, pressRunAccess, select, setup, transcript, toastDetails, settle, refuseCardWrite, refuseCommandWrite, refuseOperationWrite, refuseObservationWrite, explodeAfterNextCardWrite, close }
}

/*
 * The accepted half, through the door the person actually used: the walk's own
 * dispatch (`step.fix.mode` → `automatic`) is what this select fires, and the
 * draft it reaches is the one `Create test issue` submits.
 */
test("a run-mode pick made on the card reaches the durable draft", async () => {
  const t = await walk()
  try {
    const before = t.setup().revision
    expect(fixModeOf(t.setup())).toBe("manual")
    t.pick("automatic")
    await t.settle()
    expect(fixModeOf(t.setup())).toBe("automatic")
    expect(t.setup().revision).toBe(before + 1)
    expect(t.select().value).toBe("automatic")
    expect(t.transcript()).toEqual([])
  } finally { await t.close() }
})

/*
 * Walk run 3, B3-N5. `When to run Fix for real` was set to `Automatic`, the
 * select went back to `Manual`, the durable draft stayed at `fix: manual`
 * (`B3-16-state-trial-terminal.json` at revision 16 is byte-equal to the
 * revision 14 draft), and NOTHING was appended to the transcript. The door
 * never refused — `applySetupEdit` accepts a mode three other steps already
 * hold — the WRITE failed, and a failed write left this door as a rejected
 * promise the flow harness relabelled `/setup.configure failed`: one toast,
 * four seconds, an internal id, and silence where the person was looking.
 */
test("a run-mode pick this browser did not save is named in the transcript, not only on a toast", async () => {
  const t = await walk()
  try {
    const before = t.setup().revision
    t.refuseCardWrite()
    t.pick("automatic")
    await t.settle()
    // The pick is still lost. That is honest; saying nothing about it was not.
    expect(fixModeOf(t.setup())).toBe("manual")
    expect(t.setup().revision).toBe(before)
    expect(t.select().value).toBe("manual")
    expect(t.transcript()).toEqual([STORAGE_FULL])
    expect(t.toastDetails()).toEqual([STORAGE_FULL])
    // Not an internal id, not a storage boundary key, not a raw decode message.
    expect(t.transcript()[0]).not.toContain("setup.configure")
    expect(t.transcript()[0]).not.toContain(id)
    expect(t.transcript()[0]).not.toContain("quota")
  } finally { await t.close() }
})

/*
 * The same loss, one door over on the same card. `Inspect repository` records
 * the press as a durable request before anything is sent; when this browser
 * refuses that commit the press reached nothing, and the door rejected rather
 * than refusing — so the person got one four-second toast carrying the flow's
 * own summary, no cause, no next act, and an empty transcript. Every door on
 * this card that writes owes the same sentence in the same place.
 */
test("a repository job press this browser did not save is named in the transcript, not only on a toast", async () => {
  const t = await walk()
  try {
    t.refuseOperationWrite("inspect")
    t.press("Inspect repository")
    await t.settle()
    // The press is still lost. That is honest; saying nothing about it was not.
    expect(t.setup().request).toBeUndefined()
    expect(t.transcript()).toEqual([STORAGE_FULL])
    expect(t.toastDetails()).toEqual([STORAGE_FULL])
    // Not an internal id, not a storage boundary key, not a raw decode message.
    expect(t.transcript()[0]).not.toContain("setup.run")
    expect(t.transcript()[0]).not.toContain(id)
    expect(t.transcript()[0]).not.toContain("quota")
  } finally { await t.close() }
})

/*
 * The adjacent hazard. One card's writes are ordered by a promise chain, and
 * `.then(apply)` made a failed write the verdict of the NEXT edit: press
 * `Inspect repository`, have that write fail, set a run mode, and the mode
 * never ran `apply` at all — it reached nothing and said nothing, one step
 * removed from a cause that was never the person's. Ordering is what the queue
 * owes the card; a verdict is not, and the press owns its own sentence.
 */
test("a run-mode pick made while an earlier write is still failing still reaches the draft", async () => {
  const t = await walk()
  try {
    const before = t.setup().revision
    t.refuseOperationWrite("inspect")
    // Both doors are entered before either settles, which is the only state in
    // which the queue can hand one edit another's verdict. Pressed from the
    // card, that overlap is a race; here it is the precondition under test.
    const pressed = t.controller.runRepositorySetup(id, "inspect")
    const picked = t.controller.configureRepositorySetup(id, "step.fix.mode", "automatic")
    // The press owns its own failure — as a sentence it returns and states in
    // the transcript, never as a rejection anyone else could inherit. Only the
    // pick's fate is under test here.
    expect(await pressed).toBe(STORAGE_FULL)
    expect(await picked).toEqual({ value: "Draft updated." })
    expect(t.transcript()).toEqual([STORAGE_FULL])
    await t.settle(400)
    expect(t.setup().request).toBeUndefined()
    expect(fixModeOf(t.setup())).toBe("automatic")
    expect(t.setup().revision).toBe(before + 1)
    expect(t.select().value).toBe("automatic")
  } finally { await t.close() }
})

/*
 * The same loss one layer earlier: the browser refuses the commit that records
 * the command, so the door never runs at all. The pick reaches nothing for a
 * reason that is not the person's doing, and that also belongs where they are
 * looking rather than only on a toast.
 */
test("a run-mode pick the browser would not even record says so in the transcript", async () => {
  const t = await walk()
  try {
    const before = t.setup().revision
    t.refuseCommandWrite()
    t.pick("automatic")
    await t.settle()
    expect(fixModeOf(t.setup())).toBe("manual")
    expect(t.setup().revision).toBe(before)
    expect(t.transcript()).toEqual([STORAGE_FULL])
  } finally { await t.close() }
})

/*
 * The other half of the same rule: a sentence must not be spoken about a
 * change that WAS saved. `upsert` re-arms this card's schedule observation
 * after the bytes are durable, and that step sat inside the same `try` as the
 * write — so a bug there told the person their pick "was not saved" about a
 * pick sitting in the draft. The classifier now sees the write and nothing
 * else; a bug after it stays a bug.
 */
test("a bug after the pick is durable never tells the person the pick was lost", async () => {
  const t = await walk({ explodeAfterCardWrite: true })
  try {
    const before = t.setup().revision
    t.explodeAfterNextCardWrite()
    const picked = t.controller.configureRepositorySetup(id, "step.fix.mode", "automatic")
    const settled = await picked.then(value => ({ value }), (error: unknown) => ({ error }))
    await t.settle()
    // The pick landed. Nothing may claim otherwise.
    expect(fixModeOf(t.setup())).toBe("automatic")
    expect(t.setup().revision).toBe(before + 1)
    expect(t.transcript()).toEqual([])
    // The bug stays a bug. It reaches this app's own error channel rather
    // than the person's transcript wearing a storage fault's words.
    expect(settled).toMatchObject({ error: expect.any(TypeError) })
  } finally { await t.close() }
})

/*
 * The door the first sweep missed, on this same card. `Run` opens the run the
 * inspection produced, and opening it records what this browser just read:
 * a durable write, refused the same way every other write on this card can be
 * refused. Its rejection never reached the person's own words — the command
 * harness relabelled it "The command did not finish. Check its result before
 * trying again", a sentence with no cause, no next act, and nothing in the
 * transcript. A door does not have to be on the list to owe the sentence.
 */
test("a run this browser did not record says why, not that something did not finish", async () => {
  const t = await walk({ observedRun: true })
  try {
    t.refuseObservationWrite()
    t.pressRunAccess()
    await t.settle(600)
    // The press is still lost. That is honest; saying nothing about why was not.
    expect(t.transcript()).toEqual([STORAGE_FULL])
    expect(t.toastDetails()).toEqual([STORAGE_FULL])
    // Not an internal id, not a storage boundary key, not a raw decode message.
    expect(t.transcript()[0]).not.toContain("run-1")
    expect(t.transcript()[0]).not.toContain("gateway.run.observed")
    expect(t.transcript()[0]).not.toContain("quota")
  } finally { await t.close() }
})

/*
 * Said once means said once FOR THIS ACT. The first rule compared the act's
 * sentence against the newest line in the whole transcript, so a second lost
 * act whose sentence was already the last line said nothing at all: press
 * `Run` twice against a browser that refuses both writes and the person heard
 * about one of them, with a four-second toast as the only word for the other.
 *
 * Both directions are the same rule and are measured together here. A door
 * that says the sentence itself (the pick, through `speak`) marks its line
 * `Message.spoken`, and the failure path recognises THAT line — appended
 * during this submission — and stays quiet. A door whose throw is classified
 * at the flow boundary (`Run`) says nothing of its own, so every lost act gets
 * its own line, however many times the same sentence has been said before.
 */
test("each lost act gets its own line, and a door that already said it is not repeated", async () => {
  const t = await walk({ observedRun: true })
  try {
    // The door speaks for itself: one act, one line, not two.
    t.refuseCardWrite()
    t.pick("automatic")
    await t.settle()
    expect(t.transcript()).toEqual([STORAGE_FULL])
    // The door says nothing of its own: two acts, two lines, same sentence.
    t.refuseObservationWrite()
    t.pressRunAccess()
    await t.settle(600)
    expect(t.transcript()).toEqual([STORAGE_FULL, STORAGE_FULL])
    t.refuseObservationWrite()
    t.pressRunAccess()
    await t.settle(600)
    expect(t.transcript()).toEqual([STORAGE_FULL, STORAGE_FULL, STORAGE_FULL])
  } finally { await t.close() }
})


/*
 * TWO LOST ACTS, TWO DOORS, ONE WINDOW (R104d).
 *
 * The rule above matches a door's line by SENTENCE inside the act's window,
 * and the sentences are a closed table (state/BrowserWriteFailure.ts): any two
 * acts that overlap in time therefore carry the same sentence, with both
 * windows open while either door speaks. The act that surfaced last matched
 * the OTHER act's line and said nothing — two lost acts, two toasts, one
 * line, which is the same silence the rule exists to prevent, one door over.
 *
 * Driven here as the person meets it. `Run` is pressed and held on its run
 * read; while it is in flight the person changes `When to run Fix for real`
 * and this browser refuses that write too. The pick's door speaks its own
 * line; the press owes a line of its own, because a door's line stands in for
 * at most one act (controller/spokenLines.ts).
 *
 * THIS IS THE CLAUSE'S END-TO-END EVIDENCE, and it is two real doors —
 * `setup.configure` and `runs.open` — through the real card and a real refused
 * write. The rule's own unit is controller/spokenLines.test.ts.
 * DurableWriteDoorLines.test.ts runs the same rule under every door's NAME:
 * that is a coverage roll call, not a second proof, because the decision it
 * drives never reads the name (its header says how much each layer is worth).
 */
test("two lost acts inside one window each get their own line", async () => {
  const t = await walk({ observedRun: true })
  try {
    t.refuseObservationWrite()
    t.holdRunRead()
    t.pressRunAccess()
    await t.settle(120)
    t.refuseCardWrite()
    t.pick("automatic")
    await t.settle(500)
    t.releaseRunRead()
    await t.settle(900)
    // The app counted two lost acts; the person must hear about both.
    expect(t.toastDetails()).toEqual([STORAGE_FULL, STORAGE_FULL])
    expect(t.transcript()).toEqual([STORAGE_FULL, STORAGE_FULL])
  } finally { await t.close() }
})

test("check fields and add/remove controls keep sequential edits while persistence is held", async () => {
  const t = await walk({ holdCardWrite: true })
  try {
    const card = t.store.collections.cards.get(id)!
    if (card.kind !== "repository-setup") throw Error("Missing setup")
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: {
      ...card.payload, view: "checks", draft: { ...card.payload.draft, checks: [
        { id: "original", name: "Original", kind: "command", rule: "bun test", paths: [], policy: "report" }
      ] }
    } } }).isPersisted.promise
    await waitFor(() => document.querySelector('.repository-setup fieldset input') !== null)
    const input = (label: string) => [...document.querySelectorAll<HTMLElement>(".repository-setup label")]
      .find(node => node.textContent?.startsWith(label))?.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement
    const type = (node: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      node.value = value
      node.dispatchEvent(new Event("input", { bubbles: true }))
    }
    const press = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".repository-setup button")]
      .find(node => node.textContent === label)!.click()
    t.holdNextCardWrite()
    type(input("Name"), "New name")
    type(input("Command"), "bun test new")
    t.releaseCardWrite()
    await waitFor(() => t.setup().draft.checks[0]?.rule === "bun test new")
    expect(t.setup().draft.checks[0]).toMatchObject({ name: "New name", rule: "bun test new" })
    t.holdNextCardWrite()
    press("Add command")
    press("Add AI check")
    press("Remove check")
    t.releaseCardWrite()
    await waitFor(() => t.setup().draft.checks.length === 2 && t.setup().draft.checks.every(check => check.id !== "original"))
    expect(t.setup().draft.checks.map(check => check.kind)).toEqual(["command", "ai"])
  } finally { t.releaseCardWrite(); await t.close() }
})

test("Case and Expected edits both survive a held persistence receipt", async () => {
  const t = await walk({ holdCardWrite: true })
  try {
    const card = t.store.collections.cards.get(id)!
    if (card.kind !== "repository-setup") throw Error("Missing setup")
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, payload: {
      ...card.payload, view: "evals", draft: { ...card.payload.draft, cases: [
        { id: "case-one", name: "Case one", input: "Original case", expected: "Original expected", required: true }
      ] }
    } } }).isPersisted.promise
    await waitFor(() => document.querySelector('.repository-setup details textarea') !== null)
    const field = (label: string) => [...document.querySelectorAll<HTMLElement>(".repository-setup label")]
      .find(node => node.textContent?.startsWith(label))!.querySelector("textarea")!
    const type = (node: HTMLTextAreaElement, value: string) => {
      node.value = value
      node.dispatchEvent(new Event("input", { bubbles: true }))
    }
    t.holdNextCardWrite()
    type(field("Case"), "New case")
    type(field("Expected"), "New expected")
    t.releaseCardWrite()
    await waitFor(() => t.setup().draft.cases[0]?.expected === "New expected")
    expect(t.setup().draft.cases[0]).toMatchObject({ input: "New case", expected: "New expected", edited: true })
  } finally { t.releaseCardWrite(); await t.close() }
})
