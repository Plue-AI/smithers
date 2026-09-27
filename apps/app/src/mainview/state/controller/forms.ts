import { MODEL_SEAT_DEFAULT,SeatIdSchema,modelSeat,seatAccepts } from "@smthrs/rpc/ConfiguredModel"
import { Schema } from "effect"
import type { AgentInvocation } from "../../flows/AgentInvocation"
import type { CommandGesture } from "../../flows/CommandGesture"
import type { CommandOutcome } from "../../flows/Commands"
import type { FieldOption,FieldValue,FormDraft,FormField,FormHints,OptionProvider } from "@smthrs/ui/flow-form"
import { assembleArgs,declaredInput,draftFrom,formFieldsFor,missingFields,positionalRead,publicFormPayload,submissionPayload } from "@smthrs/ui/flow-form"
import { payloadFor } from "../../flows/SlashPayload"
import { manifests } from "../../plugins/catalog"
import { actorSharedState } from "../ActorBindings"
import { decideApprovalAnswerInput } from "../ApprovalAnswerState"
import type { Card } from "../AppState"
import { knownRepositories, resolveTargetRepo } from "../RepoContext"
import { fileOptions,fileTargetKey } from "../seams/FilesSeam"
import { readIssueOptions } from "../seams/IssuesSeam"
import { readLandingOptions } from "../seams/LandingsSeam"
import type { ControllerContext } from "./context"
import { MODELS_CARD_ID, credentialOptions } from "./models"
import { setupQuestionCardId } from "./repositorySetup"
import { setupGuideQuestions } from "./repositorySetupGuide"
import { claimedSpokenLines,claimSpokenLine, forgetVanishedClaims,latestOrdinal } from "./spokenLines"

/*
 * THE FORM LAW (apps/app/AGENTS.md; docs/workbench-lanes/flow-forms.md), the
 * controller half. A flow invoked without its required input renders the
 * `flow-form` card: its fields derive from the flow's input schema
 * (flows/FlowForms.ts), its options come from the seams named below and
 * nowhere else (NO INVENTION), and its draft IS the card payload — every
 * field commit is `form.set`, a card-payload update through the dispatcher,
 * never component state. `form.submit` assembles the one slash line the
 * flow's grammar parses and re-enters the run path AS THE ACTOR THAT ASKED:
 * a form the agent rendered submits as the agent, so a consequential flow
 * still confirms and the human's click stays the act (THE THREE-DOOR LAW).
 */

type FlowFormCard = Extract<Card, { kind: "flow-form" }>

export interface FormRenderRequest {
  /** Edit this property of the registered flow's payload using its declared schema. */
  readonly payloadField?: string
  readonly cardId?: string
  readonly title?: string
  readonly name: string
  readonly args: string | undefined
  readonly via: "user" | "agent"
  readonly invocation?: AgentInvocation
  /** The flow's input schema and hints; looked up in the registry when the caller has only the name. */
  readonly input?: Schema.Top
  readonly hints?: FormHints
}

export interface FormRendered {
  readonly cardId: string
  /** The required fields the form still needs; every field when the line was malformed rather than short. */
  readonly missing: ReadonlyArray<string>
}

export interface FormsController {
  /** Render (or re-render) the form card for one flow, prefilled from a slash line. */
  readonly renderFlowForm: (request: FormRenderRequest) => FormRendered | undefined
  /** `form.set <cardId> <field> [value]`: one draft update; blank clears. */
  readonly setFormField: (cardId: string, field: string, value: string) => Promise<string | void>
  /** `form.submit <cardId>`: run the form's flow with the draft, as the actor that asked for it. */
  readonly submitForm: (cardId: string, invocation?: AgentInvocation, gesture?: CommandGesture) => Promise<string | void | { readonly value: string }>
  /** `card.dismiss <cardId>`: drop a form card (the form's Cancel). */
  readonly dismissCard: (cardId: string) => string | void
  /** The form the human's own invocation just rendered, until its card takes the keyboard. */
  readonly focusHandoff: FormFocusHandoff
}

export interface FormsControllerDependencies {
  readonly minimizeCard?: () => void
  readonly nextOrdinal: () => number
}

/** The card id one flow's form lives under: a second render of the same flow replaces the first. */
export const formCardId = (flow: string): string => `form-${flow}`

/** The tool text an agent reads when its invocation rendered a form instead of running. */
export const formRenderedText = (missing: ReadonlyArray<string>): string =>
  `rendered a form for ${missing.join(", ")}: ask the user to fill it in`

/*
 * Focus is the human's gesture (THE THREE-DOOR LAW's `userOnly` reason), so it
 * is never a journal transition and never in the card payload: a reload would
 * replay it. The controller records the one form the human's own invocation
 * just rendered; the card claims it once when it mounts or is re-requested
 * (cards/FlowFormCards.tsx) and drops it if the human has moved on. An
 * agent-rendered form, a form the agent principal rendered, a restored form,
 * and a draft edit never hold one.
 */
export interface FormFocusHandoff {
  /** Whether this card is the form the human just asked for: true once, then false until they ask again. */
  readonly take: (cardId: string) => boolean
}

const coerce = (field: FormField, value: string): { readonly value: FieldValue } | { readonly error: string } => {
  switch (field.kind) {
    case "number": {
      const number = Number(value)
      return Number.isFinite(number) ? { value: number } : { error: `${field.label} is a number; ${value} is not one.` }
    }
    case "boolean":
      return { value: ["true", "on", "yes", "1"].includes(value.toLowerCase()) }
    case "select": {
      const options = field.options ?? []
      if (options.length === 0) return { value }
      const option = options.find((candidate) => candidate.value === value)
      if (option === undefined) return { error: `${field.label} offers ${options.map((candidate) => candidate.value).join(", ")}; ${value} is not one of them.` }
      if (option.disabled === true) return { error: `${option.label} cannot be picked: ${option.reason ?? "it is not available here"}.` }
      return { value }
    }
    default:
      return { value }
  }
}

/** Validate pending human input with the same decision used by the receipt-gated handler. */
export const decideFormFieldInput = (
  card: FlowFormCard | undefined, cardId: string, name: string, raw: string
): { readonly card: FlowFormCard } | { readonly error: string } => {
  if (card === undefined) return { error: `There is no form card ${cardId}.` }
  if (card.status === "acted") return { error: `The form ${cardId} was already submitted.` }
  if (card.payload.submitting === true) return { error: `The form ${cardId} is being submitted.` }
  const field = card.payload.fields.find((candidate) => candidate.name === name)
  if (field === undefined) return { error: `The form has no field ${name}; its fields are ${card.payload.fields.map((candidate) => candidate.name).join(", ")}.` }
  if (field.kind === "write-only") return { error: "Use the secure field." }
  const value = raw.trim()
  const { [name]: _cleared, ...rest } = card.payload.draft
  let draft: FormDraft = rest
  if (value !== "") {
    const coerced = coerce(field, value)
    if ("error" in coerced) return { error: coerced.error }
    draft = { ...rest, [name]: coerced.value }
  }
  const { error: _dropped, ...payload } = card.payload
  return { card: { ...card, status: "active", payload: { ...payload, draft } } }
}

export const createFormsController = (ctx: ControllerContext, deps: FormsControllerDependencies): FormsController => {
  const { store } = ctx
  const { collections } = store
  // The door lines already spent on an act, shared with the surfacing path
  // (controller/failures.ts); an error row is a word owed to one act too.
  const claimedLines = claimedSpokenLines(ctx)
  // Authority comes only from a registry invocation, never from persisted or model-authored payloads.
  const continuations = actorSharedState(ctx, "form-continuations", () =>
    new Map<string, { readonly invocation: AgentInvocation; readonly payload: string }>())
  // One slot, shared by both principals, holding the card id the human's own act just rendered.
  const focus = actorSharedState(ctx, "form-focus", () => ({ cardId: undefined as string | undefined }))
  // A door that asked for a form while it was being submitted; it opens fresh once that submission is acted on.
  const reopens = actorSharedState(ctx, "form-reopens", () => new Map<string, () => void>())
  const focusHandoff: FormFocusHandoff = {
    take: (cardId) => {
      if (focus.cardId !== cardId) return false
      focus.cardId = undefined
      return true
    }
  }
  const continuationFor = (card: FlowFormCard): AgentInvocation | undefined => {
    const saved = continuations.get(card.id)
    if (saved?.payload === JSON.stringify(card.payload)) return saved.invocation
    // card.show/card.update may replace a form under an existing id. Its new
    // payload cannot borrow the replaced form's lineage or pending grant.
    continuations.delete(card.id)
    return undefined
  }

  const formCard = (cardId: string): FlowFormCard | undefined => {
    const card = collections.cards.get(cardId)
    return card?.kind === "flow-form" ? card : undefined
  }

  /** The options a seam supplies for a provider, read at render; an empty list is a valid answer. */
  const optionsFor = (provider: OptionProvider, draft: FormDraft): ReadonlyArray<FieldOption> => {
    /* What the host listed is on the Models card (controller/models.ts); with no card it listed nothing. */
    const listed = (): Extract<Card, { kind: "models" }>["payload"] | undefined => {
      const card = collections.cards.get(MODELS_CARD_ID)
      return card?.kind === "models" ? card.payload : undefined
    }
    switch (provider) {
      case "files":
        /* Filled asynchronously from the selected repository below; never invented here. */
        return []
      case "cloud-repos":
        return [...collections.repositories.values()].map((repo) => ({ value: repo.id, label: repo.id }))
      case "bookmarks": {
        const seen = new Map<string, FieldOption>()
        for (const card of collections.cards.values()) {
          if (card.kind !== "branches") continue
          for (const bookmark of card.payload.bookmarks) {
            if (!seen.has(bookmark.name)) seen.set(bookmark.name, { value: bookmark.name, label: `${bookmark.name} · ${card.payload.repo}` })
          }
        }
        return [...seen.values()]
      }
      case "workspaces":
        return [...collections.cloudWorkspaces.values()].map((workspace) => ({ value: workspace.id, label: `${workspace.name} · ${workspace.status}` }))
      case "plugins": {
        const installed = store.session().plugins ?? []
        return manifests().map((manifest) =>
          installed.includes(manifest.id)
            ? { value: manifest.id, label: manifest.name, disabled: true, reason: "already installed" }
            : { value: manifest.id, label: manifest.name }
        )
      }
      case "models": {
        // A seat takes one kind of model, and `default` hands it back to the host.
        const seat = SeatIdSchema.safeParse(draft["seat"])
        return [
          ...(seat.success ? [{ value: MODEL_SEAT_DEFAULT, label: "Default" }] : []),
          ...[...collections.models.values()]
            .filter((model) => !seat.success || seatAccepts(seat.data, model.protocol))
            .map((model) => ({ value: model.id, label: `${model.id} · ${model.modelId}` }))
        ]
      }
      case "credentials": return credentialOptions(listed())
      case "seats":
        return (listed()?.seats ?? []).map((seat) => ({ value: seat.id, label: modelSeat(seat.id).label }))
      /* The lists a card already holds answer at render; the seam read below refreshes them once the form is on screen. */
      case "issues": {
        const repo = targetRepo(draft)
        const card = repo === undefined ? undefined : collections.cards.get(`issues-${repo}`)
        return card?.kind === "issue-list"
          ? card.payload.issues.filter((issue) => issue.state === "open" && issue.kind !== "chat").map((issue) => ({ value: String(issue.number), label: `#${issue.number} ${issue.title}` }))
          : []
      }
      case "pull-requests": {
        const repo = targetRepo(draft)
        const card = repo === undefined ? undefined : collections.cards.get(`prs-${repo}`)
        return card?.kind === "pr-list"
          ? card.payload.landings.filter((landing) => !["merged", "closed", "landed"].includes(landing.state.toLowerCase()))
            .map((landing) => ({ value: String(landing.number), label: `#${landing.number} ${landing.title}` }))
          : []
      }
      case "repository-flows": {
        const repo = targetRepo(draft)
        return (repo === undefined ? [] : collections.repositoryFlows.get(repo)?.flows ?? [])
          .map((row) => ({ value: row.id, label: row.summary === null ? row.id : `${row.id} · ${row.summary}` }))
      }
    }
  }

  /** The repository a form's list options belong to: the draft's, else the active target. */
  const targetRepo = (draft: FormDraft): string | undefined => {
    const named = draft["repo"]
    if (typeof named === "string" && named !== "") return named
    const target = resolveTargetRepo(store, undefined)
    return "error" in target ? undefined : target.repo
  }

  /** The fields as the card payload carries them: the seam's options resolved for this draft, arrays copied for the wire. */
  const withOptions = (fields: ReadonlyArray<FormField>, draft: FormDraft): FlowFormCard["payload"]["fields"] =>
    fields.map((field) => {
      const options = field.optionsFrom === undefined ? field.options : optionsFor(field.optionsFrom, draft)
      const { options: _derived, ...rest } = field
      return options === undefined ? rest : { ...rest, options: [...options] }
    })

  /*
   * NO LINE RENDERS TWICE. A consequential door whose refusal has to outlive a
   * four-second toast writes it into the transcript itself (the pause door,
   * seams/TriggersSeam.ts refusePause; the setup question gate,
   * controller/repositorySetup.ts) and RETURNS the same sentence, which is how
   * the toast and the agent read it. Painting that return value onto the form
   * card as well printed it twice: canary W1 item 3a read
   * `No schedule "…" is registered on …` inside the pause card with the same
   * sentence standing in the transcript right above it
   * (.artifacts/mvp-canary-walk-20260917/W1-13-triggers-pause-submitted.png).
   * The transcript line is the one the walk verified as required, so the card
   * yields to it — and only to it. The rule and its reasons live in
   * controller/spokenLines.ts, because the command failure path owes the
   * person the same answer at the doors that have no form card.
   */

  const patch = (card: FlowFormCard, payload: FlowFormCard["payload"], status: Card["status"]): Promise<void> => {
    const invocation = continuationFor(card)
    // Replace the payload so clearing an optional parse error is durable; patches merge omitted keys.
    const transaction = store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: { ...card, payload, status } })
    if (invocation !== undefined) continuations.set(card.id, { invocation, payload: JSON.stringify(payload) })
    return transaction.isPersisted.promise.then(() => {})
  }

  /*
   * The file lesson's chooser: the selected repository's real files, read once
   * the form is on screen. A partial or failed inventory keeps what it read and
   * states the error; it never renders a listing or completes the lesson.
   */
  const refreshFileList = async (cardId: string): Promise<void> => {
    const card = formCard(cardId)
    if (card?.payload.flow !== "files.read") return
    const repo = card.payload.draft["repo"] ?? card.payload.given["repo"]
    if (typeof repo !== "string") return
    const selection = store.session().activeRepoKey
    if (ctx.disposed) return
    const answer = await fileOptions({ store, baseUrl: ctx.baseUrl, http: ctx.boundedFetch }, repo)
    if (ctx.disposed) return
    const current = formCard(cardId)
    // Typing replaces the card object. The same rendered form still owns its
    // inventory; a reopened form, different repository or submission does not.
    if (current === undefined || current.ordinal !== card.ordinal || current.payload.flow !== card.payload.flow ||
      current.status !== "active" || current.payload.submitting ||
      (current.payload.draft["repo"] ?? current.payload.given["repo"]) !== repo ||
      store.session().activeRepoKey !== selection) return
    const { error: _previous, ...payload } = current.payload
    await patch(current, {
      ...payload,
      fields: payload.fields.map(field => field.optionsFrom === "files" ? { ...field, options: answer.options } : field),
      ...(answer.error === undefined ? {} : { error: answer.error })
    }, current.status)
  }

  /*
   * The app home's pickers (issues, pull requests): the target repository's
   * open rows, read from the seams once the form is on screen, the way the
   * file chooser reads its files. A partial or failed read keeps what the
   * card holds and states the error; it never invents a row.
   */
  const refreshListOptions = async (cardId: string): Promise<void> => {
    const card = formCard(cardId)
    if (card === undefined) return
    const providers = new Set(card.payload.fields.flatMap((field) => field.optionsFrom === "issues" || field.optionsFrom === "pull-requests" ? [field.optionsFrom] : []))
    if (providers.size === 0) return
    const repo = targetRepo({ ...card.payload.draft, ...(typeof card.payload.given["repo"] === "string" ? { repo: card.payload.given["repo"] } : {}) })
    if (repo === undefined) return
    const selection = store.session().activeRepoKey
    const seam = { store, baseUrl: ctx.baseUrl, http: ctx.boundedFetch }
    const answers = await Promise.all([...providers].map(async (provider) =>
      [provider, await (provider === "issues" ? readIssueOptions(seam, repo) : readLandingOptions(seam, repo))] as const))
    if (ctx.disposed) return
    const current = formCard(cardId)
    if (current === undefined || current.ordinal !== card.ordinal || current.payload.flow !== card.payload.flow ||
      current.status !== "active" || current.payload.submitting || store.session().activeRepoKey !== selection) return
    const read = new Map(answers)
    const error = answers.map(([, answer]) => answer.error).find((message) => message !== undefined)
    const { error: _previous, ...payload } = current.payload
    await patch(current, {
      ...payload,
      fields: payload.fields.map(field => {
        const answer = field.optionsFrom === undefined ? undefined : read.get(field.optionsFrom as "issues" | "pull-requests")
        return answer === undefined ? field : { ...field, options: [...answer.options] }
      }),
      ...(error === undefined ? {} : { error })
    }, current.status)
  }

  const renderFlowForm: FormsController["renderFlowForm"] = (request) => {
    const entry = request.input === undefined ? ctx.commands.find(request.name) : undefined
    const input = request.input ?? entry?.input
    const hints = request.hints ?? entry?.metadata.form
    if (input === undefined) return undefined
    /* The trace lesson's missing-run form chooses among the runs actually recorded here. */
    let fields = formFieldsFor(input, hints).map(field =>
      request.name === "runs.steps" && field.name === "runId"
        ? { ...field, kind: "select" as const, options: [...collections.cards.values()]
            .filter(card => card.kind === "run-trace")
            .map(card => ({ value: card.kind === "run-trace" ? card.payload.runId : "", label: card.title })) }
        : field)
    if (request.name === "github.app.choose") {
      const installed = new Map<number, string>()
      for (const row of collections.githubAppStatuses.values()) {
        if (row.installed && row.configured && row.installationId !== null) installed.set(row.installationId, row.repo.split("/")[0]!)
      }
      fields = fields.map(field => ({ ...field, options: [...installed].map(([id, owner]) => ({ value: String(id), label: owner })) }))
    }
    if (fields.length === 0) return undefined
    /* A line the grammar parses whole prefills exactly; a line it refuses prefills what it can. */
    const parsed = payloadFor(
      request.name,
      request.args,
      (entry ?? ctx.commands.find(request.name))?.metadata.grammar,
      knownRepositories(ctx.store)
    )
    const read = "payload" in parsed
      ? { payload: parsed.payload, skipped: [] as ReadonlyArray<string> }
      : positionalRead(fields, hints, request.args)
    let given = publicFormPayload(fields, read.payload, request.payloadField)
    if (request.via === "agent" && (entry ?? ctx.commands.find(request.name))?.metadata.confirm !== undefined) fields = fields.filter(field => field.kind !== "write-only")
    if (request.name === "files.read") {
      /* Keep the selected repository and ask only for what is actually missing. */
      const repo = typeof given["repo"] === "string" ? given["repo"] : fileTargetKey(store)
      given = { ...given, ...(repo === undefined ? {} : { repo }) }
      fields = fields.map(field => field.name === "path" ? { ...field, optionsFrom: "files" as const } :
        field.name === "repo" ? { ...field, required: true } : field)
      const missing = missingFields(fields, draftFrom(fields, given))
      fields = fields.filter(field => missing.includes(field.name))
    }
    let title = request.title
    /*
     * The app's own setup question: its wording is the card's title and its
     * answers are the select's options, both authored in
     * controller/repositorySetupGuide.ts. The model contributes nothing here.
     * A missing or unknown id resolves to the job's default question — a
     * default belongs to the ASK; answering an unknown id refuses instead.
     * The title is the question, so the select is named for what it takes.
     */
    if (request.name === "setup.ask") {
      const setup = collections.cards.get(String(given["cardId"] ?? ""))
      const questions = setup?.kind === "repository-setup" ? setupGuideQuestions(setup.payload) : []
      const question = questions.find(candidate => candidate.id === given["questionId"]) ?? questions[0]
      if (question === undefined) return undefined
      given = { ...given, questionId: question.id }
      title = question.text
      fields = fields.filter(field => field.name === "choice").map(field => ({ ...field, kind: "select" as const,
        label: "Answer", options: question.choices.map(choice => ({ value: choice.id, label: choice.label })) }))
    }
    const nested = request.payloadField === undefined ? undefined : given[request.payloadField]
    const draft = draftFrom(fields, request.payloadField === undefined
      ? given
      : nested !== null && typeof nested === "object" ? nested as Record<string, unknown> : {},
      request.payloadField === undefined ? "words" : "json")
    const nestedPayload = request.payloadField === undefined ? {} : {
      payloadField: request.payloadField, inputSchema: Schema.toJsonSchemaDocument(input)
    }
    const resolved = withOptions(fields, draft)
    /*
     * THE FORM LAW's one sentence, and the two rules allowed to write it.
     *
     * First the flow's OWN rule over what the invocation already named
     * (`refuse`): it is about a value the person supplied, so it stands
     * whether or not the form still has fields to ask for.
     *
     * Then the grammar's reason, which stays the fallback for a line that
     * parsed into nothing askable — with one subtraction, and only one. The
     * positional re-read below this branch may SKIP an optional slot so the
     * required slots behind it can have the tokens that are left
     * (FlowForms.positionalRead, walk W1's pause card). A slot it skipped is
     * a field the line never named, so the form does have something left to
     * ask and `missingFields` — which counts only the required ones — is not
     * the whole answer. Without this, the skip rule INVENTS a sentence
     * `main@origin` does not have: `/triggers.register one two three` takes
     * three words into Flow, Name and Schedule and then quotes the grammar at
     * a line the form just read (R102 B1, R102c B1c). It subtracts nothing
     * else: a line no slot was skipped for keeps exactly the sentence
     * `main@origin` puts on that card, including every complaint about a
     * value the card is holding (R102d B1d).
     */
    const refused = hints?.refuse?.(given)
    const parseError = refused !== undefined
      ? { error: refused }
      : "error" in parsed && read.skipped.length === 0 && missingFields(resolved, draft).length === 0
        ? { error: parsed.error } : {}
    // Two open setups must not overwrite each other's question.
    const cardId = request.cardId ?? (request.name === "setup.ask"
      ? setupQuestionCardId(String(given["cardId"] ?? "")) : formCardId(request.name))
    // A human's menu action now continues in the form. Release the menu's
    // backdrop through the same transitions used by its close gestures.
    // Agent-created forms do not dismiss chrome the human is using.
    if (request.via === "user" && ctx.commandActor === "user") {
    }
    if (request.via === "user" && ctx.commandActor === "user" && store.session().maximizedCardId === MODELS_CARD_ID) deps.minimizeCard?.()
    const existing = collections.cards.get(cardId)
    if (existing?.kind === "flow-form" && existing.payload.submitting === true) {
      reopens.set(cardId, () => { renderFlowForm(request) })
      return { cardId, missing: missingFields(existing.payload.fields, existing.payload.draft) }
    }
    continuations.delete(cardId)
    // The human's own act continues in the form, so the keyboard does too (cards/FlowFormCards.tsx).
    if (request.via === "user" && ctx.commandActor === "user") focus.cardId = cardId
    const rendered = store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id: cardId,
        kind: "flow-form",
        title: title ?? (request.name === "issue.add-flow" && typeof given.number === "number"
          ? `Add a flow to issue #${given.number}`
          : (entry ?? ctx.commands.find(request.name))?.metadata.summary ?? request.name),
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: deps.nextOrdinal(),
        payload: { flow: request.name, via: request.via, fields: resolved, draft, given, ...parseError, ...nestedPayload,
          ...(hints?.submitLabel === undefined ? {} : { submitLabel: hints.submitLabel }) }
      }
    })
    if (request.invocation !== undefined) {
      continuations.set(cardId, {
        invocation: request.invocation,
        payload: JSON.stringify({ flow: request.name, via: request.via, fields: resolved, draft, given, ...parseError, ...nestedPayload,
          ...(hints?.submitLabel === undefined ? {} : { submitLabel: hints.submitLabel }) })
      })
    }
    // A failed card commit must not start the model/file provider read.
    void rendered.isPersisted.promise.then(async () => {
      if (ctx.disposed) return
      await refreshFileList(cardId)
      await refreshListOptions(cardId)
    }).catch(error => ctx.failures.report("form.file-list", error, cardId))
    const missing = missingFields(resolved, draft)
    return { cardId, missing: missing.length > 0 ? missing : resolved.map((field) => field.name) }
  }

  const setFormField: FormsController["setFormField"] = async (cardId, name, raw) => {
    if (name.startsWith("answer:")) {
      if (ctx.commandActor !== "user") return "Approval answers belong to the human."
      const answer = decideApprovalAnswerInput(store, cardId, name, raw)
      if ("error" in answer) return answer.error
      await store.dispatch({ type: "approval.answer.changed", actor: "user", ...answer }).isPersisted.promise
      return
    }
    const original = formCard(cardId)
    const decided = decideFormFieldInput(original, cardId, name, raw)
    if ("error" in decided) return decided.error
    const card = original!
    const { payload } = decided.card
    const { draft } = payload
    /*
     * Options were supplied at render and stay as the card holds them; only a
     * field that can change WHICH harness the model list belongs to, or which
     * seat the models must suit, re-resolves the providers and re-reads the
     * list (so a later commit on another field never overwrites the list the
     * harness answered with).
     */
    const dependency = ["harness", "harnessId", "id", "roleId", "seat"].includes(name)
    await patch(card, { ...payload, draft, fields: dependency ? withOptions(card.payload.fields, draft) : card.payload.fields }, "active")
    if (name === "repo") {
      await refreshFileList(cardId)
      await refreshListOptions(cardId)
    }
  }

  const describe = (outcome: CommandOutcome): string => {
    switch (outcome.status) {
      case "failed":
        return outcome.error
      case "unavailable":
        return outcome.reason
      case "unknown-command":
        return "no flow has that name any more"
      case "form":
        // A submission carries its payload by name, so the run path asking for a form again means the flow still lacks input: a defect to state, not hide.
        return `the filled form did not give /${outcome.flow} what it needs — it still needs ${outcome.fields.join(", ")}`
      case "executed":
        return outcome.value ?? ""
    }
  }

  const submitForm: FormsController["submitForm"] = async (cardId, invocation, gesture) => {
    const card = formCard(cardId)
    if (card === undefined) return `There is no form card ${cardId}.`
    if (card.status === "acted") return `The form ${cardId} was already submitted.`
    if (card.payload.submitting === true) return `The form ${cardId} is being submitted.`
    const missing = missingFields(card.payload.fields.filter(field => field.kind !== "write-only" || gesture?.hasWriteOnly?.(field.name) !== true), card.payload.draft)
    if (missing.length > 0) {
      const labels = card.payload.fields.filter((field) => missing.includes(field.name)).map((field) => field.label)
      const error = `The form still needs: ${labels.join(", ")}.`
      await patch(card, { ...card.payload, error }, "error")
      return error
    }
    const { flow, via } = card.payload
    const entry = ctx.commands.find(flow)
    if (entry === undefined) return `/${flow} is not available here.`
    /*
     * The submission is the form's NAMED payload (FlowForms.submissionPayload):
     * every field arrives under its own name and the flow's input schema
     * validates it, so a blank optional cannot shift the next field's value
     * into it. The assembled line is display copy — the card's echo, the
     * trace, and the confirmation message — and nothing parses it back.
     */
    const nestedField = card.payload.payloadField
    const input = nestedField === undefined ? entry.input : declaredInput(card.payload.inputSchema)
    if (input === undefined) return "This form's input declaration is unavailable. Reopen the flow to refresh it."
    const nestedGiven = nestedField === undefined ? card.payload.given : card.payload.given[nestedField]
    const submission = submissionPayload(input, card.payload.fields,
      nestedGiven !== null && typeof nestedGiven === "object" ? nestedGiven as Record<string, unknown> : {}, card.payload.draft, nestedField === undefined ? "words" : "json")
    if ("error" in submission) {
      await patch(card, { ...card.payload, error: submission.error }, "error")
      return submission.error
    }
    if (nestedField !== undefined && !Schema.is(input)(submission.payload)) {
      const error = "These inputs do not match the flow's declaration. Check the field values before running."
      await patch(card, { ...card.payload, error }, "error")
      return error
    }
    const represented = new Set(card.payload.fields.map((field) => field.name))
    const unrepresented = Object.fromEntries(Object.entries(card.payload.given).filter(([name]) => !represented.has(name)))
    const payload = nestedField === undefined ? submission.payload : { ...card.payload.given, [nestedField]: submission.payload }
    const args = nestedField === undefined
      ? assembleArgs(card.payload.fields, entry.metadata.form, { ...unrepresented, ...card.payload.draft })
      : assembleArgs(formFieldsFor(entry.input, entry.metadata.form), entry.metadata.form, payload)
    const actor = ctx.commandActor
    /*
     * The continuation keeps the asker's actor: an agent-rendered form runs
     * as the agent (a consequential flow posts its confirm card, the human's
     * click runs it), a slash-rendered form runs as the human. The agent can
     * never launder an act through a human's form: its own call is the agent's.
     */
    const asAgent = via === "agent" || actor === "smithers"
    const continuation = invocation ?? continuationFor(card)
    /*
     * The submission belongs to the account that pressed Submit. Sign-out
     * forgets the form and its draft, so work that outlives the account runs
     * nothing new and writes nothing back.
     */
    const epoch = ctx.accountEpoch
    const accountEnded = () => ctx.accountEpoch !== epoch
    await patch(card, { ...card.payload, submitting: true }, "active")
    if (accountEnded()) {
      continuations.delete(cardId)
      return "The account changed before this form was submitted."
    }
    /* Everything the doors say from here on belongs to this submission. */
    const saidBefore = latestOrdinal(collections)
    let outcome: CommandOutcome
    try {
      outcome = await ctx.commands.submit({
        name: flow,
        payload,
        actor: asAgent ? "agent" : "user",
        ...(!asAgent && gesture !== undefined ? { gesture: { ...gesture, name: flow } } : {}),
        ...(args === "" ? {} : { display: args }),
        ...(asAgent && continuation !== undefined ? { invocation: continuation } : {})
      })
    } catch (cause) {
      outcome = { status: "failed", error: card.payload.fields.some(field => field.kind === "write-only") ? "Submission failed." : cause instanceof Error ? cause.message : String(cause) }
    }
    if (accountEnded()) continuations.delete(cardId)
    const reopen = reopens.get(cardId)
    reopens.delete(cardId)
    if (ctx.disposed || accountEnded() || (outcome.status === "failed" && outcome.persistenceFailed)) return describe(outcome)
    // A form the conversation cleared mid-submission stays cleared.
    const current = formCard(cardId)
    if (outcome.status === "executed") {
      continuations.delete(cardId)
      if (current !== undefined) {
        const { error: _dropped, ...payload } = current.payload
        await patch(current, { ...payload, submitting: false }, "acted")
      }
      reopen?.()
      return { value: outcome.value ?? `submitted /${flow}${args === "" ? "" : ` ${args}`}` }
    }
    const error = describe(outcome)
    if (current === undefined) return error
    const { error: _repeated, ...settledPayload } = current.payload
    /*
     * The row yields to a door's line by TAKING it, never by matching the
     * sentence (controller/spokenLines.ts). The sentences are a closed table,
     * so an act whose row matched a line another act was already given lost
     * its word entirely: the transcript line belongs to the other act and
     * this card printed nothing. A line nobody has spent is this act's; a
     * line already spent leaves the row to say it.
     */
    const yielded = claimSpokenLine(collections, error, saidBefore, claimedLines)
    forgetVanishedClaims(collections, claimedLines)
    await patch(current, yielded ? { ...settledPayload, submitting: false } : { ...current.payload, submitting: false, error }, "error")
    // The card carries the refusal for the human; the agent reads it as its result.
    return actor === "smithers" ? error : undefined
  }

  const dismissCard: FormsController["dismissCard"] = (cardId) => {
    const card = collections.cards.get(cardId)
    if (card === undefined) return `There is no card ${cardId}.`
    if (card.kind !== "flow-form") return `/card.dismiss dismisses form cards; ${cardId} is a ${card.kind} card.`
    if (card.payload.submitting === true) return `The form ${cardId} is being submitted.`
    continuations.delete(cardId)
    store.dispatch({ type: "card.removed", actor: ctx.commandActor, id: cardId })
  }

  return { renderFlowForm, setFormField, submitForm, dismissCard, focusHandoff }
}
