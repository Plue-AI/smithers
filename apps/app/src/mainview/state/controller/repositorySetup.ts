import type { AgentRuntimeSetupDraft } from "@smthrs/rpc/AgentContext"
import {
  REPOSITORY_JOB_TITLES, REPOSITORY_SETUP_API, RepositoryJobSchema, SetupDraftSchema,
  SetupHostInputSchema, SetupOperationResponseSchema, SetupRecoveryResponseSchema, archiveReplacedSetupReceipt, discardSetupDraft, editSetup, initialSetup, reconcileSetupHistory, setupActivationProblems, setupCandidate, storedSetupCandidate,
  type RepositoryJob, type RepositorySetup, type SetupDraft, type SetupManualRequest, type SetupRecoveryResponse
} from "@smthrs/rpc/RepositorySetup"
import { refusalCode } from "@smthrs/rpc/Refusal"
import { accountOwnerOf } from "../AccountOwner"
import type { Card } from "../AppState"
import { actorSharedState } from "../ActorBindings"
import { browserWriteRefusal } from "../BrowserWriteFailure"
import { resolveTargetRepo } from "../RepoContext"
import { setupTrialPr } from "../RepositorySetupTrial"
import { setupFailureSentence } from "../RunFailure"
import type { ControllerContext } from "./context"
import { TOAST_SUPERSEDED } from "./failures"
import { defaultSetupQuestion, repositorySetupGuide, setupGuideQuestions } from "./repositorySetupGuide"

type SetupCard = Extract<Card, { kind: "repository-setup" }>
type Operation = NonNullable<RepositorySetup["request"]>["operation"]
type Result = Promise<string | { value: string } | void>

export interface RepositorySetupController {
  readonly openRepositorySetup: (job: RepositoryJob, repo?: string) => Result
  readonly configureRepositorySetup: (cardId: string, field: string, value: unknown) => Result
  /** Answer the app's own setup question, bound to the candidate it was asked about. */
  readonly answerRepositorySetupQuestion: (cardId: string, questionId: string, revision: number, digest: string, choice: string) => Result
  readonly viewRepositorySetup: (cardId: string, view: RepositorySetup["view"], step?: string) => Result
  readonly prepareRepositoryWork: (cardId: string, stepId: string, field?: "prompt" | "source" | "number", value?: unknown) => Result
  readonly runRepositorySetup: (cardId: string, operation: Operation, manual?: SetupManualRequest) => Result
  /** Ask the human to confirm the discard; the confirmation's own door performs it. */
  readonly askRepositorySetupDiscard: (cardId: string) => Result
  /** Return the candidate to the enabled registration's configuration. */
  readonly discardRepositorySetupDraft: (cardId: string) => Result
  readonly retryRepositorySetup: (cardId: string) => Result
  readonly guideRepositorySetup: (cardId: string) => Result
  readonly resumeRepositorySetups: () => void
}

export interface RepositorySetupDependencies {
  readonly promptSignIn: () => void
  readonly chooseRepository: () => Promise<unknown>
  readonly openRun: (runId: string, repo: string, sourceCard: string) => Promise<unknown>
  readonly send: (text: string, admission: { readonly turnId: string; readonly owner: string }) => Promise<boolean> | void
  readonly guidanceFailed: (error: string, admitted: boolean) => void
}

/** A fresh read for the conversational door, never a second settings authority. */
export const setupGuidance = (card: SetupCard): string => JSON.stringify({
  cardId: card.id, repo: card.payload.repo, job: card.payload.job, revision: card.payload.revision,
  inspectedAt: card.payload.inspectedAt, sources: card.payload.sources, draft: card.payload.draft,
  active: card.payload.active, request: card.payload.request,
  ...repositorySetupGuide(card.payload)
})

/* Every string below is one bounded instruction line: the runtime context takes no CR or LF (packages/rpc/docs/agent-context.md) and the turn pays for these bytes under the chat seam's cap, so a prompt's first sentence names the step and the rest stays behind setup.guide. */
const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

/**
 * The open card's draft as the turn's runtime context carries it: the steps and
 * their modes, one cut line of each prompt, what the job applies to, the time
 * limit and the card's own gate. The held-out eval answers, the full prompts and
 * the repository's source summaries stay behind setup.guide.
 */
export const setupContextSummary = (setup: RepositorySetup): AgentRuntimeSetupDraft => {
  const { draft } = setup
  const gate = setupActivationProblems(setup)[0]
  return {
    steps: draft.steps.map(step => ({ name: oneLine(step.name), mode: step.mode, prompt: oneLine(step.prompt) })),
    replies: draft.replies, landing: draft.landing, budgetMinutes: draft.budgetMinutes,
    ...(setup.job === "issues"
      ? { applyTo: draft.scope === "label" ? oneLine(`issues labeled "${draft.label}"`) : "new and edited issues" }
      : {}),
    ...(setup.job === "chores"
      ? { trigger: oneLine(`${draft.schedule === "" ? "no schedule" : `cron ${draft.schedule} UTC`}, ${
        draft.choreEvent === "push" ? "on push to the default branch"
          : draft.choreEvent === "labeled" ? `on issues labeled "${draft.label}"` : "no repository event"
      }`) }
      : {}),
    ...(gate === undefined ? {} : { gate: oneLine(gate) })
  }
}

const terminal = (phase: string | undefined) => phase !== undefined && ["completed", "failed", "stopped"].includes(phase)

/** The card the app's own setup question lives in, one per setup. */
export const setupQuestionCardId = (cardId: string): string => `form-setup.ask:${cardId}`

/** The operations that submit the candidate the app's first question is about. */
const CANDIDATE_OPERATIONS: ReadonlySet<Operation> = new Set(["evaluate", "trial", "apply"])

const SETUP_QUESTION_GATE = "Answer the setup question first."

/**
 * One setup.configure edit against a draft: the new draft, or the honest
 * refusal. The configure door and the question's answer share this validator,
 * so an answer can never edit anything the user could not edit themselves.
 */
export const applySetupEdit = (
  draft: SetupDraft, job: RepositoryJob, field: string, value: unknown
): { readonly draft: SetupDraft } | { readonly error: string } => {
  const pieces = field.split(".")
  if (field === "replies" && value === "automatic") return { error: "Automatic replies are not available in this setup." }
  let next = { ...draft }
  if (field === "trial.source" || field === "trial.number") {
    if (job !== "review" && job !== "ci") return { error: "This trial does not select a PR." }
    const subject = setupTrialPr(next.trialBody)
    if (field === "trial.source") {
      if (value !== "github" && value !== "smithers-cloud") return { error: "Choose the PR source." }
      subject.source = value
    } else if (value === null || value === "") delete subject.number
    else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) subject.number = value
    else return { error: "Choose a valid PR number." }
    next = { ...next, trialBody: JSON.stringify(subject) }
  } else if (pieces[0] === "step" && pieces.length === 3 && ["mode", "prompt"].includes(pieces[2]!)) {
    if (!next.steps.some(step => step.id === pieces[1])) return { error: "That flow is not in this setup." }
    next = { ...next, steps: next.steps.map(step => step.id === pieces[1] ? { ...step, [pieces[2]!]: value } : step) }
  } else if (field === "checks.add") {
    next = { ...next, checks: [...next.checks, value as SetupDraft["checks"][number]] }
  } else if (field === "checks.remove") {
    if (typeof value !== "string" || !next.checks.some(check => check.id === value)) return { error: "That check is not in this setup." }
    next = { ...next, checks: next.checks.filter(check => check.id !== value) }
  } else if (field.startsWith("check.")) {
    const match = /^check\.(.+)\.(name|rule|paths|policy)$/.exec(field)
    if (!match || !next.checks.some(check => check.id === match[1])) return { error: "That check is not in this setup." }
    next = { ...next, checks: next.checks.map(check => check.id === match[1] ? { ...check, [match[2]!]: value } : check) }
  } else if (field.startsWith("case.")) {
    const match = /^case\.(.+)\.(input|expected)$/.exec(field)
    if (!match || !next.cases.some(test => test.id === match[1])) return { error: "That case is not in this setup." }
    next = { ...next, cases: next.cases.map(test => test.id === match[1] ? { ...test, [match[2]!]: value, edited: true } : test) }
  } else if (pieces.length === 1 && Object.prototype.hasOwnProperty.call(next, field)) {
    next = { ...next, [field]: value }
  } else return { error: "That setting cannot be edited." }
  const parsed = SetupDraftSchema.safeParse(next)
  if (!parsed.success) return { error: "The setting does not match the expected value." }
  // A case this write changed is the maintainer's, pin included; the next
  // inspection re-pins only the cases it wrote itself.
  if (field !== "cases") return { draft: parsed.data }
  return { draft: { ...parsed.data, cases: parsed.data.cases.map(test => {
    const prior = draft.cases.find(item => item.id === test.id)
    return prior && prior.input === test.input && prior.expected === test.expected ? test : { ...test, edited: true }
  }) } }
}

/**
 * Recover input and evidence independently of current backend policy.
 * `liveWorkspaces` is the ids this repository's loaded workspaces hold; an
 * unloaded collection names none, and the pin then moves on host evidence alone.
 */
export function projectRecoveredSetup(current: RepositorySetup, recovered: SetupRecoveryResponse, liveWorkspaces?: ReadonlySet<string>): RepositorySetup {
  // The host names the account by its username, which is the GitHub login in
  // whatever case GitHub first reported it.
  if (current.owner === null || recovered.owner.toLowerCase() !== current.owner.toLowerCase()) throw Error("The recovered setup belongs to a different account.")
  if (recovered.repo !== current.repo || recovered.job !== current.job || !current.recovery) throw Error("The recovered setup belongs to another repository.")
  const unchanged = current.recovery.adoptDraft === true && current.revision === current.recovery.baseRevision && setupCandidate(current) === current.recovery.baseDigest
  let next = { ...current }
  const { registration, setup } = recovered
  const policy = registration.state === "known" ? registration.active ?? registration.trial : undefined
  // A pin those workspaces still list is the live one and nothing moves it. A
  // pin they do not list is spent, and so is one the host itself replaced on
  // the request that carried it — `binding ?? workspaceId` is its later word.
  const pinned = current.workspaceId
  const spent = pinned === undefined || liveWorkspaces === undefined || !liveWorkspaces.has(pinned)
  const supersedes = (candidate: string | undefined, replaced = false): candidate is string =>
    candidate !== undefined && candidate !== pinned && (spent || replaced)
  if (setup.state === "found") {
    const { input, result } = setup, receipt = result.receipt
    if (input.repo !== current.repo || input.job !== current.job || !storedSetupCandidate(input, input.digest)
      || result.requestId !== input.requestId || result.revision !== input.revision || result.digest !== input.digest
      || !receipt || receipt.requestId !== input.requestId || receipt.revision !== input.revision || receipt.digest !== input.digest || receipt.operation !== input.operation
      || (receipt.phase === "completed" && (!receipt.runId || (input.operation === "run" && !receipt.jobRunId)))
      || (result.inspection && (input.operation !== "inspect" || receipt.phase !== "completed"))) throw Error("The recovered receipt does not match its setup request.")
    if (unchanged) next = { ...next, draft: input.draft, revision: input.revision }
    if (result.workspaceId !== undefined && pinned !== undefined && result.workspaceId !== pinned
      && policy?.owned === false && policy.workspaceId === result.workspaceId) throw Error("The recovered setup belongs to another workspace.")
    next = archiveReplacedSetupReceipt(next, receipt)
    next = { ...next, ...(supersedes(result.workspaceId, input.workspaceId === pinned) ? { workspaceId: result.workspaceId } : {}), receipt }
    // A settled failure is recorded evidence whether the app watched it or read
    // it back here, so the next attempt is a new request, not a replay.
    if (terminal(receipt.phase) && receipt.phase !== "completed") next = { ...next,
      previousReceipts: [...next.previousReceipts.filter(item => item.requestId !== receipt.requestId), receipt].slice(-50) }
    if (result.inspection) {
      if (unchanged) next = editSetup(next, result.inspection.suggestedDraft)
      next = { ...next, sources: result.inspection.sources, inspectedAt: result.inspection.inspectedAt }
    }
    next = { ...next, request: { id: input.requestId, operation: input.operation, revision: input.revision, digest: input.digest,
      state: terminal(receipt.phase) ? receipt.phase === "completed" ? "completed" : "failed" : "running",
      observeOnly: true, ...(input.manual ? { manual: input.manual } : {}), ...(receipt.error ? { error: receipt.error } : {}) } }
    if (input.operation === "evaluate") next.evaluation = receipt
    if (input.operation === "trial") next.trial = receipt
    if (!terminal(receipt.phase) && !receipt.runId) next.request = { ...next.request!, state: "failed",
      error: "The previous setup has no recorded run to reconnect. Its execution state is unknown." }
  }
  if (policy && unchanged && (setup.state !== "found" || policy.revision > next.revision)) {
    next = { ...next, draft: policy.draft, revision: policy.revision,
      ...(policy.owned && !next.workspaceId ? { workspaceId: policy.workspaceId } : {}) }
  }
  // Cloud binds one repository-jobs workspace per person and repository, so an
  // owned registration on a spent pin means that pin was replaced. Follow it;
  // a recovered result names the newer binding and keeps its own.
  if (policy?.owned && next.workspaceId && supersedes(policy.workspaceId)
    && (setup.state !== "found" || setup.result.workspaceId === undefined)) next = { ...next, workspaceId: policy.workspaceId }
  if (registration.state === "known") {
    const active = registration.active
    next.active = active ? { revision: active.revision, digest: active.digest, registrationId: active.registrationId,
      sourceRevision: active.sourceRevision, enabled: active.enabled, owned: active.owned, draft: active.draft,
      ...(active.enabled && active.schedule ? { schedule: active.schedule } : {}) } : undefined
    if (active && next.revision <= active.revision && (!active.enabled || !storedSetupCandidate(next, active.digest))) {
      const { evaluation, trial, ...rest } = next
      next = { ...rest, revision: active.revision + 1, previousReceipts: [...new Map([...rest.previousReceipts, ...[evaluation, trial].filter(item => item !== undefined)]
        .map(item => [item.requestId, item])).values()].slice(-50) }
    }
  }
  const error = registration.state === "unavailable" ? registration.error : setup.state === "unavailable" ? setup.error : undefined
  next.recovery = { ...current.recovery, state: error ? "failed" : "completed", registrationState: registration.state,
    ...(setup.state === "found" ? { adoptDraft: false } : {}),
    ...(error ? { error } : { error: undefined }), ...(registration.state === "known" ? { trialRegistration: registration.trial } : {}) }
  return reconcileSetupHistory(next)
}

/** The card is durable before any request starts; the background task owns launch and observation. */
export function createRepositorySetupController(ctx: ControllerContext, dependencies?: RepositorySetupDependencies): RepositorySetupController {
  const shared = actorSharedState(ctx, "repository-setup", () => ({
    pending: new Map<string, Promise<unknown>>(), sleepers: new Map<ReturnType<typeof setTimeout>, () => void>(),
    recovering: new Map<string, Promise<unknown>>(), resumed: new Set<string>(), openingRuns: new Set<string>(), edits: new Map<string, Promise<unknown>>(),
    guidanceQueued: false, guiding: false, guidanceFailures: new Set<string>(), spentRequests: new Set<string>(),
    scheduleTimers: new Map<string, { timer: ReturnType<typeof setTimeout>; at: number; login: string | null; accountEpoch: number; registrationId: string }>(),
    expiredSchedules: new Map<string, { login: string | null; accountEpoch: number }>(), disposed: false
  }))
  ctx.onDispose(() => {
    shared.disposed = true
    for (const [timer, wake] of shared.sleepers) { clearTimeout(timer); wake() }
    shared.sleepers.clear()
    for (const { timer } of shared.scheduleTimers.values()) clearTimeout(timer)
    shared.scheduleTimers.clear(); shared.expiredSchedules.clear()
  })
  const get = (id: string): SetupCard | undefined => {
    const card = ctx.store.collections.cards.get(id)
    return card?.kind === "repository-setup" ? card : undefined
  }
  const owner = (): string | null => accountOwnerOf(ctx.store.collections.identitySessions.get("identity")) ?? null
  const epoch = () => ctx.accountEpoch ?? 0
  /**
   * The pin a new request may carry. A workspace this repository's loaded
   * collection no longer lists is gone, and sending it runs the work somewhere
   * else under a name that no longer resolves; the host allocates the box
   * instead, exactly as it does for a first setup. An unloaded collection lists
   * none and contradicts nothing, so the pin stands.
   */
  const livePin = (payload: RepositorySetup): string | undefined => {
    const pin = payload.workspaceId
    const loaded = [...ctx.store.collections.cloudWorkspaces.values()].filter(workspace => workspace.repoId === payload.repo)
    return pin === undefined || !loaded.length || loaded.some(workspace => workspace.id === pin) ? pin : undefined
  }
  const scheduleRefresh = (card: SetupCard) => {
    const prior = shared.scheduleTimers.get(card.id), active = card.payload.active, schedule = active?.schedule
    const login = card.payload.owner, accountEpoch = epoch()
    const at = card.payload.job === "chores" && active?.enabled && schedule?.expression === card.payload.draft.schedule
      && card.payload.recovery?.registrationState === "known" && owner() === login ? Date.parse(schedule.nextFireAt) : 0
    if (prior?.at === at && prior.login === login && prior.accountEpoch === accountEpoch && prior.registrationId === active?.registrationId) return
    if (prior) clearTimeout(prior.timer)
    shared.scheduleTimers.delete(card.id)
    if (ctx.disposed || shared.disposed || at <= Date.now()) return
    const timer = setTimeout(() => {
      if (shared.scheduleTimers.get(card.id)?.timer !== timer) return
      clearTimeout(timer); shared.scheduleTimers.delete(card.id)
      if (ctx.disposed || shared.disposed || owner() !== login || epoch() !== accountEpoch) return
      const latest = get(card.id)
      if (!latest || latest.payload.owner !== login || latest.payload.active?.registrationId !== active!.registrationId || latest.payload.active.schedule?.nextFireAt !== schedule!.nextFireAt) return
      if (at > Date.now()) { scheduleRefresh(latest); return }
      // Expire this observation, never advance the schedule in the browser.
      // A busy operation keeps its own admission; refresh after it settles.
      void Promise.resolve(edit(card.id, async () => {
        const current = get(card.id)
        if (ctx.disposed || shared.disposed || owner() !== login || epoch() !== accountEpoch || current?.payload.active?.schedule?.nextFireAt !== schedule!.nextFireAt) return
        await upsert({ ...current, payload: { ...current.payload, active: { ...current.payload.active!, schedule: undefined } } }, "system")
        if (ctx.disposed || shared.disposed || owner() !== login || epoch() !== accountEpoch) return
        if (["requested", "running"].includes(get(card.id)?.payload.request?.state ?? "")) shared.expiredSchedules.set(card.id, { login, accountEpoch })
        else void requestRecovery(card.id)
      })).catch(error => ctx.failures.report("setup.schedule", error, card.id))
    }, Math.min(at - Date.now(), 2_147_483_647))
    shared.scheduleTimers.set(card.id, { timer, at, login, accountEpoch, registrationId: active!.registrationId })
    ctx.unref(timer)
  }
  /** The bytes, and only the bytes: the one step whose failure means the person's change did not land. */
  const persist = (card: SetupCard, actor: "user" | "smithers" | "system" = ctx.commandActor): Promise<void> =>
    ctx.store.dispatch({ type: "card.upsert", actor, card: { ...card, payload: reconcileSetupHistory(card.payload) } }).isPersisted.promise.then(() => {})
  /** What the write implies once it has landed: this card's schedule observation, re-armed. */
  const refreshed = (id: string) => { const latest = get(id); if (latest) scheduleRefresh(latest) }
  const upsert = (card: SetupCard, actor: "user" | "smithers" | "system" = ctx.commandActor) =>
    persist(card, actor).then(() => refreshed(card.id))
  /*
   * A sentence the person reads where they are still looking, not only on a
   * toast that leaves. `spoken` is the door saying it said this ({@link
   * Message.spoken}): the surfaces that would otherwise repeat the sentence —
   * the form card, the command failure path — recognize this line as the one
   * this act already produced, and stay quiet instead of saying it twice.
   */
  const speak = (sentence: string): string => {
    ctx.store.dispatch({ type: "message.appended", actor: "system", text: sentence, spoken: true })
    return sentence
  }
  /*
   * A write whose failure this door owes the person a sentence for. Returns
   * that sentence, or `undefined` when the bytes landed.
   *
   * The `try` covers the persist and NOTHING else. `upsert` also re-arms the
   * card's schedule observation, which runs only after the bytes are already
   * durable: a throw from there is a bug in this app, not a browser refusing a
   * write, and classifying it would tell the person a change that WAS saved
   * was not. It is left outside, so it surfaces as the programming error it is.
   */
  const writeOrRefuse = async (card: SetupCard): Promise<string | undefined> => {
    try {
      await persist(card)
    } catch (error) {
      return speak(browserWriteRefusal(error))
    }
    refreshed(card.id)
    return undefined
  }
  /*
   * One card's writes run in order. The queue orders them; it does not decide
   * whether they run. `.then(apply)` alone made the predecessor's rejection
   * the successor's verdict: a door whose write failed silently cancelled the
   * NEXT edit the person made, which then reached nothing and said nothing —
   * the same lost-pick shape B3-N5 recorded, one step removed from its cause.
   * `.then(apply, apply)` keeps the ordering and isolates the outcome: the
   * failed write still rejects for ITS caller, who owns that sentence.
   */
  const edit = (id: string, apply: () => Result): Result => {
    const next = (shared.edits.get(id) ?? Promise.resolve()).then(apply, apply)
    shared.edits.set(id, next)
    void next.finally(() => { if (shared.edits.get(id) === next) shared.edits.delete(id) }).catch(() => {})
    return next
  }
  const delay = () => new Promise<void>(resolve => {
    const timer = setTimeout(() => { shared.sleepers.delete(timer); resolve() }, ctx.workflowPollMs)
    shared.sleepers.set(timer, resolve)
    ctx.unref(timer)
  })
  const current = (id: string, requestId: string, login: string | null, accountEpoch: number) =>
    !ctx.disposed && !shared.disposed && owner() === login && epoch() === accountEpoch && get(id)?.payload.owner === login && get(id)?.payload.request?.id === requestId

  /** Render the app's question through the shared form path, bound to this exact candidate. */
  const askSetupQuestion = async (id: string): Promise<boolean> => {
    const card = get(id)
    if (!card) return false
    const outcome = await ctx.commands.runAsAgent("setup.ask", JSON.stringify({ cardId: id,
      questionId: defaultSetupQuestion(card.payload).id, revision: card.payload.revision, digest: setupCandidate(card.payload) }))
    if (outcome.status === "form") return true
    throw Error(outcome.status === "failed" ? outcome.error : "The setup question could not be opened.")
  }

  /*
   * The question already on screen for THIS candidate. Existence alone is not
   * enough: a refused or answered card stays, and reading it as "asked" would
   * make the refusal's own "ask again" render nothing for the rest of the
   * setup's life. It also has to be bound to the current draft, so an edited
   * draft asks the current question again rather than refusing forever.
   */
  const openQuestion = (card: SetupCard) => {
    const question = ctx.store.collections.cards.get(setupQuestionCardId(card.id))
    return question?.kind === "flow-form" && question.status === "active"
      && question.payload.given["digest"] === setupCandidate(card.payload) ? question : undefined
  }

  const guidanceCurrent = (id: string, requestId: string, login: string, accountEpoch: number) =>
    !ctx.disposed && !shared.disposed && owner() === login && epoch() === accountEpoch
    && get(id)?.payload.owner === login && get(id)?.payload.guidance?.id === requestId
  /*
   * The first setup question is the APPLICATION's, rendered here through the
   * one shared form card (THE FORM LAW) at the same durable intent that used
   * to hand the ask to the model: a successful inspection, an idle chat, and
   * this account's own card. Nothing about the question reaches a provider, so
   * there is no model sentence to police — the wording, the choices and the
   * edits they make are all in repositorySetupGuide.ts.
   */
  const offerGuidance = () => {
    if (!dependencies || ctx.disposed || shared.disposed || shared.guidanceQueued || shared.guiding) return
    shared.guidanceQueued = true
    // Notifications may run inside an optimistic dispatch. Never recursively
    // render a card there; the persisted question card is the authority.
    void Promise.resolve().then(async () => {
      await ctx.store.settled?.()
      shared.guidanceQueued = false
      if (ctx.disposed || shared.disposed || shared.guiding) return
      for (const card of ctx.store.collections.cards.values()) {
        if (card.kind !== "repository-setup") continue
        const intent = card.payload.guidance, login = card.payload.owner, accountEpoch = epoch()
        if (!intent || intent.state !== "requested" || !login || login !== owner() || shared.guidanceFailures.has(intent.id)) continue
        const asked = openQuestion(card) !== undefined
        if (!asked && (ctx.activeTurn || ctx.store.session().phase !== "idle" || ctx.store.session().draft
          || card.payload.recovery?.state === "requested" || card.payload.inspectedAt === undefined
          || ["requested", "running"].includes(card.payload.request?.state ?? ""))) continue
        shared.guiding = true
        let accepted = asked, settled = false
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            if (!guidanceCurrent(card.id, intent.id, login, accountEpoch)) break
            try {
              const saved = accepted || await askSetupQuestion(card.id)
              if (!saved || !guidanceCurrent(card.id, intent.id, login, accountEpoch)) break
              accepted = true
              await edit(card.id, async () => {
                if (!guidanceCurrent(card.id, intent.id, login, accountEpoch)) return
                const latest = get(card.id)!
                await upsert({ ...latest, payload: { ...latest.payload, guidance: { id: intent.id, state: "admitted" } } }, "system")
              })
              settled = true
              break
            } catch (error) {
              // A stale optimistic write can roll back after another queued
              // command. Retry once from settled state, with the same turn ID.
              await ctx.store.settled?.()
              if (!guidanceCurrent(card.id, intent.id, login, accountEpoch)) break
              if (attempt === 0) continue
              const message = error instanceof Error ? error.message : String(error)
              shared.guidanceFailures.add(intent.id)
              await edit(card.id, async () => {
                if (!guidanceCurrent(card.id, intent.id, login, accountEpoch)) return
                const latest = get(card.id)!
                await upsert({ ...latest, payload: { ...latest.payload, guidance: { id: intent.id, state: accepted ? "admitted" : "failed", error: message } } }, "system")
              }).catch(error => ctx.failures.report("setup.guidance", error, intent.id))
              settled = true
              if (guidanceCurrent(card.id, intent.id, login, accountEpoch)) dependencies.guidanceFailed(accepted
                ? "The command's outcome could not be saved. Check its result before trying again." : message, accepted)
            }
          }
        } finally { shared.guiding = false; if (settled) offerGuidance() }
        break
      }
    }).catch(() => { shared.guidanceQueued = false })
  }
  const requestGuidance = (id: string, explicit: boolean): Result => edit(id, async () => {
    const card = get(id), login = owner(), accountEpoch = epoch()
    if (!card || !login || card.payload.owner !== login) return
    const old = card.payload.guidance
    const retry = old !== undefined && (old.state === "failed" || shared.guidanceFailures.has(old.id))
    // An unanswered current question IS the ask, so a second Configure in Chat
    // points at the one already on screen instead of resetting its draft. Once
    // it is answered, refused or outdated, asking again asks again.
    if ((old?.state === "requested" && !(explicit && retry)) || (!explicit && old)
      || (old?.state === "admitted" && openQuestion(card) !== undefined)) return
    const intent = { id: retry ? old.id : crypto.randomUUID(), state: "requested" as const }
    shared.guidanceFailures.delete(intent.id)
    const lost = await writeOrRefuse({ ...card, payload: { ...card.payload, guidance: intent } })
    if (lost !== undefined) return lost
    if (guidanceCurrent(id, intent.id, login, accountEpoch)) offerGuidance()
  })
  if (dependencies) {
    const subscription = ctx.store.collections.sessions.subscribeChanges(offerGuidance)
    ctx.onDispose(() => subscription.unsubscribe())
  }
  const attachRun = (card: SetupCard) => {
    if (!card.payload.workspaceId || !dependencies || card.payload.owner !== owner() || ctx.disposed) return
    // runs.open may provision a sleeping workspace. A recovered request keeps
    // its real Run button; discovery alone never invokes that lifecycle door.
    if (!card.payload.request || card.payload.request.observeOnly || card.payload.recovery?.state === "requested") return
    for (const runId of new Set([card.payload.receipt?.runId, card.payload.receipt?.jobRunId])) {
      if (!runId) continue
      const key = `${card.payload.repo}:${card.payload.workspaceId}:${runId}`
      const recorded = [...ctx.store.collections.cards.values()].some(item => item.kind === "run-trace"
        && item.payload.runId === runId && item.payload.repo === card.payload.repo && item.payload.workspaceId === card.payload.workspaceId)
      if (recorded || shared.openingRuns.has(key)) continue
      shared.openingRuns.add(key)
      // Reading an observed run cannot hold up its setup receipt or the Chat turn.
      void dependencies.openRun(runId, card.payload.repo, card.id).catch(error => ctx.failures.report("setup.open-run", error, runId)).finally(() => shared.openingRuns.delete(key))
    }
  }

  const send = (id: string): Promise<unknown> => {
    const card = get(id)
    const intent = card?.payload.request
    if (!card || !intent) return Promise.resolve()
    const { repo, job, draft, workspaceId } = card.payload
    const login = card.payload.owner, accountEpoch = epoch(), flight = `${login}:${accountEpoch}:${intent.id}`
    const held = shared.pending.get(flight)
    if (held) return held
    if (!current(id, intent.id, login, accountEpoch)) return Promise.resolve()
    const observing = () => intent.observeOnly || get(id)?.payload.request?.observeOnly === true
    // A read of a request the host has no record of: one admitted by the
    // retired Worker host (#2198). Nothing is left to reconnect to.
    let forgotten = false
    const work = ctx.withToast(`setup.${intent.id}`, `${REPOSITORY_JOB_TITLES[job]}…`, intent.operation === "run" ? "Work completed" : "Setup updated", async () => {
      try {
        const body = { requestId: intent.id, repo, job, draft, revision: intent.revision, digest: intent.digest,
          ...(workspaceId ? { workspaceId } : {}), ...(intent.manual ? { manual: intent.manual } : {}) }
        const observationUrl = `${ctx.baseUrl}${REPOSITORY_SETUP_API}/observe?${new URLSearchParams({ requestId: intent.id, repo, job })}`
        let reading = observing()
        let response = reading ? await ctx.boundedFetch(observationUrl, { credentials: "include" }) : await ctx.boundedFetch(`${ctx.baseUrl}${REPOSITORY_SETUP_API}/${intent.operation}`, {
          method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
        })
        for (;;) {
          if (!current(id, intent.id, login, accountEpoch)) return TOAST_SUPERSEDED
          if (!response.ok) {
            // A refusal that says this id already names other work spends it:
            // asking again under the same one only earns the same 409.
            const refusal: unknown = await response.clone().json().catch(() => undefined)
            const code = refusalCode((refusal as { code?: unknown } | undefined)?.code)
            // Accept the older spelling during a mixed app/host rollout too.
            if (code === "setup_request_conflict" || code === "setup_request_reused") shared.spentRequests.add(intent.id)
            if (reading && response.status === 404) { forgotten = true; shared.spentRequests.add(intent.id) }
            throw Error(await ctx.errorMessageOf(response, "The setup could not be completed."))
          }
          const result = SetupOperationResponseSchema.parse(await response.json())
          if (!current(id, intent.id, login, accountEpoch)) return TOAST_SUPERSEDED
          if (result.requestId !== intent.id || result.revision !== intent.revision || result.digest !== intent.digest) throw Error("The host returned a result for a different setup draft.")
          const latest = get(id)!
          // The host owns workspace selection: a workspace it replaced because
          // Cloud no longer had the one this request pinned is this setup's new
          // box. A result that moves a pin the request never carried is not.
          if (latest.payload.workspaceId && result.workspaceId && result.workspaceId !== latest.payload.workspaceId
            && workspaceId !== latest.payload.workspaceId) throw Error("The host returned a result for a different workspace.")
          const previous = latest.payload.receipt?.requestId === intent.id ? latest.payload.receipt : undefined
          if ((previous?.runId && result.receipt?.runId && previous.runId !== result.receipt.runId)
            || (previous?.jobRunId && result.receipt?.jobRunId && previous.jobRunId !== result.receipt.jobRunId)) throw Error("The host returned a different run for this setup request.")
          const scope = { ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}), ...(result.receipt ? { receipt: result.receipt } : {}) }
          if (result.receipt && (result.receipt.requestId !== intent.id || result.receipt.revision !== intent.revision || result.receipt.digest !== intent.digest || result.receipt.operation !== intent.operation)) throw Error("The host receipt does not match this setup request.")
          if (result.inspection) {
            if (intent.operation !== "inspect" || result.receipt?.phase !== "completed" || !result.receipt.runId) throw Error("The host did not confirm completed repository inspection.")
            const canAdopt = latest.payload.revision === intent.revision && setupCandidate(latest.payload) === intent.digest
            const next = canAdopt ? editSetup({ ...latest.payload, ...scope }, result.inspection.suggestedDraft) : { ...latest.payload, ...scope }
            const updated: SetupCard = { ...latest, status: "active", payload: { ...next, ...scope, sources: result.inspection.sources,
              inspectedAt: result.inspection.inspectedAt, request: { ...intent, ...(observing() ? { observeOnly: true } : {}), state: "completed" } } }
            await upsert(updated, "system")
            if (!current(id, intent.id, login, accountEpoch)) return TOAST_SUPERSEDED
            attachRun(updated)
            offerGuidance()
            return { value: "Repository inspection completed. Review the suggested configuration." }
          }
          const receipt = result.receipt!
          if (receipt.requestId !== intent.id || receipt.revision !== intent.revision || receipt.digest !== intent.digest || receipt.operation !== intent.operation) throw Error("The host receipt does not match this setup request.")
          if (receipt.phase === "completed" && !receipt.runId) throw Error("The host did not provide the completed setup run.")
          if (intent.operation === "run" && receipt.phase === "completed" && !receipt.jobRunId) throw Error("The host did not provide the completed job run.")
          const terminal = ["completed", "failed", "stopped"].includes(receipt.phase)
          let next: RepositorySetup = { ...latest.payload, ...scope, request: { ...intent, ...(observing() ? { observeOnly: true } : {}), state: terminal ? receipt.phase === "completed" ? "completed" : "failed" : "running", ...(receipt.error ? { error: receipt.error } : {}) } }
          if (intent.operation === "evaluate") next = { ...next, evaluation: receipt }
          if (intent.operation === "trial") next = { ...next, trial: receipt }
          if (terminal && receipt.phase !== "completed") next = { ...next,
            previousReceipts: [...next.previousReceipts.filter(item => item.requestId !== receipt.requestId), receipt].slice(-50) }
          if (receipt.phase === "completed" && intent.operation === "apply" && !observing()) {
            if (!receipt.registrationId || !receipt.sourceRevision || !receipt.evidence.length) throw Error("The host did not confirm the saved flow and active registration.")
            next = { ...next, active: { revision: intent.revision, digest: intent.digest, registrationId: receipt.registrationId, sourceRevision: receipt.sourceRevision, enabled: true, draft: latest.payload.draft } }
          }
          if (receipt.phase === "completed" && intent.operation === "pause" && !observing()) {
            if (!next.active || receipt.registrationId !== next.active.registrationId || !receipt.evidence.length) throw Error("The host did not confirm that this registration paused.")
            next = { ...next, active: { ...next.active, enabled: false, schedule: undefined } }
            if (next.revision <= next.active!.revision) {
              const { evaluation, trial, ...preserved } = next
              next = { ...preserved, revision: next.active!.revision + 1,
                previousReceipts: [...new Map([...next.previousReceipts, ...[evaluation, trial].filter((item): item is NonNullable<typeof item> => item !== undefined)]
                  .map(item => [item.requestId, item])).values()].slice(-50) }
            }
          }
          const updated: SetupCard = { ...latest, status: receipt.phase === "failed" ? "error" : "active", payload: next }
          await upsert(updated, "system")
          if (!current(id, intent.id, login, accountEpoch)) return TOAST_SUPERSEDED
          attachRun(updated)
          if (terminal) {
            // The mutable next occurrence belongs to the registry, not the
            // immutable apply receipt or a browser-side cron calculation.
            const expired = shared.expiredSchedules.get(id)
            if (job === "chores" && ((intent.operation === "apply" && receipt.phase === "completed" && !observing()) || (expired?.login === login && expired.accountEpoch === accountEpoch))) {
              shared.expiredSchedules.delete(id)
              void requestRecovery(id, intent.id)
            }
            // The toast says what the card says: the person's own refusal in
            // the host's words, and every other fault in that fault's line —
            // never the run phase and the engine's code. The receipt keeps the
            // verdict line as the evidence.
            return receipt.phase === "completed" ? { value: `${intent.operation} completed.` } : setupFailureSentence(receipt.error) ?? receipt.error ?? `Setup ${receipt.phase}.`
          }
          await delay()
          if (!current(id, intent.id, login, accountEpoch)) return TOAST_SUPERSEDED
          const query = new URLSearchParams({ requestId: intent.id, repo, job })
          reading = true
          response = await ctx.boundedFetch(`${ctx.baseUrl}${REPOSITORY_SETUP_API}/${observing() ? "observe" : "request"}?${query}`, { credentials: "include" })
        }
      } catch (error) {
        if (!current(id, intent.id, login, accountEpoch)) return TOAST_SUPERSEDED
        const latest = get(id)!
        const message = error instanceof Error ? error.message : String(error)
        // A forgotten request is no longer observe-only, so its Retry asks again.
        const { observeOnly: _, ...failed } = intent
        await upsert({ ...latest, status: "error", payload: { ...latest.payload, request: { ...failed, ...(observing() && !forgotten ? { observeOnly: true } : {}), state: "failed", error: message } } }, "system")
        return message
      }
    }, false, undefined, id)
    shared.pending.set(flight, work)
    void work.finally(() => { if (shared.pending.get(flight) === work) shared.pending.delete(flight) }).catch(() => {})
    return work
  }
  const recoveryCurrent = (id: string, recoveryId: string, login: string | null, accountEpoch: number) =>
    !ctx.disposed && !shared.disposed && owner() === login && epoch() === accountEpoch && get(id)?.payload.owner === login && get(id)?.payload.recovery?.id === recoveryId
  const recover = (id: string): Promise<unknown> => {
    const card = get(id), intent = card?.payload.recovery
    if (!card || !intent) return Promise.resolve()
    const login = card.payload.owner, accountEpoch = epoch(), { repo, job } = card.payload
    const flight = `${login}:${accountEpoch}:${intent.id}`
    const held = shared.recovering.get(flight)
    if (held) return held
    if (!recoveryCurrent(id, intent.id, login, accountEpoch)) return Promise.resolve()
    const work = ctx.withToast(`setup.recovery.${intent.id}`, `${REPOSITORY_JOB_TITLES[job]}…`, "Setup updated", async () => {
      try {
        const response = await ctx.boundedFetch(`${ctx.baseUrl}${REPOSITORY_SETUP_API}/state?${new URLSearchParams({ repo, job })}`, { credentials: "include" })
        if (!recoveryCurrent(id, intent.id, login, accountEpoch)) return TOAST_SUPERSEDED
        if (!response.ok) throw Error(await ctx.errorMessageOf(response, "Setup recovery is unavailable."))
        const result = SetupRecoveryResponseSchema.parse(await response.json())
        if (!recoveryCurrent(id, intent.id, login, accountEpoch)) return TOAST_SUPERSEDED
        await edit(id, async () => {
          if (!recoveryCurrent(id, intent.id, login, accountEpoch)) return
          const latest = get(id)!
          const payload = projectRecoveredSetup(latest.payload, result, new Set([...ctx.store.collections.cloudWorkspaces.values()]
            .filter(workspace => workspace.repoId === repo).map(workspace => workspace.id)))
          await upsert({ ...latest, status: payload.recovery?.state === "failed" ? "error" : "active", payload }, "system")
        })
        if (!recoveryCurrent(id, intent.id, login, accountEpoch)) return TOAST_SUPERSEDED
        const updated = get(id)!
        attachRun(updated)
        if (updated.payload.recovery?.error) return updated.payload.recovery.error
        if (updated.payload.request?.error) return setupFailureSentence(updated.payload.request.error) ?? updated.payload.request.error
        if (["requested", "running"].includes(updated.payload.request?.state ?? "")) { void send(id); return TOAST_SUPERSEDED }
        if (result.setup.state === "none" && result.registration.state === "known" && !result.registration.active && !result.registration.trial
          && updated.payload.inspectedAt === undefined && !updated.payload.request
          && updated.payload.revision === intent.baseRevision && setupCandidate(updated.payload) === intent.baseDigest) {
          await runRepositorySetup(id, "inspect")
          return TOAST_SUPERSEDED
        }
        offerGuidance()
        return { value: "Setup recovered." }
      } catch (error) {
        if (!recoveryCurrent(id, intent.id, login, accountEpoch)) return TOAST_SUPERSEDED
        const message = error instanceof Error ? error.message : String(error)
        await edit(id, async () => {
          if (!recoveryCurrent(id, intent.id, login, accountEpoch)) return
          const latest = get(id)!
          await upsert({ ...latest, status: "error", payload: { ...latest.payload, recovery: { ...latest.payload.recovery!, state: "failed", registrationState: "unavailable", error: message } } }, "system")
        })
        return recoveryCurrent(id, intent.id, login, accountEpoch) ? message : TOAST_SUPERSEDED
      }
    }, false, () => recoveryCurrent(id, intent.id, login, accountEpoch), id)
    shared.recovering.set(flight, work)
    void work.finally(() => { if (shared.recovering.get(flight) === work) shared.recovering.delete(flight) }).catch(() => {})
    return work
  }
  const requestRecovery = (id: string, completedRequestId?: string): Result => edit(id, async () => {
    const card = get(id), login = owner(), accountEpoch = epoch()
    if (!card || !login || card.payload.owner !== login) return "Sign in to configure your repository."
    if (completedRequestId !== undefined && card.payload.request?.id !== completedRequestId) return
    shared.resumed.add(`${login}:${accountEpoch}:${id}`)
    const old = card.payload.recovery
    const intent: NonNullable<RepositorySetup["recovery"]> = old?.state === "requested" ? old : {
      id: crypto.randomUUID(), baseRevision: old?.baseRevision ?? card.payload.revision, baseDigest: old?.baseDigest ?? setupCandidate(card.payload),
      adoptDraft: old?.adoptDraft ?? false, state: "requested", registrationState: "unknown"
    }
    if (old?.state !== "requested") {
      const lost = await writeOrRefuse({ ...card, payload: { ...card.payload, recovery: intent } })
      if (lost !== undefined) return lost
    }
    if (!recoveryCurrent(id, intent.id, login, accountEpoch)) return
    void recover(id)
    return { value: `${REPOSITORY_JOB_TITLES[card.payload.job]} requested.` }
  })
  /**
   * What the discard doors owe before anything moves: the honest refusal, or
   * `"recover"` when this account's enabled registration has not recorded the
   * configuration to return to yet. The ask and the act share it, so the
   * question is never posted for a setup that would refuse it.
   */
  const discardBlocked = (id: string): string | "recover" | undefined => {
    const card = get(id)
    if (!card) return "Open the setup first."
    if (card.payload.owner !== null && card.payload.owner !== owner()) return "This setup belongs to a different account."
    if (!card.payload.active?.enabled) return "This setup is not enabled."
    if (card.payload.active.owned === false) return "This registration belongs to another maintainer."
    if (!card.payload.active.draft) return "recover"
    return undefined
  }
  /*
   * Every press on this card's action row arrives here, and each branch below
   * records the press as a durable request before anything is sent. A write
   * that FAILED used to leave this door as a rejected promise, which the flow
   * harness relabelled `/setup.run failed` and one toast carried for four
   * seconds: no cause, no next act, nothing in the transcript — the same shape
   * the run-mode pick had, one door over on the same card. Every write here is
   * now named the way the configure door names its own.
   */
  const runRepositorySetup = (cardId: string, operation: Operation, manual?: SetupManualRequest): Result => edit(cardId, async () => {
    const card = get(cardId)
    if (!card) return "Open the setup first."
    const login = owner()
    if (card.payload.owner !== null && card.payload.owner !== login) return "This setup belongs to a different account."
    {
      const identity = ctx.store.collections.identitySessions.get("identity")
      if (identity?.state !== "signed-in") {
        dependencies?.promptSignIn()
        return { value: "Sign-in is open. The setup remains a preview." }
      }
      if (!identity.allowlisted) return "This account is not in the alpha yet."
    }
    /*
     * The app's first question is asked about the exact candidate an evaluate,
     * a trial and an apply submit, and its answer edits that candidate. A press
     * made while it is still open is refused here, before any branch below can
     * absorb it into a request that is already in flight: a toast leaves after
     * four seconds, so the sentence also goes to the transcript, where the
     * person is still looking a minute later.
     */
    if (CANDIDATE_OPERATIONS.has(operation) && openQuestion(card) !== undefined) {
      ctx.store.dispatch({ type: "message.appended", actor: "system", text: SETUP_QUESTION_GATE, spoken: true })
      return SETUP_QUESTION_GATE
    }
    if (card.payload.recovery && (card.payload.recovery.state !== "completed" || card.payload.recovery.registrationState !== "known")) {
      const accountEpoch = epoch()
      if (card.payload.recovery.state !== "requested") {
        const lost = await writeOrRefuse({ ...card, payload: { ...card.payload, recovery: { ...card.payload.recovery, state: "requested", error: undefined } } })
        if (lost !== undefined) return lost
      }
      if (!recoveryCurrent(cardId, card.payload.recovery.id, login, accountEpoch)) return
      void recover(cardId)
      return { value: "Setup recovery requested." }
    }
    if (card.payload.request?.observeOnly && !terminal(card.payload.receipt?.phase)) {
      const accountEpoch = epoch()
      const lost = await writeOrRefuse({ ...card, payload: { ...card.payload, request: { ...card.payload.request, state: "requested", error: undefined } } })
      if (lost !== undefined) return lost
      if (!current(cardId, card.payload.request.id, login, accountEpoch)) return
      void send(cardId)
      return { value: "Setup reconnection requested." }
    }
    if ((operation === "run" || operation === "pause" || operation === "apply") && card.payload.active?.owned === false) return "This registration belongs to another maintainer."
    if (operation === "apply") {
      const problems = setupActivationProblems(card.payload)
      if (problems.length) return problems.join(" ")
    }
    if (operation === "trial" && (card.payload.job === "review" || card.payload.job === "ci") && !setupTrialPr(card.payload.draft.trialBody).number) return "Choose a PR for this trial."
    if (operation === "pause" && !card.payload.active?.enabled) return "This setup is not enabled."
    if (operation === "run") {
      if (!card.payload.active?.enabled) return "Enable this setup before running work."
      if (card.payload.active.revision !== card.payload.revision || !storedSetupCandidate(card.payload, card.payload.active.digest)) return "Test and apply this draft before running work."
      const prepared = card.payload.manualDraft
      if (!manual && !prepared) {
        const step = card.payload.draft.steps.find(step => step.id === card.payload.selectedStep && step.mode !== "off")
          ?? card.payload.draft.steps.find(step => step.mode !== "off")
        if (!step) return "Choose an enabled step."
        const lost = await writeOrRefuse({ ...card, payload: { ...card.payload, view: "work", manualDraft: { stepId: step.id, prompt: "", source: "github" } } })
        if (lost !== undefined) return lost
        return { value: "Work request is open." }
      }
      if (!manual && prepared) {
        const needsSubject = card.payload.job === "issues" || card.payload.job === "review" || card.payload.job === "ci"
        manual = { stepId: prepared.stepId, prompt: prepared.prompt,
          ...(needsSubject && prepared.number ? { subject: { source: prepared.source, kind: card.payload.job === "issues" ? "issue" : "pr", number: prepared.number } } : {}) }
      }
      const parsed = SetupHostInputSchema.safeParse({ ...card.payload, requestId: "manual-preview", digest: setupCandidate(card.payload), operation, manual })
      if (!parsed.success) return parsed.error.issues[0]?.message ?? "Choose the work to run."
    } else if (manual !== undefined) return "Only a manual run accepts a work request."
    const old = card.payload.request
    if (old && card.payload.owner === login && (old.state === "requested" || old.state === "running")) {
      void send(cardId)
      return { value: "The setup request is already running in the background." }
    }
    // A lost response retries its durable request. A recorded failed execution
    // gets a new attempt; repeatedly POSTing the same id must never rerun work.
    const retry = old?.operation === operation && old.revision === card.payload.revision && old.state === "failed"
      && JSON.stringify(old.manual) === JSON.stringify(manual) && !shared.spentRequests.has(old.id)
      && !card.payload.previousReceipts.some(receipt => receipt.requestId === old.id)
    const intent: NonNullable<RepositorySetup["request"]> = { id: retry ? old.id : crypto.randomUUID(), operation,
      revision: card.payload.revision, digest: setupCandidate(card.payload), state: "requested", ...(manual ? { manual } : {}) }
    const accountEpoch = epoch()
    const lost = await writeOrRefuse({ ...card, status: "active", payload: { ...card.payload, owner: login, workspaceId: livePin(card.payload), request: intent } })
    if (lost !== undefined) return lost
    if (!current(cardId, intent.id, login, accountEpoch)) return
    void send(cardId)
    return { value: `${REPOSITORY_JOB_TITLES[card.payload.job]}: ${operation} requested in the background.` }
  })
  return {
    openRepositorySetup: async (rawJob, repoArg) => {
      const job = RepositoryJobSchema.parse(rawJob)
      const target = resolveTargetRepo(ctx.store, repoArg)
      if ("error" in target) return target.error
      const id = `setup:${encodeURIComponent(owner() ?? "anonymous")}:${encodeURIComponent(target.repo)}:${job}`
      const login = owner(), accountEpoch = epoch()
      const opened = await edit(id, async () => {
      if (owner() !== login || epoch() !== accountEpoch) return
      const existing = get(id)
      // A selected computer may run an older host. First setup lets the server
      // select a compatible workspace; its returned binding remains exact.
      const payload = initialSetup(target.repo, job, login)
      if (login) payload.recovery = { id: crypto.randomUUID(), baseRevision: payload.revision, baseDigest: setupCandidate(payload), adoptDraft: true, state: "requested", registrationState: "unknown" }
      const card: SetupCard = existing ?? { id, kind: "repository-setup", title: REPOSITORY_JOB_TITLES[job], status: "active", createdAt: Date.now(), ordinal: ctx.store.nextOrdinal(), payload }
      return writeOrRefuse(card)
      })
      // A card this browser would not save has nothing to open onto, and the
      // sentence for that is already in the transcript.
      if (typeof opened === "string") return opened
      if (owner() !== login || epoch() !== accountEpoch) return
      const card = get(id)
      if (!card) return
      if (owner() === null) {
        return { value: `${REPOSITORY_JOB_TITLES[job]} preview is open. Sign in to configure your repository.` }
      }
      if (card.payload.inspectedAt === undefined && ctx.commandActor === "user") await requestGuidance(id, false)
      return requestRecovery(id)
    },
    /*
     * Every control on the card projects the draft, so an edit this door
     * refuses reaches the person as the control snapping back to the value it
     * already had — the sentence itself only ever appeared on a toast, gone
     * after four seconds. It goes to the transcript as well, where they are
     * still looking when the draft they edited submits the mode they replaced.
     *
     * An accepted edit whose WRITE fails reaches them the same way, and used
     * to say nothing at all: the rejection left this door, the flow harness
     * relabelled it `/setup.configure failed`, and one toast carried that. The
     * control reverted exactly as a refusal makes it revert, so a lost pick and
     * a rejected one were indistinguishable and neither was in the transcript.
     * A failed write is now named here, in the same place and the same words a
     * refusal is, and the door never rejects.
     */
    configureRepositorySetup: (id, field, value) => edit(id, async () => {
      const card = get(id)
      if (!card) return speak("Open the setup first.")
      if (card.payload.owner !== null && card.payload.owner !== owner()) return speak("This setup belongs to a different account.")
      const applied = applySetupEdit(card.payload.draft, card.payload.job, field, value)
      if ("error" in applied) return speak(applied.error)
      const lost = await writeOrRefuse({ ...card, status: "active", payload: editSetup(card.payload, applied.draft) })
      if (lost !== undefined) return lost
      return { value: "Draft updated." }
    }),
    /*
     * The answer is bound to the candidate the question was asked about: a
     * draft that moved on refuses visibly rather than applying a choice
     * derived from a check or a mode that is no longer there. An unknown id
     * or an unoffered choice refuses too — a default belongs to the ASK.
     */
    answerRepositorySetupQuestion: (id, questionId, revision, digest, choice) => edit(id, async () => {
      const card = get(id)
      if (!card) return "Open the setup first."
      if (card.payload.owner !== null && card.payload.owner !== owner()) return "This setup belongs to a different account."
      if (card.payload.revision !== revision || setupCandidate(card.payload) !== digest) return "This setup changed after the question was asked. Ask for setup guidance again to see the current question."
      const question = setupGuideQuestions(card.payload).find(candidate => candidate.id === questionId)
      if (!question) return "That question is not part of this setup."
      const pick = question.choices.find(candidate => candidate.id === choice)
      if (!pick) return "Choose one of the offered answers."
      if (pick.edits.length === 0) return { value: "Keeping the current setup." }
      let draft = card.payload.draft
      for (const { field, value } of pick.edits) {
        const applied = applySetupEdit(draft, card.payload.job, field, value)
        if ("error" in applied) return applied.error
        draft = applied.draft
      }
      const lost = await writeOrRefuse({ ...card, status: "active", payload: editSetup(card.payload, draft) })
      if (lost !== undefined) return lost
      return { value: "Draft updated." }
    }),
    viewRepositorySetup: (id, view, selectedStep) => edit(id, async () => {
      const card = get(id)
      if (!card) return "Open the setup first."
      if (selectedStep !== undefined && !card.payload.draft.steps.some(step => step.id === selectedStep)) return "That flow is not in this setup."
      return writeOrRefuse({ ...card, payload: { ...card.payload, view, ...(selectedStep === undefined ? {} : { selectedStep }) } })
    }),
    prepareRepositoryWork: (id, stepId, field, value) => edit(id, async () => {
      const card = get(id)
      if (!card) return "Open the setup first."
      if (card.payload.owner !== null && card.payload.owner !== owner()) return "This setup belongs to a different account."
      if (!card.payload.draft.steps.some(step => step.id === stepId && step.mode !== "off")) return "Choose an enabled step."
      const currentDraft = card.payload.manualDraft
      const draft = { stepId, prompt: currentDraft?.prompt ?? "", source: currentDraft?.source ?? "github", ...(currentDraft?.number ? { number: currentDraft.number } : {}) }
      if (field === "prompt") {
        if (typeof value !== "string" || value.length > 16000) return "The work request is too long."
        draft.prompt = value
      } else if (field === "source") {
        if (value !== "github" && value !== "smithers-cloud") return "Choose the issue source."
        draft.source = value
      } else if (field === "number") {
        if (value === null || value === "") delete draft.number
        else if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return "Choose a valid issue or PR number."
        else draft.number = value
      }
      const lost = await writeOrRefuse({ ...card, payload: { ...card.payload, view: "work", manualDraft: draft } })
      if (lost !== undefined) return lost
      return { value: "Work request updated." }
    }),
    runRepositorySetup,
    /*
     * The door every trigger reaches. The discard destroys authored prompts,
     * checks and eval cases with no undo, so it asks through the same
     * confirmation an agent invocation gets — the question is the message,
     * its button is setup.discard.confirm, and nothing moves until they press
     * it. The app renders its own question this way already (askSetupQuestion).
     */
    askRepositorySetupDiscard: async id => {
      const blocked = discardBlocked(id)
      if (blocked === "recover") return requestRecovery(id)
      if (blocked !== undefined) return blocked
      const outcome = await ctx.commands.runAsAgent("setup.discard.confirm", id)
      if (outcome.status === "failed") return outcome.error
      // The confirmation's own sentence, so a model that asked reads that
      // nothing has happened yet. A human's door surfaces no value.
      if (outcome.status === "executed" && outcome.value !== undefined) return { value: outcome.value }
    },
    /*
     * The way back from a draft that cannot pass its trial. Manual work on an
     * enabled job requires an active revision/digest match (ENGINEERING.md;
     * the host refuses a dispatch that does not "retain the exact active
     * configuration"), and the revision is inside the digest, so the
     * registration's own revision returns with its draft.
     */
    discardRepositorySetupDraft: async id => {
      const blocked = discardBlocked(id)
      if (blocked === "recover") return requestRecovery(id)
      if (blocked !== undefined) return blocked
      return edit(id, async () => {
        const latest = get(id), active = latest?.payload.active
        if (!latest || !active?.enabled || !active.draft) return "This setup is not enabled."
        if (active.revision === latest.payload.revision && storedSetupCandidate(latest.payload, active.digest)) return { value: "Keeping the current setup." }
        const lost = await writeOrRefuse({ ...latest, status: "active", payload: discardSetupDraft(latest.payload) })
        if (lost !== undefined) return lost
        return { value: "Draft discarded." }
      })
    },
    retryRepositorySetup: async id => {
      const card = get(id)
      if (card?.payload.recovery?.state === "failed") return requestRecovery(id)
      // A failure the host already settled has nothing left to reconnect to —
      // the card offers Retry there, and retrying means asking for the
      // operation again, which selects a live workspace.
      const observed = card?.payload.receipt?.requestId === card?.payload.request?.id ? card?.payload.receipt : undefined
      const settled = card?.payload.request?.state === "failed" && terminal(observed?.phase)
      if (card?.payload.request?.observeOnly && !settled) {
        return edit(id, async () => {
          const latest = get(id), login = owner(), accountEpoch = epoch()
          if (!latest?.payload.request || latest.payload.owner !== login) return "This setup belongs to a different account."
          const lost = await writeOrRefuse({ ...latest, payload: { ...latest.payload, request: { ...latest.payload.request, state: "requested", error: undefined } } })
          if (lost !== undefined) return lost
          if (!current(id, latest.payload.request.id, login, accountEpoch)) return
          void send(id)
          return { value: "Setup reconnection requested." }
        })
      }
      return card?.payload.request ? runRepositorySetup(id, card.payload.request.operation, card.payload.request.manual) : "There is no setup request to retry."
    },
    guideRepositorySetup: async id => {
      const card = get(id)
      if (!card) return "Open the setup first."
      if (card.payload.owner !== null && card.payload.owner !== owner()) return "This setup belongs to a different account."
      if (ctx.commandActor === "smithers") return { value: setupGuidance(card) }
      if (owner() === null) { dependencies?.promptSignIn(); return { value: "Sign in to configure your repository." } }
      await requestGuidance(id, true)
      if (card.payload.inspectedAt === undefined && (!card.payload.recovery || card.payload.recovery.state !== "completed")) return requestRecovery(id)
      if (card.payload.inspectedAt === undefined && !["requested", "running"].includes(card.payload.request?.state ?? "")) return runRepositorySetup(id, "inspect")
      offerGuidance()
      return { value: "Setup guidance requested." }
    },
    resumeRepositorySetups: () => {
      for (const [id, observed] of shared.scheduleTimers) {
        if (observed.login !== owner() || observed.accountEpoch !== epoch()) { clearTimeout(observed.timer); shared.scheduleTimers.delete(id) }
      }
      for (const [id, observed] of shared.expiredSchedules) {
        if (observed.login !== owner() || observed.accountEpoch !== epoch()) shared.expiredSchedules.delete(id)
      }
      for (const card of ctx.store.collections.cards.values()) {
        if (card.kind === "repository-setup" && card.payload.owner === owner()) {
          if (!owner()) continue
          if (card.payload.recovery?.state === "requested") void recover(card.id)
          else if (!shared.resumed.has(`${owner()}:${epoch()}:${card.id}`)) void requestRecovery(card.id)
          else {
            attachRun(card)
            if (["requested", "running"].includes(card.payload.request?.state ?? "")) void send(card.id)
          }
        }
      }
    }
  }
}
