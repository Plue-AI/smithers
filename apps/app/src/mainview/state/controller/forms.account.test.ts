import { expect, test } from "bun:test"
import { createCommandRegistry, type CommandOutcome } from "../../flows/Commands"
import type { CommandActions } from "../../flows/Flows"
import { createAppStore } from "../AppStore"
import { memoryStorage, settle, unavailableAgent, waitFor } from "../TestFixtures"
import { createControllerContext } from "./context"
import { createFormsController } from "./forms"

/*
 * Sign-out forgets every card, form drafts included. A submission still in
 * flight when the account ends belongs to that account: its settlement writes
 * nothing, so the form and its private draft never return to the next session.
 */
const fixture = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will",
    admin: false, scopesPlain: null }).isPersisted.promise
  const ctx = createControllerContext(store, unavailableAgent, {})
  const actions = {
    repositoryFlows: () => undefined,
    knownRepositories: () => new Set<string>(),
    noteCommandRun: () => {},
    traceFlow: () => {},
    snapshot: () => ({ surface: "chat", typing: false, hasConnectors: true, admin: false, signedOut: false })
  } satisfies Partial<CommandActions>
  const registry = createCommandRegistry(actions as unknown as CommandActions)
  const answers: Array<(outcome: CommandOutcome) => void> = []
  ctx.commands = { ...registry, submit: () => new Promise<CommandOutcome>(answer => { answers.push(answer) }) }
  const forms = createFormsController(ctx, { nextOrdinal: () => 1 })
  const rendered = forms.renderFlowForm({ name: "browser.open", args: undefined, via: "user" })!
  await forms.setFormField(rendered.cardId, "url", "https://example.com/private")
  return { store, ctx, forms, cardId: rendered.cardId, answers }
}

for (const [name, outcome] of [
  ["runs", { status: "executed", value: "opened" }],
  ["is refused", { status: "failed", error: "The browser is closed." }]
] as const) {
  test(`a submission that ${name} after sign-out leaves the forgotten form forgotten`, async () => {
    const t = await fixture()
    try {
      const submitting = t.forms.submitForm(t.cardId)
      await waitFor(() => t.answers.length === 1)
      await t.store.dispatch({ type: "identity.session.cleared", actor: "user" }).isPersisted.promise
      expect(t.store.collections.cards.has(t.cardId)).toBe(false)
      t.answers[0]!(outcome)
      await submitting
      await settle()
      expect(t.store.collections.cards.has(t.cardId)).toBe(false)
    } finally { await t.ctx.dispose(); await t.store.dispose?.() }
  })
}
