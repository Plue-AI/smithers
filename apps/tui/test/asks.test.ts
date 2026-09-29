import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import * as Asks from "../src/asks.ts"
import type { Tab } from "../src/workspace.ts"

const tab = (id: string, status: Tab["status"], parent?: string): Tab => ({
  id,
  title: id,
  prompt: id,
  depth: 1,
  seat: "openai:gpt-6-sol",
  file: `/tmp/${id}.jsonl`,
  status,
  startedAt: 0,
  ...(parent === undefined ? {} : { parent })
})
const setup = (tabs: Array<Tab>) => {
  const steered: Array<[string, string]> = []
  const asks = new Asks.Asks({
    tab: (id) => tabs.find((each) => each.id === id),
    tell: (id, text) => {
      steered.push([id, text])
      return true
    },
    changed: () => {}
  })
  const set = (id: string, status: Tab["status"]) => {
    const at = tabs.findIndex((each) => each.id === id)
    tabs[at] = { ...tabs[at]!, status }
    asks.check()
  }
  return { asks, steered, set, tabs }
}

describe("ctx.help asks", () => {
  it("goes to a running parent, which answers it with agent.answer", async () => {
    const { asks, steered, tabs } = setup([tab("plan", "running"), tab("impl", "running", "plan")])
    const answer = asks.ask(tabs[1]!, { question: "Cookie or bearer?", options: ["cookie", "bearer"] })
    const [open] = asks.list()
    expect(open).toMatchObject({ from: "impl", holder: "plan", frames: -1, returned: false })
    expect(open!.id).toMatch(/^ask-[0-9a-f]{8}$/)
    expect(steered).toEqual([[
      "plan",
      `Child "impl" asks (${open!.id}): Cookie or bearer? Options: cookie | bearer. Answer with agent.answer({id: "${
        open!.id
      }", answer}). Unanswered after 3 of your frames it goes up.`
    ]])
    expect(asks.answer(open!.id, "cookie", "someone-else")).toBe(false)
    expect(asks.answer(open!.id, "cookie", "plan")).toBe(true)
    expect(await answer).toBe("cookie")
    expect(asks.list()).toEqual([])
  })

  it("goes to the person from a top-level worker or with to: person", async () => {
    const { asks, tabs } = setup([tab("plan", "running"), tab("impl", "running", "plan")])
    void asks.ask(tabs[0]!, { question: "a?" })
    void asks.ask(tabs[1]!, { question: "b?", to: "person" })
    expect(asks.list().map((ask) => ask.holder)).toEqual([Asks.person, Asks.person])
    expect(asks.fromPerson("impl")?.question).toBe("b?")
  })

  it("moves one level up after three frames that could read it, and past the root to the person", () => {
    const { asks, steered, tabs } = setup([
      tab("root", "running"),
      tab("plan", "running", "root"),
      tab("impl", "running", "plan")
    ])
    void asks.ask(tabs[2]!, { question: "q?" })
    // The frame running when it was told settles before reading it.
    for (let frame = 0; frame < Asks.escalateAfter; frame++) asks.frame("plan")
    expect(asks.list()[0]!.holder).toBe("plan")
    asks.frame("plan")
    expect(asks.list()[0]).toMatchObject({ holder: "root", trail: ["plan", "root"], frames: -1 })
    expect(steered.map(([id]) => id)).toEqual(["plan", "root"])
    for (let frame = 0; frame <= Asks.escalateAfter; frame++) asks.frame("root")
    expect(asks.list()[0]).toMatchObject({ holder: Asks.person, trail: ["plan", "root", Asks.person] })
  })

  it("skips a holder that cannot answer, at once", () => {
    const { asks, set, tabs } = setup([
      tab("root", "running"),
      tab("plan", "parked", "root"),
      tab("impl", "running", "plan")
    ])
    void asks.ask(tabs[2]!, { question: "q?" })
    expect(asks.list()[0]!.holder).toBe("root")
    set("root", "done")
    expect(asks.list()[0]!.holder).toBe(Asks.person)
  })

  it("hands a waiting parent its ask once, through take, and moves it up if the parent waits again", () => {
    const { asks, steered, tabs } = setup([tab("plan", "waiting"), tab("impl", "running", "plan")])
    void asks.ask(tabs[1]!, { question: "q?" })
    expect(steered).toEqual([])
    expect(asks.waiting("plan")).toBe(true)
    expect(asks.take("plan").map((ask) => ask.question)).toEqual(["q?"])
    expect(asks.waiting("plan")).toBe(false)
    expect(asks.take("plan")).toEqual([])
    asks.waited("plan")
    expect(asks.list()[0]!.holder).toBe(Asks.person)
  })

  it("passes over an agent blocked in an ask of its own", () => {
    const { asks, tabs } = setup([
      tab("root", "running"),
      tab("plan", "waiting", "root"),
      tab("impl", "running", "plan")
    ])
    void asks.ask(tabs[1]!, { question: "mine?" })
    void asks.ask(tabs[2]!, { question: "yours?" })
    expect(asks.list().map((ask) => [ask.from, ask.holder])).toEqual([["plan", "root"], ["impl", "root"]])
  })

  it("withdraws an ask when the asker stops", async () => {
    const { asks, tabs } = setup([tab("impl", "running")])
    const controller = new AbortController()
    const answer = asks.ask(tabs[0]!, { question: "q?" }, controller.signal)
    controller.abort()
    await expect(answer).rejects.toThrow("Ask withdrawn")
    expect(asks.list()).toEqual([])
  })

  it("builds a choice form from options, else a free-text one", () => {
    const choice = Asks.schema({ options: ["a", "b"] })
    const text = Asks.schema({})
    expect(Schema.is(choice)({ answer: "a" })).toBe(true)
    expect(Schema.is(choice)({ answer: "c" })).toBe(false)
    expect(Schema.is(text)({ answer: "anything" })).toBe(true)
    expect(Schema.is(text)({ answer: "" })).toBe(false)
  })
})
