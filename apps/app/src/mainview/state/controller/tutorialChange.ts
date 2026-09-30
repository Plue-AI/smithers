import { Data, Schema } from "effect"
import { Plan } from "../../../../../../flows/coding/schema"
import { decodeChangeReceipt,receiptMatchesPlan,validateTutorialPlan } from "../../cards/tutorial2-agent_change-contract"
import { flag,line,text } from "@smthrs/ui/flow-form"
import { parseRepoSelection, type Card } from "../AppState"
import { gatewayBindingFor, resolveTargetRepo } from "../RepoContext"
import { presentAppFailure } from "./AppFailure"
import type { ControllerContext } from "./context"
import type { FormsController } from "./forms"
import { formRenderedText } from "./forms"
import type { WorkflowController } from "./workflows"

export interface TutorialChangeController {
  readonly suggestTutorialChange: (repo?: string, feature?: string) => Promise<string | { readonly value: string }>
  readonly startTutorialChange: (cardId: string) => Promise<string | { readonly value: string }>
  readonly finishTutorialChange: (cardId: string) => Promise<void>
}

type RunCard = Extract<Card, { kind: "run-trace" }>
/** A refusal this app or the change service already worded for a person. */
class ChangeRefusal extends Data.TaggedError("ChangeRefusal")<{ readonly sentence: string }> {
  constructor(sentence: string) { super({ sentence }) }
  /** The sentence is also the error's message, for diagnostics and thrown-value checks. */
  override get message(): string { return this.sentence }
}
/** What an already-started plan answers: the run it became and where that run stands, never a refusal. */
const startedPlanState = (card: RunCard): string => {
  const started = card.payload.input?.started as { runId?: string } | undefined
  return started?.runId === undefined ? "This plan was already started." : `This plan was already started as run ${started.runId}; its card shows the run.`
}
export const createTutorialChangeController = (ctx: ControllerContext, flows: WorkflowController, nextOrdinal: () => number, renderFlowForm: FormsController["renderFlowForm"]): TutorialChangeController => {
  /** What a person reads: a worded refusal, else the tagged or site sentence, never a raw message. */
  const shown = (error: unknown, subject: string, sentence: string): string => error instanceof ChangeRefusal ? error.sentence
    : presentAppFailure(error, failure => ctx.failures.report("command.boundary", failure, subject), { fault: "bug", sentence, actions: ["retry"] }).sentence
  const post = async (verb: string, input: object) => {
    const response = await ctx.boundedFetch(`${ctx.baseUrl}/api/tutorial/change/${verb}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
    })
    if (!response.ok) throw new ChangeRefusal(await ctx.errorMessageOf(response, "The change service is unavailable."))
    return response.json()
  }
  const suggestTutorialChange: TutorialChangeController["suggestTutorialChange"] = async (repo, feature) => {
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) {
      const form = renderFlowForm({ name: "agent.change", args: feature ? `--feature ${feature}` : undefined,
        via: ctx.commandActor === "smithers" ? "agent" : "user",
        input: Schema.Struct({ repo: Schema.String, feature: Schema.optional(Schema.String) }),
        hints: { fields: { repo: { optionsFrom: "cloud-repos" } }, args: payload => line(text(payload, "repo"), flag(payload, "feature")) } })
      return form ? { value: formRenderedText(form.missing) } : target.error
    }
    const scope = ctx.store.session()
    const actor = ctx.commandActor
    const accountEpoch = ctx.accountEpoch
    const accountLogin = ctx.accountOwner() ?? null
    try {
      const plan = validateTutorialPlan(Schema.decodeUnknownSync(Plan)(await post("plan", { repo: target.repo, feature })))
      if (ctx.store.session().activeRepoKey !== scope.activeRepoKey || ctx.accountEpoch !== accountEpoch) return "The repository changed; request a new plan."
      const id = `tutorial-change-plan-${crypto.randomUUID()}`
      await ctx.store.dispatch({ type: "card.upsert", actor, card: {
        id, kind: "run-trace", title: plan.changes[0]!.title, status: "active", createdAt: Date.now(), ordinal: nextOrdinal(),
        payload: { repo: target.repo, runId: id, workflow: "tutorial-change", kind: "change-plan", phase: "completed", steps: [], result: null, lastSeq: 0,
          input: { plan, tutorialScope: { repoKey: scope.activeRepoKey, accountLogin } } }
      } }).isPersisted.promise
      return { value: `Review the suggested feature and planned commit in ${id}.` }
    } catch (error) { return shown(error, "agent.change", "The change could not be planned. Not your fault.") }
  }
  const startFailure = "The change could not be started. Not your fault."
  const startTutorialChange: TutorialChangeController["startTutorialChange"] = async cardId => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card?.kind !== "run-trace" || card.payload.kind !== "change-plan") return "This plan is no longer available to start."
    if (card.status !== "active") return { value: startedPlanState(card) }
    const guard = flows.workflowIdentityGuard() ?? flows.workflowBalanceGuard()
    if (guard) return guard
    try {
      const plan = validateTutorialPlan(Schema.decodeUnknownSync(Plan)(card.payload.input?.plan))
      const scope = card.payload.input?.tutorialScope as { repoKey?: string; accountLogin?: string | null } | undefined
      const session = ctx.store.session()
      const pickedSameRepo = (scope?.repoKey == null || scope.repoKey === card.payload.repo)
        && parseRepoSelection(session.activeRepoKey ?? "")?.repoId === card.payload.repo
      if (!scope || (scope.repoKey !== session.activeRepoKey && !pickedSameRepo) || scope.accountLogin !== (ctx.accountOwner() ?? null)) return "The repository or account changed; request a new plan."
      const prerequisite = flows.requireBox(card.payload.repo, { flow: "agent.change.start", args: cardId }, `Open a box to start the change in ${card.payload.repo}`)
      if (prerequisite !== undefined) return prerequisite
      const binding = gatewayBindingFor(ctx.store, card.payload.repo)
      if ("error" in binding) return binding.error
      // Consume before awaiting the seam: concurrent activation cannot execute twice.
      const { error: _stale, ...payload } = card.payload
      await ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: { ...card, status: "acted", payload } }).isPersisted.promise
      try {
        await post("preflight", { repo: card.payload.repo, plan })
        const provisioned = await flows.provisionWorkspace(card.payload.repo, binding)
        if (provisioned !== true) throw new ChangeRefusal(provisioned)
        const launched = await flows.launchWorkflow({ repo: card.payload.repo, workflow: "tutorial-change", title: plan.changes[0]!.title, binding,
          kind: "change", input: { ...card.payload.input, plan } })
        if ("message" in launched) throw new ChangeRefusal(launched.message)
        const runCard = [...ctx.store.collections.cards.values()].find(candidate =>
          candidate.kind === "run-trace" && candidate.payload.runId === launched.runId && candidate.payload.repo === card.payload.repo)
        const current = ctx.store.collections.cards.get(cardId)
        if (current?.kind === "run-trace") await ctx.store.dispatch({ type: "card.updated", actor: "system", id: cardId, patch: { payload: {
          ...current.payload, input: { ...current.payload.input, started: { runId: launched.runId, ...(runCard === undefined ? {} : { cardId: runCard.id }) } } } } }).isPersisted.promise
        return { value: `Started change run ${launched.runId}.` }
      } catch (error) {
        // Nothing launched: the plan keeps its door, and the card says why the start stopped.
        const message = shown(error, cardId, startFailure)
        const current = ctx.store.collections.cards.get(cardId)
        if (current?.kind === "run-trace" && current.payload.input?.started === undefined) {
          await ctx.store.dispatch({ type: "card.updated", actor: "system", id: cardId, patch: { status: "active", payload: { ...current.payload, error: message } } }).isPersisted.promise
        }
        throw new ChangeRefusal(message)
      }
    } catch (error) { return shown(error, cardId, startFailure) }
  }
  const finishTutorialChange: TutorialChangeController["finishTutorialChange"] = async cardId => {
    const card = ctx.store.collections.cards.get(cardId)
    if (card?.kind !== "run-trace" || card.payload.kind !== "change" || card.payload.phase !== "completed") return
    try {
      const plan = validateTutorialPlan(Schema.decodeUnknownSync(Plan)(card.payload.input?.plan))
      const receipt = decodeChangeReceipt(await post("receipt", { repo: card.payload.repo, runId: card.payload.runId, plan }))
      if (!receiptMatchesPlan(receipt, plan, card.payload.repo, card.payload.runId)) throw new ChangeRefusal("The commit does not match the captured HEAD.")
      const current = ctx.store.collections.cards.get(cardId)
      if (current?.kind !== "run-trace" || current.payload.phase !== "completed") return
      await ctx.store.dispatch({ type: "card.updated", actor: "system", id: cardId,
        patch: { payload: { ...current.payload, input: { ...current.payload.input, tutorialReceipt: receipt } } } }).isPersisted.promise
    } catch (error) {
      const current = ctx.store.collections.cards.get(cardId)
      if (current?.kind === "run-trace") ctx.store.dispatch({ type: "card.updated", actor: "system", id: cardId,
        patch: { payload: { ...current.payload, error: shown(error, cardId, "The change could not be confirmed. Not your fault.") } } })
    }
  }

  return { suggestTutorialChange, startTutorialChange, finishTutorialChange }
}
