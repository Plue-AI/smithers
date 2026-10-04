import { describe, expect, test } from "bun:test"
import { ALICE, BEN, createDesignWorld, MAYA } from "./index"
import { actCard, designActCard, designMergeCard, designPlainTurn, designTurn, mergeCard, THEME_FLOW } from "./chat"

const world = () => createDesignWorld({ timers: { set: () => 0, clear: () => {} }, viewer: BEN }).world()

describe("the app agent reads plain prompts (mvp.md Appendix B)", () => {
  test("a read opens the card and says nothing", () => {
    expect(designTurn(world(), BEN, "who's on retry-webhooks?")).toEqual({ run: [{ name: "branch", payload: { name: "b-retry" } }] })
    expect(designTurn(world(), BEN, "who is on T10")).toEqual({ run: [{ name: "branch", payload: { name: "b-checkout" } }] })
  })

  test("the person's own screen changes at once, in their name", () => {
    expect(designTurn(world(), BEN, "switch to dark mode")).toEqual({ run: [{ name: THEME_FLOW, payload: { mode: "dark" } }], reply: "Changed Ben's theme to dark." })
    expect(designTurn(world(), MAYA, "toggle the theme")).toEqual({ run: [{ name: THEME_FLOW, payload: {} }], reply: "Changed Maya's theme." })
  })

  test("a question gets one line, the context it rests on, and the lines it rests on", () => {
    const turn = designTurn(world(), BEN, "why is the checkout test flaky?")
    expect(turn?.reply).toBe("It checks the status before the payment intent settles.")
    expect(turn?.run).toEqual([{ name: "file", payload: { path: "src/checkout/checkout.test.ts", branch: "b-checkout", line: 6 } }])
    expect(turn?.context?.map(item => [item.kind, item.label])).toEqual([["file", "checkout.test.ts"], ["page", "wiki: Payments testing"], ["run", "T10 run"]])
  })

  test("wiki writes and drafts run at once; a draft is not a confirmation", () => {
    expect(designTurn(world(), BEN, "save that to the wiki")?.wiki?.title).toBe("Checkout test race")
    const draft = designTurn(world(), BEN, "make that a TODO")
    expect(draft?.run.map(step => step.name)).toEqual(["todo.new"])
    expect(draft?.ask).toBeUndefined()
  })

  test("stop runs at once and the reply is its receipt", () => {
    expect(designTurn(world(), BEN, "stop the checkout TODO")).toEqual({
      run: [{ name: "todo.stop", payload: { n: 10 } }, { name: "todo", payload: { n: 10 } }], reply: "Stopped T10."
    })
    expect(designTurn(world(), BEN, "resume T10")?.run[0]).toEqual({ name: "todo.resume", payload: { n: 10 } })
  })

  test("drop and review ask first: exactly what will run, for the person to press", () => {
    expect(designTurn(world(), BEN, "drop T11")).toEqual({ run: [], ask: {
      verb: "Drop", target: "T11 log-retries", receipt: "Dropped T11", todo: "t-log", tag: "todo.drop", args: { n: 11 }
    } })
    expect(designTurn(world(), BEN, "review this branch", "b-retry")?.ask).toEqual({
      verb: "Run review", target: "on retry-webhooks", text: "/review retry-webhooks", receipt: "Review ran on retry-webhooks", tag: "review", args: { branch: "b-retry" }
    })
    // In main there is no branch to review.
    expect(designTurn(world(), BEN, "review this branch")).toBeUndefined()
  })

  test("merge opens the person's own Review & merge; the agent never merges", () => {
    expect(designTurn(world(), BEN, "merge #88")).toEqual({ run: [], merge: "t-stripe" })
    expect(designTurn(world(), BEN, "merge T8")).toEqual({ run: [], merge: "t-stripe" })
  })

  test("a prompt it has no reading for takes the real turn", () => {
    expect(designTurn(world(), BEN, "tell me a joke")).toBeUndefined()
    expect(designTurn(world(), BEN, "drop T99")).toBeUndefined()
  })

  test("without an agent provider, an unscripted prompt answers from the seed", () => {
    const joke = designPlainTurn(world(), "tell me a joke")
    expect(joke.run).toEqual([])
    expect(joke.reply).toMatch(/^On main: \d+ working, \d+ need you, \d+ in review, \d+ queued\.$/)
    const waiting = designPlainTurn(world(), "Why is T9 waiting?")
    expect(waiting.run).toEqual([{ name: "todo", payload: { n: 9 } }])
    expect(waiting.reply).toMatch(/^T9 /)
    expect(waiting.context).toEqual([{ kind: "todo", label: "T9 Retry failed webhooks with backoff", ref: "t-retry" }])
  })
})

describe("A✓ and Review & merge as ConfirmView models", () => {
  test("an asked act is one_click with its own flow as the primary and Cancel bound to its id", () => {
    const design = createDesignWorld({ timers: { set: () => 0, clear: () => {} }, viewer: BEN })
    const asked = design.ask({ by: BEN, verb: "Drop", target: "T11 log-retries", receipt: "Dropped T11", todo: "t-log", tag: "todo.drop", args: { n: 11 } })
    const act = design.row("acts", asked.ok ? asked.id! : "")!
    const { model, actions } = designActCard(design.world(), act)
    expect(model.kind).toBe("one_click")
    expect(model.action).toEqual({ tag: "todo.drop", verb: "Drop" })
    expect(model.summary).toBe("Drop T11 log-retries")
    expect(model.subject).toEqual({ kind: "todo", ref: "T11" })
    expect(model.asked_by.kind).toBe("agent")
    expect(model.receipt).toBeUndefined()
    expect(actions.map((action): [string, boolean, unknown] => [action.tag, action.primary === true, action.command_input])).toEqual([
      ["todo.drop", true, { n: 11 }],
      ["confirm.cancel", false, { confirmation: act.id, revision: act.id }]
    ])
    const card = actCard(act)
    expect(card).toMatchObject({ id: `design:confirm:act:${act.id}`, kind: "confirm", title: "Drop T11 log-retries?", payload: { id: `act:${act.id}` }, audience_member_id: "design:ben" })
  })

  test("pressed, the card is its receipt with no buttons; cancelled, it says so", () => {
    const design = createDesignWorld({ timers: { set: () => 0, clear: () => {} }, viewer: BEN })
    const asked = design.ask({ by: BEN, verb: "Drop", target: "T11 log-retries", receipt: "Dropped T11", todo: "t-log", tag: "todo.drop", args: { n: 11 } })
    const id = asked.ok ? asked.id! : ""
    design.patch("acts", id, current => ({ ...current, state: "done" }))
    const done = designActCard(design.world(), design.row("acts", id)!)
    expect(done.model.receipt).toMatchObject({ result: "done", text: "Dropped T11", by: { login: "benortiz" } })
    expect(done.actions).toEqual([])
    design.cancelAct(id, BEN)
    expect(design.row("acts", id)?.state).toBe("done")
    design.patch("acts", id, current => ({ ...current, state: "cancelled" }))
    expect(designActCard(design.world(), design.row("acts", id)!).model.receipt?.result).toBe("cancelled")
  })

  test("Review & merge binds Merge to the reviewed revision; a member reads the reason instead", () => {
    const rows = world()
    const todo = rows.todos.find(each => each.id === "t-stripe")!
    const owner = designMergeCard(rows, todo, MAYA)!
    expect(owner.model.kind).toBe("review_merge")
    expect(owner.model.review?.pr.number).toBe(88)
    const merge = owner.actions.find(action => action.tag === "merge")
    expect(merge?.primary).toBe(true)
    expect(merge?.command_input).toMatchObject({ n: 8, reviewed_head_sha: owner.model.subject.revision })
    expect(owner.actions.find(action => action.tag === "confirm.cancel")?.command_input).toEqual({ confirmation: "merge:t-stripe", revision: owner.model.subject.revision! })
    const member = designMergeCard(rows, todo, ALICE)!
    expect(member.actions.find(action => action.tag === "merge")?.disabled).toEqual({ reason: "A maintainer merges" })
    expect(mergeCard(todo, MAYA)).toMatchObject({ id: "design:confirm:merge:t-stripe", payload: { id: "merge:t-stripe" }, audience_member_id: "design:maya" })
  })
})
