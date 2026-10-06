import { stubCommandActions } from "../../flows/StubCommandActions"
import { describe, expect, test } from "bun:test"
import { createCommandRegistry } from "../../flows/Commands"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import { createFormsController } from "./forms"

/*
 * Focus is the human's gesture (THE THREE-DOOR LAW's `userOnly` reason), so
 * it is never a journal transition and never in the card payload. The
 * controller records the one form the human's own invocation just rendered;
 * the card claims it once (cards/FlowFormCards.tsx). An agent's form, a form
 * the agent principal rendered, and a restored form never hold one.
 */

const fixture = (commandActor: "user" | "smithers") => {
  const cards = new Map<string, Card>()
  const store = {
    session: () => ({ activeRepoKey: null }),
    collections: { cards, repositories: new Map(), workingCopies: new Map(), harnesses: new Map() },
    dispatch: (event: { type: string; card?: Card }) => {
      if (event.type === "card.upsert") cards.set(event.card!.id, event.card!)
      return { isPersisted: { promise: Promise.resolve() } }
    }
  }
  const actions = stubCommandActions({
    repositoryFlows: () => undefined,
    knownRepositories: () => new Set<string>(),
    noteCommandRun: () => {},
    traceFlow: () => {},
    snapshot: () => ({ surface: "chat", typing: false, hasConnectors: true, admin: false, signedOut: false })
  })
  const commands = createCommandRegistry(actions)
  const context = { store, commands, commandActor } as unknown as ControllerContext
  return { forms: createFormsController(context, { nextOrdinal: () => 1 }), cards }
}

describe("the form focus handoff", () => {
  test("the human's own slash without its input records the form for focus; the card claims it exactly once", () => {
    const { forms } = fixture("user")
    const rendered = forms.renderFlowForm({ name: "browser.open", args: undefined, via: "user" })!
    expect(rendered.missing).toEqual(["url"])
    expect(forms.focusHandoff.take("form-something-else")).toBe(false)
    expect(forms.focusHandoff.take(rendered.cardId)).toBe(true)
    expect(forms.focusHandoff.take(rendered.cardId)).toBe(false)
  })

  test("a newer request replaces the pending one; an agent's form or the agent principal never records one", () => {
    const user = fixture("user")
    const first = user.forms.renderFlowForm({ name: "browser.open", args: undefined, via: "user" })!
    const second = user.forms.renderFlowForm({ name: "wiki.new-note", args: undefined, via: "user" }) ?? user.forms.renderFlowForm({ name: "browser.open", args: undefined, via: "user", cardId: "form-second" })!
    expect(user.forms.focusHandoff.take(first.cardId)).toBe(second.cardId === first.cardId)
    expect(user.forms.focusHandoff.take(second.cardId)).toBe(second.cardId !== first.cardId)
    const viaAgent = user.forms.renderFlowForm({ name: "browser.open", args: undefined, via: "agent" })!
    expect(user.forms.focusHandoff.take(viaAgent.cardId)).toBe(false)
    const agent = fixture("smithers")
    const asAgent = agent.forms.renderFlowForm({ name: "browser.open", args: undefined, via: "user" })!
    expect(agent.forms.focusHandoff.take(asAgent.cardId)).toBe(false)
  })

  test("a form re-rendered while it is being submitted keeps the keyboard where it is", async () => {
    const { forms, cards } = fixture("user")
    const rendered = forms.renderFlowForm({ name: "browser.open", args: undefined, via: "user" })!
    expect(forms.focusHandoff.take(rendered.cardId)).toBe(true)
    const card = cards.get(rendered.cardId)!
    cards.set(card.id, { ...card, payload: { ...(card as Extract<Card, { kind: "flow-form" }>).payload, submitting: true } } as Card)
    forms.renderFlowForm({ name: "browser.open", args: undefined, via: "user" })
    expect(forms.focusHandoff.take(rendered.cardId)).toBe(false)
  })
})
