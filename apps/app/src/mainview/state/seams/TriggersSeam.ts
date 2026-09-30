/*
 * The triggers seam: the dispatchers waiting on one repository, from two
 * sources that are never mixed (Factory design session 2026-09-07, mock 2).
 *
 * The DECLARATION is the `on` table of `.smithers/factory.json`, the
 * projection of `.smithers/FACTORY.ts`, read from the public mirror through
 * the contents route (GET /api/repos/{o}/{r}/contents/.smithers/factory.json,
 * the read path the app uses for every other repository file). It is
 * allowlisted for signed-out reads, so every visitor gets the declared rows.
 * A mirror that holds no projection yet answers 404, and that is "no rules
 * declared", not an error.
 *
 * The REGISTRATIONS are the repository's `flow:<slug>` schedules on Smithers
 * Cloud (GET /api/repos/{o}/{r}/repository-jobs). The seam asks for them only for
 * a signed-in session; a signed-out card carries no registered rows and no
 * placeholders for them.
 */
import { WORKFLOW_RPC_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { flowArgs } from "../../flows/FlowArgs"
import { FACTORY_PROJECTION_PATH, FactoryProjectionSchema, ruleFlows } from "@smthrs/rpc/FactoryProjection"
import type { FactoryProjection, FactoryRule } from "@smthrs/rpc/FactoryProjection"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalSentence } from "@smthrs/rpc/RefusalCopy"
import { BudgetTokensSchema, SetupDraftSchema } from "@smthrs/rpc/RepositorySetup"
import { Schema, SchemaRepresentation } from "effect"
import type { JsonSchema } from "effect"
import type { Card } from "../AppState"
import { TOAST_SUPERSEDED, type FailureController } from "../controller/failures"
import { repositoryJobBinding, resolveTargetRepo, type GatewayBinding } from "../RepoContext"
import type { TriggerRegistration } from "../WorkflowLaunch"
import { actorSharedState } from "../ActorBindings"
import { accountOwnerOf } from "../AccountOwner"
import { captureCloudOwner, refusalWords, unreachableSentence } from "./SeamContext"
import type { SeamContext } from "./SeamContext"
import { errorCodeOf, gatewayRefusalSentence, workspaceAnswerSentence } from "../controller/GatewayFailureCopy"

type TriggerListCard = Extract<Card, { kind: "trigger-list" }>
export type TriggerRow = TriggerListCard["payload"]["triggers"][number]

/** The signed-out card's whole text while the mirror holds no projection. */
export const NO_RULES_SENTENCE = "No rules declared yet"

/** The honest refusal of the register door while the workspace holds no registrar (L36 §2.4 step 4). */
export const registerUnavailableSentence = (repo: string): string =>
  `A schedule cannot be registered on ${repo} from here yet: this workspace has no repository/trigger flow.`

/** The backend's repository-job routes; a schedule is the job `flow:<slug>`. */
const jobPath = (repo: string, slug?: string): string =>
  `/api/repos/${repo.split("/").map(encodeURIComponent).join("/")}/repository-jobs${slug === undefined ? "" : `/flow:${encodeURIComponent(slug)}`}`

/** The workspace built-in that registers a repository flow on a schedule. */
const REGISTRAR_FLOW = "repository/trigger"

/** A schedule's own name inside one repository (L36 §1.1). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const SLUG_REFUSAL = "A schedule name is lower-case letters, digits and dashes, up to 64 characters."

/** The schedule a flow gets when the person named none: every night at 02:00 UTC (the Run it every night app). */
export const NIGHTLY_SCHEDULE = "0 2 * * *"

/** The name a schedule gets when the person named none: the flow's own id as a slug (`checks/lint` → `checks-lint`). */
export const flowSlug = (flow: string): string =>
  flow.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)

/** The accepted repository schedule forms. */
export const CRON_REFUSAL = "schedule must have five UTC cron fields or CRON_TZ=<IANA zone> and five fields"

/**
 * How long one repository job may run, as the five reviewed jobs already bound
 * it (`SetupDraftSchema.budgetMinutes`, the same bound their card's control
 * carries). A schedule is a sixth job on the same box, and Smithers Cloud
 * refuses a registration past two hours, so the two bounds are the same one.
 */
const MINUTES = SetupDraftSchema.shape.budgetMinutes

/** What one unattended fire may spend, as the registrar bounds it (`deploymentTokens`, the same shared schema). */
const TOKENS = BudgetTokensSchema

/** The two limits an unattended fire is bounded by, named as the register door's grammar names them. */
export type LimitName = "tokens" | "minutes"

/** What each limit alone may be, in that grammar. A `Record` over the union, so neither can be forgotten. */
const LIMIT_RANGES: Readonly<Record<LimitName, string>> = {
  tokens: `--tokens ${TOKENS.minValue}..${TOKENS.maxValue}`,
  minutes: `--minutes ${MINUTES.minValue}..${MINUTES.maxValue}`
}

/** The whole of what a registration may name, in the grammar the register door takes. */
const LIMIT_RANGE = `${LIMIT_RANGES.tokens}, ${LIMIT_RANGES.minutes}`

/** The shape the two limits take: whole numbers inside that range. */
export const LIMIT_SHAPE = `Token and time limits are whole numbers: ${LIMIT_RANGE}.`

/**
 * What a registration naming one limit and not the other is missing: the
 * other one, and the range that one takes.
 *
 * An unattended fire is bounded by a PAIR — tokens and time — so half a pair
 * bounds nothing. Naming one is not a bad number, though, and `LIMIT_SHAPE`
 * said it was: `--tokens 150000` is inside the range that sentence quotes
 * (R102 B2).
 *
 * It is not a free choice between the pair and nothing either. This rule runs
 * before `limitsFor`, so its sentence is the FIRST one a person reads, and
 * `Name both limits, or neither` offered "neither" to a flow that declares no
 * limits of its own — `checks/fast`, the flow walk W1 registered — which
 * `limitsFor` then refuses with `unboundedFlowSentence` (R102b B1b). Only the
 * rule that has the flow in hand knows whether "neither" is open, so this one
 * states the missing half and nothing else.
 */
export const otherLimitSentence = (missing: LimitName): string =>
  `Name the other limit: ${LIMIT_RANGES[missing]}.`

/**
 * A flow whose own declaration cannot bound one unattended fire, and the
 * numbers that can.
 *
 * Unattended work is registered with the envelope it will run under. Smithers
 * Cloud refuses one with no finite token/time limits or past two hours
 * (`validateRepositoryJob`, "automatic work needs the reviewed envelope and
 * finite token/time limits") and the host's registrar refuses one past the
 * deployment's ceiling, on the registration run, after an approval row exists.
 * Saying it here, with the range, is the difference between a person reading
 * what to type and reading that something Smithers depends on refused them.
 */
export const unboundedFlowSentence = (flow: string): string =>
  `Set token and time limits: "${flow}" declares none. ${LIMIT_RANGE}.`

/** A flow whose own ceiling is past what one unattended fire may spend. */
export const overBoundFlowSentence = (flow: string): string =>
  `Set token and time limits: "${flow}" declares more than ${LIMIT_RANGE}.`

/** What the trigger write door was asked to do. */
export interface TriggerWrite {
  /**
   * `register` prepares: it validates, plans the target flow, and offers the
   * human's approve button. `approve` is the human's alone. `run` fires a
   * registered schedule once, now. `pause` stops a schedule they enabled; `resume` restores its reviewed configuration.
   */
  readonly operation: "register" | "approve" | "run" | "pause" | "resume"
  readonly repo?: string
  readonly flow?: string
  readonly slug?: string
  readonly schedule?: string
  /**
   * What every unattended fire of this schedule may spend, as the register
   * form holds it (text) and as the approve button carries it back (numbers).
   * Left out, the ceiling the scheduled flow declares for itself is used.
   */
  readonly tokens?: string | number
  readonly minutes?: string | number
  /**
   * The one registration attempt this is, minted when the door prepares.
   * Every idempotency key of the attempt hangs off it, so pressing the same
   * button twice repeats one plan and preparing the schedule again — with a
   * corrected input, or against an edited flow — asks for a fresh one.
   */
  readonly requestId?: string
  /** The user's input for the target flow, as the form holds it: JSON text. */
  readonly input?: string
  /** The plan the preview showed, pinned so approval cannot drift to another one. */
  readonly planId?: string
  readonly planDigest?: string
}

export interface TriggersSeam {
  /** Reconnect persisted Pause requests for the current account. */
  readonly resumePauses: () => void
  readonly resumePreparations: () => void
  /** The dispatcher card (triggers.list): declared rows for every visitor, registered rows for a signed-in one. */
  readonly listTriggers: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** The trigger write door: register, approve, run, pause (triggers.register / .approve / .run / .pause). */
  readonly registerTrigger: (request: TriggerWrite) => Promise<string | void | { readonly value: string }>
}

/**
 * The controller services registration and dispatch share: durable launch,
 * the app's one run-watch and its one toast stack
 * (state/controller/workflow-pump.ts, state/controller/failures.ts).
 *
 * Registering is slow work — six relayed calls and then a run on the
 * workspace — so the approve door answers at once and both of these carry it
 * afterwards, which is what the instant-chat rule asks of every background act.
 */
export interface TriggersRuntime {
  readonly requestRun: (repo: string, slug: string, operation?: "fire" | "resume") => Promise<string | { value: string }>
  readonly requireJobBox: (repo: string, act: { readonly flow: string; readonly args?: string }, title: string) => string | { readonly value: string } | undefined
  /** Human-approved registration uses the same durable launcher as other workflow requests. */
  readonly requestRegistration: (repo: string, request: TriggerRegistration) => Promise<string | { value: string }>
  /** Background work on the shared stack, under its 300 ms debounce; a string outcome is the failure line. */
  readonly withToast: FailureController["withToast"]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const repoBase = (ctx: SeamContext, repo: string): string => {
  const [owner = "", name = ""] = repo.split("/")
  return `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

const readJson = async (ctx: Pick<SeamContext, "http" | "baseUrl">, url: string): Promise<{ status: number; body: unknown }> => {
  try {
    const response = await ctx.http(url)
    const body: unknown = await response.json().catch(() => undefined)
    return { status: response.status, body }
  } catch {
    return { status: 0, body: undefined }
  }
}

/** The contents route's document: base64 or plain text under `content`. */
const decodeContent = (body: unknown): string | null => {
  if (!isRecord(body) || typeof body.content !== "string") return null
  if (body.encoding === "base64") {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(body.content.replace(/\s+/g, "")), (char) => char.charCodeAt(0)))
    } catch {
      return null
    }
  }
  return body.content
}

/**
 * The declared rules, or the honest reason they could not be read. A 404 is
 * the mirror's own statement that no projection is committed: an empty
 * table. Anything else that is not a well-formed projection is an error
 * sentence, never an empty table pretending to be one.
 */
export const readDeclaredRules = async (
  ctx: SeamContext,
  repo: string
): Promise<ReadonlyArray<FactoryRule> | { readonly error: string }> => {
  const projection = await readFactoryProjection(ctx, repo)
  if ("error" in projection) return { error: `The rules of ${repo} couldn't be read: ${projection.error}` }
  return projection.absent ? [] : projection.projection.on
}

/**
 * The whole projection off the contents route, shared by the rules table and
 * the palette's target search: `absent` when the mirror 404s (nothing is
 * committed), the decoded projection when it parses, else the reason.
 */
export const readFactoryProjection = async (
  ctx: SeamContext,
  repo: string
): Promise<
  | { readonly absent: true }
  | { readonly absent: false; readonly projection: FactoryProjection }
  | { readonly error: string }
> => {
  const answer = await readJson(ctx, `${repoBase(ctx, repo)}/contents/${FACTORY_PROJECTION_PATH}`)
  if (answer.status === 404) return { absent: true }
  if (answer.status !== 200) return { error: `the mirror did not answer for ${FACTORY_PROJECTION_PATH}.` }
  const text = decodeContent(answer.body)
  let parsed: unknown
  try {
    parsed = text === null ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const projection = FactoryProjectionSchema.safeParse(parsed)
  if (!projection.success) return { error: `${FACTORY_PROJECTION_PATH} is not a factory projection.` }
  return { absent: false, projection: projection.data }
}

interface LiveList {
  readonly live: boolean
  readonly triggers: ReadonlyArray<TriggerRow>
}

const NO_LIVE: LiveList = { live: false, triggers: [] }

/**
 * One canonical `flow:*` repository-job registration, read into the
 * dispatcher's own row shape. `cron` is the registration's schedule, which is
 * what a generic trigger always carries; a repository schedule may name its IANA zone.
 */
const registrationRow = (value: unknown): TriggerRow | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.job !== "string" || !/^flow:[a-z0-9][a-z0-9-]{0,63}$/.test(value.job) ||
    typeof value.id !== "string" || typeof value.flow_id !== "string" || typeof value.schedule !== "string" || typeof value.enabled !== "boolean") return undefined
  const next = typeof value.next_fire_at === "string" ? Date.parse(value.next_fire_at) : Number.NaN
  return {
    id: value.id,
    slug: value.job.slice("flow:".length),
    flowId: value.flow_id,
    cron: value.schedule,
    timezone: value.schedule.startsWith("CRON_TZ=") ? value.schedule.split(/\s+/)[0]!.slice("CRON_TZ=".length) : "UTC",
    enabled: value.enabled === true,
    ...(Number.isFinite(next) ? { nextFireAt: next } : {})
  }
}

/**
 * The repository's generic trigger registrations. A route
 * that did not answer is "no registrations read", never an empty listing
 * pretending the schedules were retired.
 *
 * `live` here says the route answered, which every repository's listing does
 * whether or not it holds a schedule; what the card calls listening is the
 * merge in `listTriggers`, which asks for a row.
 */
export const readTriggerRegistrations = async (ctx: Pick<SeamContext, "http" | "baseUrl">, repo: string): Promise<LiveList> => {
  const answer = await readJson(ctx, `${ctx.baseUrl}${jobPath(repo)}`)
  if (answer.status !== 200 || !Array.isArray(answer.body)) return NO_LIVE
  const triggers = answer.body
    .map(registrationRow)
    .filter((row): row is TriggerRow => row !== undefined)
  return { live: true, triggers }
}

/** What a relay says when the box answered something this seam cannot read. */
const SHAPELESS = "The workspace answered in a shape I didn't understand."

/** One relayed gateway procedure, as the workflow relay answers it. */
type Relayed =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string }

/**
 * The box that holds the registrar: the one this repository's reviewed jobs
 * run on, else the repository's default box (RepoContext
 * `repositoryJobBinding`). Every relayed call names it, and so does the
 * registration's own run card.
 */
const jobWorkspace = (ctx: SeamContext, repo: string): GatewayBinding => repositoryJobBinding(ctx.store, repo)

/** Whether the registrar's box is still the one a request was prepared on. */
const sameJobBox = (ctx: SeamContext, repo: string, workspaceId: string | undefined): boolean => {
  const job = jobWorkspace(ctx, repo)
  return !("error" in job) && job.workspaceId === workspaceId
}

/**
 * One call to a named box through the existing `/api/workflow/rpc` relay.
 *
 * Every call names its box: the box's coding host carries
 * `repository/setup`, `repository/trigger` and the five `repository-jobs/*`
 * (flows/repository/registry.ts), and there is no box-less host to reach.
 *
 * A refusal keeps the refusing party's own words: the host's module-form
 * sentence and the control plane's `flow_not_found` listing reach the human
 * exactly as they were written, which is the only way a truthful refusal
 * survives three hops.
 */
const relayTo = async (
  ctx: Pick<SeamContext, "http" | "baseUrl">,
  repo: string,
  procedure: string,
  payload: unknown,
  workspaceId: string
): Promise<Relayed> => {
  let response: Response
  try {
    response = await ctx.http(`${ctx.baseUrl}${WORKFLOW_RPC_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, procedure, payload, workspaceId })
    })
  } catch (error) {
    return { ok: false, message: unreachableSentence("the workspace", error) }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    return { ok: false, message: refusalSentence(refusalOf({ body, status: response.status, message: refusalWords(body, "The workspace refused the request.", response.status) })) }
  }
  if (!isRecord(body)) return { ok: false, message: SHAPELESS }
  if (body.ok === true) return { ok: true, value: isRecord(body.payload) ? body.payload : {} }
  /* The gateway's refusal speaks through its control code; its own words are not the sentence. */
  if (isRecord(body.error)) return { ok: false, message: gatewayRefusalSentence(errorCodeOf(body.error.detail)) }
  /* A box that is resuming, at capacity or over a quota answers 200 with that state. */
  return { ok: false, message: workspaceAnswerSentence(body) }
}

/** The most flow pages one walk reads: 50 pages of 100 flows. */
const FLOW_PAGE_CAP = 50
export const TOO_MANY_FLOWS = "The workspace lists more flows than Smithers reads."

/**
 * Every flow the workspace has discovered. The workspace answers 100 at a
 * time (ControlSchema.defaultPageSize), so the registrar or the chosen flow
 * may sit on any page: walk `nextCursor` until the workspace names none,
 * repeats one, or answers an empty page; past FLOW_PAGE_CAP pages it refuses.
 * The walk also stops early once `live` turns false; the caller re-checks the
 * same predicate and discards the partial list.
 */
const workspaceFlows = async (
  ctx: Pick<SeamContext, "http" | "baseUrl">,
  repo: string,
  workspaceId: string,
  live: () => boolean
): Promise<{ readonly ok: true; readonly items: ReadonlyArray<Record<string, unknown>> } | { readonly ok: false; readonly message: string }> => {
  const items: Array<Record<string, unknown>> = []
  const walked = new Set<string>()
  let cursor: string | undefined
  for (let pages = 0; ; pages++) {
    if (pages === FLOW_PAGE_CAP) return { ok: false, message: TOO_MANY_FLOWS }
    const listed = await relayTo(ctx, repo, "List", cursor === undefined ? { _tag: "flows" } : { _tag: "flows", cursor }, workspaceId)
    if (!listed.ok) return listed
    const page = (Array.isArray(listed.value.items) ? listed.value.items : []).filter(isRecord)
    items.push(...page)
    const next = listed.value.nextCursor
    if (page.length === 0 || typeof next !== "string" || next === "" || walked.has(next) || !live()) return { ok: true, items }
    walked.add(next)
    cursor = next
  }
}

/** One canonical repository-job action, with its typed refusal kept whole. */
const jobCall = async (
  ctx: Pick<SeamContext, "http" | "baseUrl">,
  path: string,
  body?: unknown
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string }> => {
  let response: Response
  try {
    response = await ctx.http(`${ctx.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  } catch (error) {
    return { ok: false, message: unreachableSentence("Smithers Cloud", error) }
  }
  const answer: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    return { ok: false, message: refusalSentence(refusalOf({ body: answer, status: response.status, message: refusalWords(answer, "Smithers Cloud refused the request.", response.status) })) }
  }
  return { ok: true, value: answer }
}

/** The value a declared property asks for, by the type its document declares. */
const exampleValue = (property: unknown): string => {
  const type = isRecord(property) && typeof property.type === "string" ? property.type : undefined
  return type === "number" || type === "integer" ? "0"
    : type === "boolean" ? "false"
    : type === "array" ? "[]"
    : type === "object" ? "{}"
    : '"…"'
}

/** `{"args": "…"}` — the input the flow's published document says it takes. */
const inputExample = (schema: Record<string, unknown>): string | undefined => {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []
  const names = required.length > 0 ? required : Object.keys(properties)
  return names.length === 0 ? undefined : `{${names.map((name) => `"${name}": ${exampleValue(properties[name])}`).join(", ")}}`
}

/** `args`, `args and label`, `args, label and window` — the names in one clause. */
const nameList = (names: ReadonlyArray<string>): string =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`

/**
 * What the target flow's own declared input schema says about the registered
 * input, as a sentence the person can act on.
 *
 * The decoder's own refusal is a JSON pointer, not a sentence — the canary
 * walk read `Missing key at ["args"]` off the register card and out of the
 * transcript (.artifacts/mvp-canary-walk-20260917/W1-e-triggers-register.json).
 * Nothing here parses that message: the refusal is written from the flow's
 * PUBLISHED document, which already names every input it requires and the type
 * of each, so the person is told which input to give and what to put in it.
 */
const schemaRefusal = (document: unknown, input: unknown, flow: string): string | undefined => {
  if (document === null || typeof document !== "object") return undefined
  /* The importer answers the open `Top`; a published input document decodes without services, which is what `decodeUnknownSync` needs. */
  let declared: Schema.Top & Schema.ConstraintDecoder<unknown, never>
  try {
    declared = SchemaRepresentation.fromJsonSchemaDocument(
      document as JsonSchema.Document<"draft-2020-12">
    ) as Schema.Top & Schema.ConstraintDecoder<unknown, never>
  } catch {
    return undefined
  }
  try {
    Schema.decodeUnknownSync(declared)(input)
    return undefined
  } catch {
    const schema = isRecord((document as Record<string, unknown>).schema) ? (document as Record<string, unknown>).schema as Record<string, unknown> : {}
    const example = inputExample(schema)
    /* A flow that declares no property still says what it takes, in the same words: `{}` is "nothing". */
    if (example === undefined) return `Input for "${flow}" takes ${exampleValue(schema)}.`
    const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []
    const missing = isRecord(input) ? required.filter((name) => !(name in input)) : required
    return missing.length > 0
      ? `Input for "${flow}" needs ${nameList(missing)}: ${example}.`
      : `Input for "${flow}" takes ${example}.`
  }
}

/** What every unattended fire of one schedule may spend, in the envelope's own units. */
interface TriggerLimits {
  readonly tokens: number
  readonly milliseconds: number
}

/**
 * Why the limits as typed cannot bound an unattended fire: a number is outside
 * the range the register door takes, or only one of the pair was named. The
 * two are different facts about what the person did, so they are told apart
 * here rather than by comparing sentences (R102 B2).
 */
type LimitsProblem =
  | { readonly problem: "out-of-range"; readonly error: string }
  | { readonly problem: "half-named"; readonly error: string }

/**
 * The limits the person typed, before anything is asked of the workspace:
 * nothing, two whole positive numbers, or the one refusal their shape earns.
 *
 * A limit is held to its range only when it was actually named. `--tokens
 * 150000` alone used to be told its number was not a whole number in range,
 * which is false about 150000 — what it is missing is the other half.
 */
const namedLimits = (request: TriggerWrite): TriggerLimits | LimitsProblem | undefined => {
  const tokens = String(request.tokens ?? "").trim()
  const minutes = String(request.minutes ?? "").trim()
  if (tokens === "" && minutes === "") return undefined
  const count = Number(tokens)
  const span = Number(minutes)
  if (tokens !== "" && !TOKENS.safeParse(count).success) return { problem: "out-of-range", error: LIMIT_SHAPE }
  if (minutes !== "" && !MINUTES.safeParse(span).success) return { problem: "out-of-range", error: LIMIT_SHAPE }
  if (tokens === "") return { problem: "half-named", error: otherLimitSentence("tokens") }
  if (minutes === "") return { problem: "half-named", error: otherLimitSentence("minutes") }
  return { tokens: count, milliseconds: span * 60_000 }
}

/** Validate the whole local registration before asking a human to choose a box. */
const registrationInput = (request: TriggerWrite):
  | { readonly quick: boolean; readonly slug: string; readonly schedule: string; readonly input: string; readonly named: TriggerLimits | undefined }
  | { readonly error: string } => {
  if ((request.flow ?? "").trim() === "") return { error: "Choose a flow to schedule." }
  const quick = (request.schedule ?? "").trim() === ""
  const slug = request.slug ?? flowSlug(request.flow ?? "")
  if (!SLUG.test(slug)) return { error: SLUG_REFUSAL }
  const schedule = quick ? NIGHTLY_SCHEDULE : (request.schedule ?? "").trim()
  const fields = schedule.split(/\s+/)
  if (fields.length !== 5 && !(fields.length === 6 && fields[0]?.startsWith("CRON_TZ="))) return { error: CRON_REFUSAL }
  const input = (request.input ?? "").trim() || "{}"
  try { JSON.parse(input) } catch { return { error: "Input is not valid JSON." } }
  const named = namedLimits(request)
  if (named && "error" in named) return { error: named.error }
  return { quick, slug, schedule, input, named }
}

/**
 * The refusal the two limits' own shape earns, for a door that holds them
 * before the seam is asked for anything.
 *
 * The register form's own submit reaches `namedLimits` above and is refused
 * with zero network calls; a slash line naming the same number reached the
 * field and nothing else, because the line was short of the flow, name and
 * schedule the flow also needs and so never ran (walk W1). Both doors read
 * the one rule here, so neither restates the sentence.
 *
 * Only an out-of-range number is stated at the door. Half a pair is what the
 * open form is there to collect, so the card asks for it with its empty field
 * instead of contradicting the number the person just typed; the missing half
 * is refused at submit, where it is the whole of what is wrong.
 */
export const limitsRefusal = (named: Readonly<Record<string, unknown>>): string | undefined => {
  const limits = namedLimits({ operation: "register", ...named } as TriggerWrite)
  return limits !== undefined && "problem" in limits && limits.problem === "out-of-range" ? limits.error : undefined
}

/** The ceiling the scheduled flow declares for itself (`Descriptor.budgetOf` answers the undeclared case with an empty budget). */
const declaredLimits = (envelope: Record<string, unknown>): TriggerLimits | undefined => {
  const budget = isRecord(envelope.budget) ? envelope.budget : {}
  const tokens = budget.tokens
  const milliseconds = budget.milliseconds
  return typeof tokens === "number" && tokens > 0 && typeof milliseconds === "number" && milliseconds > 0
    ? { tokens, milliseconds }
    : undefined
}

/**
 * The limits this registration will carry: the person's, else the flow's own,
 * held to the one bound either way.
 *
 * Only the person's own numbers were held to it, while `Descriptor.BudgetCeiling`
 * bounds a declaration from above at nothing: a flow declaring four hours was
 * previewed, approved, and refused by Smithers Cloud, so the person read their
 * own registration coming back as something that was not their doing.
 */
const limitsFor = (
  named: TriggerLimits | undefined,
  envelope: Record<string, unknown>,
  flow: string
): TriggerLimits | { readonly error: string } => {
  const limits = named ?? declaredLimits(envelope)
  if (limits === undefined) return { error: unboundedFlowSentence(flow) }
  const bounded = TOKENS.safeParse(limits.tokens).success && limits.milliseconds <= MINUTES.maxValue! * 60_000
  return bounded ? limits : { error: overBoundFlowSentence(flow) }
}

/** The envelope the registration carries: the plan's, bounded by the limits the person approved. */
const reviewedEnvelope = (envelope: unknown, limits: TriggerLimits): Record<string, unknown> =>
  ({ ...(isRecord(envelope) ? envelope : {}), budget: { tokens: limits.tokens, milliseconds: limits.milliseconds } })

/**
 * A value the transcript's markdown must not read as syntax.
 *
 * The preview is appended as a message and rendered as Markdown
 * (TranscriptMessage.tsx), so `0 9 * * 1-5` came out as `0 9 1-5` and a `*`
 * capability as a bullet: the person approved a schedule they had not typed
 * (walk run 3, D3-N3). That renderer knows one code span — a single backtick
 * around at least one non-backtick byte (ui/primitives/markdown.tsx `INLINE`)
 * — so each backtick-free run is spanned and the backticks between them are
 * left bare, where no span can close on them and the renderer draws them.
 */
export const verbatim = (value: string): string =>
  value.split("`").map((run) => run === "" ? "" : `\`${run}\``).join("`")

/**
 * The plan preview: the facts the workspace stated about what a fire would
 * run, and the limits every one of those fires may spend.
 */
const previewOf = (plan: Record<string, unknown>, schedule: string, limits: TriggerLimits): string => {
  const envelope = isRecord(plan.envelope) ? plan.envelope : {}
  const capabilities = Array.isArray(envelope.capabilities) ? envelope.capabilities.filter((value): value is string => typeof value === "string") : []
  const digest = typeof plan.executionDigest === "string" ? plan.executionDigest.slice(0, 12) : ""
  return [
    `${String(plan.flowId)} · ${verbatim(schedule)}`,
    capabilities.map(verbatim).join(", "),
    `${limits.tokens} tokens · ${Math.round(limits.milliseconds / 60_000)} min`,
    digest
  ].filter((line) => line !== "").join("\n")
}

/** The one-line answer the slash and the agent get beside the card. */
const summarize = (repo: string, declared: ReadonlyArray<FactoryRule>, live: LiveList): string => {
  const parts: Array<string> = []
  if (declared.length > 0) {
    parts.push(
      `${declared.length} rule${declared.length === 1 ? "" : "s"} declared in .smithers/FACTORY.ts: ${
        declared.map((rule) => `${rule.event} runs ${ruleFlows(rule).join(", ")}`).join("; ")
      }`
    )
  }
  if (live.triggers.length > 0) {
    parts.push(`registered: ${live.triggers.map((trigger) => `${trigger.slug ?? trigger.id} runs ${trigger.flowId}`).join(", ")}`)
  }
  return parts.length === 0 ? `${NO_RULES_SENTENCE} on ${repo}.` : `Dispatcher on ${repo}: ${parts.join(". ")}.`
}

/** Revalidate the reviewed plan and record approval on its pinned workspace before the durable launcher starts the registrar. */
export const prepareTriggerRegistration = async (
  ctx: Pick<SeamContext, "http" | "baseUrl">, repo: string, request: TriggerRegistration,
  workspaceId: string, current: () => boolean
): Promise<{ input: Record<string, unknown> } | { code: string; message: string }> => {
  const refuse = (message: string) => ({ code: "trigger_registration_refused", message })
  const superseded = () => ({ code: "request_superseded", message: "This registration belongs to a previous session." })
  const call = (procedure: string, payload: unknown) => relayTo(ctx, repo, procedure, payload, workspaceId)
  if (!current()) return superseded()
  const listed = await workspaceFlows(ctx, repo, workspaceId, current)
  if (!current()) return superseded()
  if (!listed.ok) return refuse(listed.message)
  if (!listed.items.some(item => item.flowId === REGISTRAR_FLOW)) return refuse(registerUnavailableSentence(repo))
  const input: unknown = JSON.parse(request.input)
  const planned = await call("Plan", { flowId: request.flow, input, idempotencyKey: `trigger:${request.requestId}:plan` })
  if (!current()) return superseded()
  if (!planned.ok) return refuse(planned.message)
  if (planned.value.planId !== request.planId || planned.value.digest !== request.planDigest) return refuse("The plan changed since you saw it. Prepare the registration again.")
  const envelope = planned.value.envelope
  const named = namedLimits({ operation: "approve", ...request })
  if (named && "error" in named) return refuse(named.error)
  const limits = limitsFor(named, isRecord(envelope) ? envelope : {}, request.flow)
  if ("error" in limits) return refuse(limits.error)
  const approved = await call("Approval.Submit", {
    target: { _tag: "Plan", planId: request.planId, digest: request.planDigest, envelope },
    scope: "run", idempotencyKey: `approve:${request.planId}`, decision: "approve"
  })
  if (!current()) return superseded()
  if (!approved.ok) return refuse(approved.message)
  const receipt = await jobCall(ctx, `${jobPath(repo, request.slug)}/approvals`, {
    flow_id: request.flow, plan_id: request.planId, plan_digest: request.planDigest,
    envelope: reviewedEnvelope(envelope, limits)
  })
  if (!current()) return superseded()
  if (!receipt.ok) return refuse(receipt.message)
  if (!isRecord(receipt.value) || typeof receipt.value.approved_at !== "string" || typeof receipt.value.approved_by !== "number") {
    return refuse("Smithers Cloud did not state who approved this plan.")
  }
  return { input: { requestId: request.requestId, operation: "register", repo, slug: request.slug, flow: request.flow,
    schedule: request.schedule, input, budget: { tokens: limits.tokens, milliseconds: limits.milliseconds },
    approvedPlanId: request.planId, approvedPlanDigest: request.planDigest } }
}

export const createTriggersSeam = (ctx: SeamContext, runtime: TriggersRuntime): TriggersSeam => {
  const pauses = actorSharedState(ctx, "trigger-pauses", () => ({ running: new Set<string>(), versions: new Map<string, number>() }))
  type Pause = NonNullable<TriggerListCard["payload"]["pauseRequests"]>[number]
  const owner = () => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    return identity?.state === "signed-in" && identity.allowlisted ? accountOwnerOf(identity) : undefined
  }
  // Pause uses the account HTTP route even when the workspace is offline.
  const capturePauseOwner = () => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    const revision = identity?.ownerRevision ?? identity?.revision
    return () => ctx.isDisposed?.() !== true
      && (ctx.store.collections.identitySessions.get("identity")?.ownerRevision
        ?? ctx.store.collections.identitySessions.get("identity")?.revision) === revision
  }
  const pauseCard = (repo: string): TriggerListCard | undefined => {
    const card = ctx.store.collections.cards.get(`trigger-list-${repo}`)
    return card?.kind === "trigger-list" ? card : undefined
  }
  const savePause = (repo: string, request: Pause, actor: "user" | "smithers" | "system" = "system") => {
    const previous = pauseCard(repo)
    const card: TriggerListCard = previous ?? {
      id: `trigger-list-${repo}`, kind: "trigger-list", title: `Dispatcher · ${repo}`,
      status: "active", createdAt: Date.now(), ordinal: ctx.nextOrdinal(), payload: { repo, triggers: [] }
    }
    return ctx.dispatch({ type: "card.upsert", actor, card: { ...card, payload: {
      ...card.payload,
      triggers: request.phase === "completed" ? card.payload.triggers.map(row => row.slug === request.slug
        ? { ...row, enabled: false, nextFireAt: undefined } : row) : card.payload.triggers,
      pauseRequests: [...(card.payload.pauseRequests ?? []).filter(row => row.slug !== request.slug || row.owner !== request.owner), request]
    } } }).isPersisted.promise
  }

  const pumpPause = (repo: string, request: Pause) => {
    if (pauses.running.has(request.id)) return
    pauses.running.add(request.id)
    const sameOwner = capturePauseOwner()
    const current = () => sameOwner() && owner() === request.owner
      && pauseCard(repo)?.payload.pauseRequests?.some(row => row.id === request.id) === true
    void runtime.withToast(`trigger-pause:${request.id}`, `Pausing ${request.slug}`, `Paused ${request.slug}`, async () => {
      if (!current()) return TOAST_SUPERSEDED
      try {
        let failure: string | undefined
        if (request.phase === "sending") {
          // A lost response is ambiguous. Replaying a state setter could pause a later Resume.
          const live = await readTriggerRegistrations(ctx, repo)
          if (!live.triggers.some(row => row.slug === request.slug && !row.enabled)) {
            failure = `Could not confirm Pause for ${request.slug}. Retry to pause it.`
          }
        } else {
          await savePause(repo, { ...request, phase: "sending" })
          if (!current()) return TOAST_SUPERSEDED
          /* The receipt lists the registrations it stopped; a name it does not hold stops none. */
          const result = await jobCall(ctx, `${jobPath(repo, request.slug)}/pause`)
          failure = !result.ok ? result.message
            : !Array.isArray(result.value) ? "Smithers Cloud did not confirm Pause."
            : result.value.length === 0 ? `No schedule "${request.slug}" is registered on ${repo}.` : undefined
        }
        if (!current()) return TOAST_SUPERSEDED
        pauses.versions.set(repo, (pauses.versions.get(repo) ?? 0) + 1)
        await savePause(repo, { ...request, phase: failure ? "failed" : "completed", ...(failure ? { error: failure } : {}) })
        if (!current()) return TOAST_SUPERSEDED
        if (failure) return refusePause(failure)
        // The receipt settles Pause. A slow listing cannot hold its toast or Chat open.
        void listTriggers(repo).catch(() => {})
      } catch {
        if (!current()) return TOAST_SUPERSEDED
        const error = "Could not save Pause. Retry."
        await savePause(repo, { ...request, phase: "failed", error }).catch(() => {})
        return current() ? refusePause(error) : TOAST_SUPERSEDED
      }
    }, false, current, `trigger-list-${repo}`).finally(() => pauses.running.delete(request.id))
  }

  const resumePauses = () => {
    if (ctx.isDisposed?.() || !owner()) return
    for (const card of ctx.store.collections.cards.values()) {
      if (card.kind !== "trigger-list") continue
      for (const request of card.payload.pauseRequests ?? []) {
        if (request.owner === owner() && (request.phase === "requested" || request.phase === "sending")) pumpPause(card.payload.repo, request)
      }
    }
  }

  const listTriggers = async (repoArg?: string): Promise<string | void | { readonly value: string }> => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) {
      // Signed out with no repository to read, the door is the sign-in step, never an instruction to type (#2285).
      if (ctx.promptSignIn === undefined || ctx.store.collections.identitySessions.get("identity")?.state !== "signed-out") return target.error
      ctx.promptSignIn()
      return { value: "The sign-in step is rendered in the chat." }
    }
    const repo = target.repo
    const current = captureCloudOwner(ctx, false)
    const version = pauses.versions.get(repo)
    const identity = ctx.store.collections.identitySessions.get("identity")
    const signedIn = identity?.state === "signed-in" && identity.allowlisted
    const [declared, registered] = await Promise.all([
      readDeclaredRules(ctx, repo),
      signedIn ? readTriggerRegistrations(ctx, repo) : Promise.resolve(NO_LIVE)
    ])
    if ("error" in declared) return declared.error
    if (!current() || version !== pauses.versions.get(repo)) return
    /* Listening means a schedule is registered — never that the registrations route answered with nothing. */
    const live: LiveList = { live: registered.triggers.length > 0, triggers: registered.triggers }
    const cardId = `trigger-list-${repo}`
    const existing = ctx.store.collections.cards.get(cardId)
    const card: Card = {
      id: cardId,
      kind: "trigger-list",
      title: `Dispatcher · ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: {
        repo,
        declared: [...declared],
        ...(existing?.kind === "trigger-list" && existing.payload.pauseRequests ? { pauseRequests: existing.payload.pauseRequests } : {}),
        ...(existing?.kind === "trigger-list" && existing.payload.preparations ? { preparations: existing.payload.preparations } : {}),
        live: live.live,
        triggers: [...live.triggers]
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
    return { value: summarize(repo, declared, live) }
  }

  /**
   * The prepared registration the approve button carries, as one JSON object.
   *
   * It carries only what the person gave, never the limits derived from the
   * plan: the approve door plans the flow again anyway, so deriving them once
   * more there keeps one rule in one place and cannot round a declared ceiling
   * on the way through the button.
   */
  const prepared = (
    request: TriggerWrite,
    repo: string,
    requestId: string,
    planId: string,
    planDigest: string,
    named: TriggerLimits | undefined
  ): string =>
    JSON.stringify({
      requestId,
      repo,
      flow: request.flow,
      slug: request.slug,
      schedule: request.schedule,
      ...(request.input === undefined || request.input.trim() === "" ? {} : { input: request.input }),
      ...(named === undefined ? {} : { tokens: named.tokens, minutes: named.milliseconds / 60_000 }),
      planId,
      planDigest
    })

  type Preparation = NonNullable<TriggerListCard["payload"]["preparations"]>[number]
  const preparing = actorSharedState(ctx, "trigger-preparations", () => ({ running: new Set<string>(), queued: new Set<string>() }))
  const preparation = (repo: string, id: string) => pauseCard(repo)?.payload.preparations?.find(row => row.id === id)
  const savePreparation = (repo: string, request: Preparation, actor: "user" | "smithers" | "system" = "system") => {
    const previous = pauseCard(repo)
    const card: TriggerListCard = previous ?? {
      id: `trigger-list-${repo}`, kind: "trigger-list", title: `Dispatcher · ${repo}`,
      status: "active", createdAt: Date.now(), ordinal: ctx.nextOrdinal(), payload: { repo, triggers: [] }
    }
    return ctx.dispatch({ type: "card.upsert", actor, card: { ...card, payload: { ...card.payload,
      preparations: [...(card.payload.preparations ?? []).filter(row => row.owner !== request.owner || row.draft.slug !== request.draft.slug), request]
    } } }).isPersisted.promise
  }

  const pumpPreparation = (repo: string, request: Preparation) => {
    if (preparing.running.has(request.id)) { preparing.queued.add(request.id); return }
    preparing.running.add(request.id)
    const sameOwner = capturePauseOwner()
    const sameCloud = captureCloudOwner(ctx, false)
    const current = () => sameOwner() && owner() === request.owner && preparation(repo, request.id) !== undefined
    const bound = () => sameCloud() && sameJobBox(ctx, repo, request.workspaceId)
    const workspaceChanged = "The box changed. Prepare this schedule again."
    void runtime.withToast(`trigger-prepare:${request.id}`, `Preparing ${request.draft.slug}`, `Prepared ${request.draft.slug}`, async () => {
      const fail = async (error: string) => {
        if (!current()) return TOAST_SUPERSEDED
        await savePreparation(repo, { ...(preparation(repo, request.id) ?? request), phase: "failed", error })
        return current() ? error : TOAST_SUPERSEDED
      }
      try {
        if (!current()) return TOAST_SUPERSEDED
        const box = request.workspaceId
        if (box === undefined || !bound()) return await fail(workspaceChanged)
        let receipt = request.receipt
        if (!receipt) {
          const listed = await workspaceFlows(ctx, repo, box, () => current() && bound())
          if (!current()) return TOAST_SUPERSEDED
          if (!bound()) return await fail(workspaceChanged)
          if (!listed.ok) return await fail(listed.message)
          const items = listed.items
          if (!items.some(item => item.flowId === REGISTRAR_FLOW)) return await fail(registerUnavailableSentence(repo))
          const target = items.find(item => item.flowId === request.draft.flow)
          if (!target) return await fail(`No flow "${request.draft.flow}" is registered on this workspace. The workspace has: ${items.map(item => String(item.flowId)).join(", ")}.`)
          const input: unknown = JSON.parse(request.draft.input)
          const refusal = schemaRefusal(target.inputSchema, input, request.draft.flow)
          if (refusal) return await fail(refusal)
          await savePreparation(repo, { ...request, phase: "planning", error: undefined })
          if (!current()) return TOAST_SUPERSEDED
          if (!bound()) return await fail(workspaceChanged)
          const planned = await relayTo(ctx, repo, "Plan", {
            flowId: request.draft.flow, input, idempotencyKey: `trigger:${request.id}:plan`
          }, box)
          if (!current()) return TOAST_SUPERSEDED
          if (!bound()) return await fail(workspaceChanged)
          if (!planned.ok) return await fail(planned.message)
          const { planId, digest } = planned.value
          if (typeof planId !== "string" || typeof digest !== "string") return await fail("The workspace planned the flow but didn't name the plan.")
          const named = namedLimits({ operation: "register", ...request.draft })
          if (named && "error" in named) return await fail(named.error)
          const limits = limitsFor(named, isRecord(planned.value.envelope) ? planned.value.envelope : {}, request.draft.flow)
          if ("error" in limits) return await fail(limits.error)
          receipt = {
            text: previewOf(planned.value, request.draft.schedule, limits),
            args: prepared({ operation: "register", ...request.draft }, repo, request.id, planId, digest, named)
          }
          await savePreparation(repo, { ...request, phase: "ready", receipt, error: undefined })
        }
        if (!current()) return TOAST_SUPERSEDED
        if (!bound()) return await fail(workspaceChanged)
        if (request.approve === "owner") {
          // The owner's press was the approval: apply it through the Approve button's own path, with the receipt it would carry.
          await savePreparation(repo, { ...request, phase: "prepared", receipt, error: undefined })
          if (!current()) return TOAST_SUPERSEDED
          const answer = await approveTrigger({ operation: "approve", ...(JSON.parse(receipt.args) as Omit<TriggerWrite, "operation">) }, repo)
          return typeof answer === "string" ? await fail(answer) : true
        }
        // A crash between these commits republishes only if the durable message is absent.
        const published = [...ctx.store.collections.messages.values()].some(message =>
          message.action?.flow === "triggers.approve" && message.action.args === receipt.args)
        if (!published) await ctx.dispatch({ type: "message.appended", actor: "system", text: receipt.text,
          action: { flow: "triggers.approve", args: receipt.args, label: "Approve and register" }
        }).isPersisted.promise
        if (!current()) return TOAST_SUPERSEDED
        await savePreparation(repo, { ...request, phase: "prepared", receipt, error: undefined })
      } catch {
        return await fail("Could not save the preparation. Retry.")
      }
    }, false, current, `trigger-list-${repo}`).finally(() => {
      preparing.running.delete(request.id)
      const queued = preparing.queued.delete(request.id)
      const latest = preparation(repo, request.id)
      // Retry may be admitted while the failing attempt is still settling its toast.
      if (queued && !ctx.isDisposed?.() && latest?.owner === owner() && (latest?.phase === "requested" || latest?.phase === "ready")) pumpPreparation(repo, latest)
    })
  }

  const resumePreparations = () => {
    if (ctx.isDisposed?.() || !owner()) return
    for (const card of ctx.store.collections.cards.values()) {
      if (card.kind !== "trigger-list") continue
      for (const request of card.payload.preparations ?? []) {
        if (request.owner === owner() && !["prepared", "failed"].includes(request.phase)) pumpPreparation(card.payload.repo, request)
      }
    }
  }

  /** Persist first. Discovery and planning produce a reviewed approval prompt in the background. */
  const prepareTrigger = async (request: TriggerWrite, repo: string): Promise<string | { readonly value: string }> => {
    /*
     * One press schedules (D-18): a request naming no name is named for its
     * flow, one naming no schedule runs nightly, and when the human pressed it their press is
     * the approval — the same approval the Approve button gives, applied by
     * the pump once the plan is prepared. An agent's request keeps the
     * preview and the human's Approve (approvals belong to the human).
     */
    // Revalidate after the form resumes: the carried draft is another command input.
    const validated = registrationInput(request)
    if ("error" in validated) return validated.error
    const { quick, slug, schedule, input, named } = validated
    const login = owner()
    if (!login) return "Sign in to prepare a schedule."
    const approve = quick && ctx.actor() === "user" ? { approve: "owner" as const } : {}
    const draft: Preparation["draft"] = { flow: request.flow ?? "", slug, schedule, input,
      ...(named ? { tokens: named.tokens, minutes: named.milliseconds / 60_000 } : {}) }
    const job = jobWorkspace(ctx, repo)
    if ("error" in job) return job.error
    const { workspaceId } = job
    const same = (row: Preparation) => row.owner === login && row.workspaceId === workspaceId && JSON.stringify(row.draft) === JSON.stringify(draft)
    const ack = { value: `Preparation requested for ${slug} on ${repo}.` }
    // A second press of Schedule joins the registration the first one made: its approval is re-applied, and the launch path dedups on the request.
    const scheduled = "approve" in approve ? pauseCard(repo)?.payload.preparations?.find(row => same(row) && row.phase === "prepared" && row.approve === "owner" && row.receipt !== undefined) : undefined
    if (scheduled?.receipt !== undefined) {
      const answer = await approveTrigger({ operation: "approve", ...(JSON.parse(scheduled.receipt.args) as Omit<TriggerWrite, "operation">) }, repo)
      return typeof answer === "string" ? answer : ack
    }
    const existing = pauseCard(repo)?.payload.preparations?.find(row => same(row) && row.phase !== "prepared")
    if (existing && existing.phase !== "failed") {
      try { await ctx.store.settled?.() } catch { return "Could not save the preparation. Retry." }
      pumpPreparation(repo, existing)
      return ack
    }
    const entry: Preparation = existing ? { ...existing, ...approve, phase: existing.receipt ? "ready" : "requested", error: undefined }
      : { id: crypto.randomUUID(), owner: login, workspaceId, draft, phase: "requested", ...approve }
    const current = capturePauseOwner()
    try { await savePreparation(repo, entry, ctx.actor()) } catch { return "Could not save the preparation. Retry." }
    if (current()) pumpPreparation(repo, entry)
    return ack
  }

  /**
   * The human's approval, and only theirs (triggers.approve is userOnly).
   *
   * The approval is answered at once; the workspace calls and the registrar
   * run happen behind one notice that settles from the run rather than from
   * its launch. Pressing again while the attempt is in flight, or while its
   * run is still being watched, joins what is already running: one plan, one
   * receipt, one run.
   *
   * The durable request card precedes network work. Its launcher reconnects
   * the pending request until a real run id exists, then watches that run.
   */
  const approveTrigger = async (request: TriggerWrite, repo: string): Promise<string | void | { readonly value: string }> => {
    const slug = request.slug ?? ""
    const requestId = request.requestId
    const planId = request.planId
    const planDigest = request.planDigest
    if (!SLUG.test(slug) || requestId === undefined || request.flow === undefined || planId === undefined || planDigest === undefined) {
      return "This approval does not name a prepared registration."
    }
    const saved = preparation(repo, requestId)
    const replaced = !saved && pauseCard(repo)?.payload.preparations?.some(row => row.draft.slug === slug)
    if (replaced) return "Prepare this schedule again; this preview was replaced."
    if (saved && (saved.owner !== owner() || !sameJobBox(ctx, repo, saved.workspaceId))) return "Prepare this schedule again for the current workspace."
    const text = (request.input ?? "").trim()
    if (text !== "") {
      try {
        JSON.parse(text)
      } catch {
        return "Input is not valid JSON."
      }
    }
    if (saved?.receipt) {
      const reviewed = JSON.parse(saved.receipt.args) as Record<string, unknown>
      const supplied = { ...request, repo }
      const fields = ["requestId", "repo", "flow", "slug", "schedule", "input", "tokens", "minutes", "planId", "planDigest"] as const
      if (fields.some(key => reviewed[key] !== supplied[key])) return "The registration changed since you reviewed it. Prepare it again."
    }
    const named = namedLimits(request)
    if (named && "error" in named) return named.error
    return runtime.requestRegistration(repo, { requestId, flow: request.flow, slug, schedule: request.schedule ?? "", input: text || "{}", planId, planDigest,
      ...(named ? { tokens: named.tokens, minutes: named.milliseconds / 60_000 } : {}) })
  }

  /*
   * A refused pause, said where it stays. The returned string reaches the
   * caller as the command-failure toast, which states itself and dismisses
   * after four seconds; a consequential door the human pressed needs an
   * answer that is still there when they look back, so the sentence is
   * appended to the transcript as well.
   */
  const refusePause = (message: string): string => {
    ctx.dispatch({ type: "message.appended", actor: "system", text: message, spoken: true })
    return message
  }

  /** Persist the intent before any network work; repeat input joins the pending request. */
  const pauseTrigger = async (request: TriggerWrite, repo: string): Promise<string | { readonly value: string }> => {
    const slug = request.slug ?? ""
    if (!SLUG.test(slug)) return SLUG_REFUSAL
    const login = owner()
    if (!login) return "Sign in to pause a schedule."
    const pending = pauseCard(repo)?.payload.pauseRequests?.find(row => row.owner === login && row.slug === slug
      && (row.phase === "requested" || row.phase === "sending"))
    if (pending) {
      try { await ctx.store.settled?.() }
      catch { return refusePause("Could not save Pause. Retry.") }
      return { value: `Pause requested for ${slug} on ${repo}.` }
    }
    const entry: Pause = { id: crypto.randomUUID(), slug, owner: login, phase: "requested" }
    const current = capturePauseOwner()
    try { await savePause(repo, entry, ctx.actor()) }
    catch { return refusePause("Could not save Pause. Retry.") }
    if (current()) pumpPause(repo, entry)
    return { value: `Pause requested for ${slug} on ${repo}.` }
  }

  /*
   * The one write door of the dispatcher. Every operation resolves the same
   * target repository first, so a button, a slash line and the agent all act
   * on the repository the human is looking at.
   */
  const registerTrigger = async (request: TriggerWrite): Promise<string | void | { readonly value: string }> => {
    const target = resolveTargetRepo(ctx.store, request.repo)
    if ("error" in target) return target.error
    const slug = request.slug ?? ""
    if (request.operation === "register") {
      const validated = registrationInput(request)
      if ("error" in validated) return validated.error
    }
    if ((request.operation === "run" || request.operation === "resume") && !SLUG.test(slug)) return SLUG_REFUSAL
    if (request.operation === "register" || request.operation === "run" || request.operation === "resume") {
      const act = request.operation === "register"
        ? { flow: "triggers.register", args: flowArgs("triggers.register", { repo: target.repo, flow: request.flow ?? "",
          ...(request.slug === undefined ? {} : { slug: request.slug }),
          ...(request.schedule === undefined ? {} : { schedule: request.schedule }),
          ...(request.input === undefined ? {} : { input: request.input }),
          ...(request.tokens === undefined ? {} : { tokens: Number(request.tokens) }),
          ...(request.minutes === undefined ? {} : { minutes: Number(request.minutes) }) }) }
        : { flow: request.operation === "run" ? "triggers.run" : "triggers.resume",
          args: flowArgs(request.operation === "run" ? "triggers.run" : "triggers.resume", { slug, repo: target.repo }) }
      const prerequisite = runtime.requireJobBox(target.repo, act, `Open a box for schedules in ${target.repo}`)
      if (prerequisite !== undefined) return prerequisite
    }
    if (request.operation === "approve") return approveTrigger(request, target.repo)
    if (request.operation === "run") return runtime.requestRun(target.repo, slug)
    if (request.operation === "resume") return runtime.requestRun(target.repo, slug, "resume")
    if (request.operation === "pause") return pauseTrigger(request, target.repo)
    return prepareTrigger(request, target.repo)
  }

  return { listTriggers, registerTrigger, resumePauses, resumePreparations }
}
