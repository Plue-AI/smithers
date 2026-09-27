/**
 * Configured models: the record a person saves, the credential NAME it spends,
 * the origins that name may travel to, the seats a model answers for, and the
 * typed result of testing one.
 *
 * A credential is a name pinned to origins. Agent parity means a
 * prompt-injected agent can file any record a person can, so a free endpoint
 * beside a named key would be key exfiltration: `{ credential:
 * "CEREBRAS_API_KEY", baseUrl: "https://attacker" }`. No request body can
 * repin an existing credential. A built-in name travels only to the origins
 * this file lists; a custom name is pinned when enrolled into host storage or
 * declared by the operator's environment pair `SMITHERS_MODEL_KEY_<NAME>` and
 * `SMITHERS_MODEL_KEY_<NAME>_ORIGIN`. That prefix prevents arbitrary env reads.
 *
 * Persistable models, catalogs and results hold no value. Enrollment's
 * write-only request is consumed by the host; provider execution reads the
 * secret only after {@link planModelBinding} has said where it may go.
 *
 * @since 1.0.0
 */

import { z } from "zod"
import { ModelIdSchema } from "./AgentRoles.ts"
import { PLUE_FAULTS } from "./PlueFailureCodes.ts"
import type { PlueFault } from "./PlueFailureCodes.ts"
import type { WorkerFailureCode } from "./WorkerFailureCodes.ts"

/**
 * The wire a configured model speaks, one per provider protocol family.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_PROTOCOLS = ["anthropic-messages", "openai-responses", "openai-chat", "evaluation"] as const
/**
 * Validates a model protocol at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelProtocolSchema = z.enum(MODEL_PROTOCOLS)
/**
 * The decoded value accepted by {@link ModelProtocolSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelProtocol = z.infer<typeof ModelProtocolSchema>

/**
 * What a model is asked for: text, or a calibrated answer to a closed question.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_KINDS = ["generation", "decision"] as const
/**
 * What a model is asked for.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelKind = (typeof MODEL_KINDS)[number]
/**
 * The kind a protocol serves. A record stores no kind, so the two cannot disagree.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelKindOf = (protocol: ModelProtocol): ModelKind => protocol === "evaluation" ? "decision" : "generation"

/**
 * The host answering: the desktop app's own Bun host, or the Cloudflare Worker.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelHost = "local" | "cloud"

/**
 * Each protocol's default base URL and fixed path. Only `openai-chat` has no
 * default origin and honours a record's own `path`.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_PROTOCOL_DEFAULTS: Readonly<
  Record<ModelProtocol, { readonly baseUrl: string | undefined; readonly path: string }>
> = {
  "anthropic-messages": { baseUrl: "https://api.anthropic.com", path: "/v1/messages" },
  "openai-responses": { baseUrl: "https://api.openai.com", path: "/v1/responses" },
  "openai-chat": { baseUrl: undefined, path: "/v1/chat/completions" },
  evaluation: { baseUrl: "https://ai-gateway.vercel.sh", path: "/v4/ai/evaluation-model" }
}

/**
 * The word that returns a seat to its host where a model's name would stand:
 * `model.assign <seat> default`, and the seat select's first option.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_SEAT_DEFAULT = "default"
/**
 * A configured model's name, which is also its id: the slug a person types.
 * Never {@link MODEL_SEAT_DEFAULT}, which a seat reads as "no model".
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_RECORD_ID = /^(?!default$)[a-z][a-z0-9-]{0,39}$/
/**
 * Validates a configured model's name at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelRecordIdSchema = z.string().regex(
  MODEL_RECORD_ID,
  "a model name is lowercase letters, digits and dashes, starting with a letter"
)
/**
 * The decoded value accepted by {@link ModelRecordIdSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelRecordId = z.infer<typeof ModelRecordIdSchema>

/**
 * A credential NAME: upper snake case, and never one ending in `ORIGIN`, which
 * is how a custom credential's origin declaration is spelled.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CREDENTIAL_NAME = /^(?!(?:.*_)?ORIGIN$)[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/
/**
 * Validates a credential name at the RPC boundary. A name, never a value.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelCredentialNameSchema = z.string().min(2).max(63).regex(
  MODEL_CREDENTIAL_NAME,
  "a credential is an upper-case name such as OPENAI_API_KEY"
)
/**
 * The decoded value accepted by {@link ModelCredentialNameSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCredentialName = z.infer<typeof ModelCredentialNameSchema>

/**
 * The built-in credentials and the ONLY origins each may be sent to. A host
 * reads a built-in from the environment name it is spelled by.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CREDENTIALS = [
  { name: "ANTHROPIC_API_KEY", origins: ["https://api.anthropic.com"] },
  { name: "OPENAI_API_KEY", origins: ["https://api.openai.com"] },
  { name: "CEREBRAS_API_KEY", origins: ["https://api.cerebras.ai"] },
  { name: "OPENROUTER_API_KEY", origins: ["https://openrouter.ai"] },
  { name: "AI_GATEWAY_API_KEY", origins: ["https://ai-gateway.vercel.sh"] }
] as const satisfies ReadonlyArray<{ readonly name: string; readonly origins: ReadonlyArray<string> }>
/**
 * The name of a built-in credential.
 *
 * @since 1.0.0
 * @category models
 */
export type BuiltinModelCredentialName = (typeof MODEL_CREDENTIALS)[number]["name"]
/**
 * Whether a name is one of the built-in credentials.
 *
 * @since 1.0.0
 * @category guards
 */
export const isBuiltinModelCredential = (name: string): name is BuiltinModelCredentialName =>
  MODEL_CREDENTIALS.some((row) => row.name === name)

/**
 * The mandatory prefix of a custom credential's environment variable:
 * `SMITHERS_MODEL_KEY_<NAME>` holds the value.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CREDENTIAL_ENV_PREFIX = "SMITHERS_MODEL_KEY_"
/**
 * The suffix of the variable declaring a custom credential's one origin:
 * `SMITHERS_MODEL_KEY_<NAME>_ORIGIN`.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CREDENTIAL_ORIGIN_SUFFIX = "_ORIGIN"

/**
 * An environment as a host hands it over: names to values, read by name only.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCredentialEnv = Readonly<Record<string, string | undefined>>

/**
 * The one environment variable a credential's value may be read from: the
 * standard name for a built-in, the prefixed name for everything else.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelCredentialEnvName = (name: string): string =>
  isBuiltinModelCredential(name) ? name : `${MODEL_CREDENTIAL_ENV_PREFIX}${name}`

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "[::1]" || hostname === "host.docker.internal" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname)

/**
 * An origin in canonical form, or undefined when a credential may never travel
 * there: https to any host, `http:` to a loopback or Docker host alias only, and no userinfo,
 * query or fragment.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelOriginOf = (value: string | undefined): string | undefined => {
  let url: URL
  try {
    url = new URL(value ?? "")
  } catch {
    return undefined
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined
  if (url.protocol === "https:") return url.origin
  return url.protocol === "http:" && isLoopbackHost(url.hostname) ? url.origin : undefined
}
/**
 * Whether a canonical origin is on this machine, including the Docker host alias.
 *
 * @since 1.0.0
 * @category guards
 */
export const isLoopbackOrigin = (origin: string): boolean => {
  try {
    return isLoopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * The custom credentials an operator declared: every
 * `SMITHERS_MODEL_KEY_<NAME>_ORIGIN` whose value is an origin a credential may
 * travel to. An unprefixed variable is never read, and a pair spelled with a
 * built-in's name declares nothing, so a built-in can never be re-pinned.
 *
 * @since 1.0.0
 * @category conversions
 */
export const customModelCredentials = (
  env: ModelCredentialEnv
): ReadonlyArray<{ readonly name: string; readonly origin: string }> =>
  Object.keys(env).sort().flatMap((key) => {
    if (!key.startsWith(MODEL_CREDENTIAL_ENV_PREFIX) || !key.endsWith(MODEL_CREDENTIAL_ORIGIN_SUFFIX)) return []
    const name = key.slice(MODEL_CREDENTIAL_ENV_PREFIX.length, -MODEL_CREDENTIAL_ORIGIN_SUFFIX.length)
    if (!ModelCredentialNameSchema.safeParse(name).success || isBuiltinModelCredential(name)) return []
    const origin = modelOriginOf(env[key])
    return origin === undefined ? [] : [{ name, origin }]
  })

/**
 * Validates one credential a host resolves: its name, whether a value is set,
 * and the origins it may travel to. No value exists on this wire.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelCredentialListingSchema = z.strictObject({
  name: ModelCredentialNameSchema,
  present: z.boolean(),
  origins: z.array(z.string().max(512)).max(8),
  managed: z.boolean().optional()
})
/**
 * The decoded value accepted by {@link ModelCredentialListingSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCredentialListing = z.infer<typeof ModelCredentialListingSchema>

/**
 * The credential table of a host that reads its environment: the built-ins,
 * then the operator's declared pairs. Only presence leaves this function.
 *
 * @since 1.0.0
 * @category conversions
 */
export const hostModelCredentials = (env: ModelCredentialEnv): ReadonlyArray<ModelCredentialListing> => {
  const present = (name: string): boolean => (env[modelCredentialEnvName(name)] ?? "").trim() !== ""
  return [
    ...MODEL_CREDENTIALS.map((row) => ({ name: row.name, present: present(row.name), origins: [...row.origins] })),
    ...customModelCredentials(env).map((row) => ({ name: row.name, present: present(row.name), origins: [row.origin] }))
  ]
}

/** Enrollment capability reported by the host.
 * @since 1.0.0
 * @category schemas
 */
export const ModelEnrollmentSchema = z.discriminatedUnion("available", [
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({
    available: z.literal(false),
    reason: z.enum(["local_host_required", "keychain_unavailable", "vault_unavailable", "sign_in_required"])
  })
])
/** A bounded identity for one host mutation.
 * @since 1.0.0
 * @category schemas
 */
export const ModelCredentialRequestIdSchema = z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/)
const credentialRequest = { requestId: ModelCredentialRequestIdSchema, name: ModelCredentialNameSchema }
const credentialValue = z.string().min(1).max(8192).refine((value) =>
  value.trim().length > 0 && !/[\r\n\0]/.test(value)
)
/** The only wire accepting a credential value. Never persist this request in the browser.
 * @since 1.0.0
 * @category schemas
 */
export const ModelCredentialRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...credentialRequest,
    action: z.literal("enroll"),
    origin: z.string().min(1).max(512),
    value: credentialValue
  }),
  z.strictObject({ ...credentialRequest, action: z.literal("rotate"), value: credentialValue }),
  z.strictObject({ ...credentialRequest, action: z.literal("remove") })
])
/** A write-only host request.
 * @since 1.0.0
 * @category models
 */
export type ModelCredentialRequest = z.infer<typeof ModelCredentialRequestSchema>
/** Closed failures; no exception or provider text may escape.
 * @since 1.0.0
 * @category schemas
 */
export const ModelCredentialFailureSchema = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("invalid"), field: z.enum(["name", "origin", "value", "requestId", "action"]) }),
  ...([
    "exists",
    "unknown",
    "read_only",
    "storage_unavailable",
    "vault_unavailable",
    "local_host_required",
    "interrupted"
  ] as const).map(
    (code) => z.strictObject({ code: z.literal(code) })
  ),
  z.strictObject({
    code: z.literal("host_refused"),
    status: z.number().nullable(),
    refusal: z.string().max(80).nullable()
  })
])
/** A safe enrollment failure.
 * @since 1.0.0
 * @category models
 */
export type ModelCredentialFailure = z.infer<typeof ModelCredentialFailureSchema>
/** Only metadata leaves storage, for either outcome.
 * @since 1.0.0
 * @category schemas
 */
export const ModelCredentialResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), credential: ModelCredentialListingSchema }),
  z.strictObject({
    ok: z.literal(false),
    failure: ModelCredentialFailureSchema,
    fault: z.enum(["user", "wait", "infra", "dependency", "bug"])
  })
])
/** A safe mutation result.
 * @since 1.0.0
 * @category models
 */
export type ModelCredentialResult = z.infer<typeof ModelCredentialResultSchema>
/** Build a typed failure without copying a caught exception.
 * @since 1.0.0
 * @category constructors
 */
export const failedModelCredential = (
  failure: ModelCredentialFailure,
  fault: PlueFault = failure.code === "storage_unavailable" ? "infra" : "user"
): ModelCredentialResult => ({ ok: false, failure, fault })
/** Reload reconciles metadata receipts, never resends the secret.
 * @since 1.0.0
 * @category schemas
 */
export const ModelCredentialReceiptSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unknown") }),
  z.strictObject({ state: z.literal("completed"), result: ModelCredentialResultSchema })
])
/** Safe metadata kept on the models card while work runs.
 * @since 1.0.0
 * @category schemas
 */
export const ModelCredentialPendingSchema = z.strictObject({
  ...credentialRequest,
  action: z.enum(["enroll", "rotate", "remove"]),
  origin: z.string().optional(),
  state: z.enum(["requested", "completed", "failed"]),
  failure: ModelCredentialFailureSchema.optional(),
  fault: z.enum(["user", "wait", "infra", "dependency", "bug"]).optional()
})

const modelShape = {
  protocol: ModelProtocolSchema,
  /** Absent means the protocol's default. Its origin must be one the credential is pinned to. */
  baseUrl: z.string().min(1).max(512).regex(/^\S+$/).optional(),
  /** Honoured for `openai-chat` only. */
  path: z.string().min(1).max(256).regex(/^\S+$/).optional(),
  /** The provider's model id, verbatim. */
  modelId: ModelIdSchema,
  credential: ModelCredentialNameSchema
}

/**
 * Validates a configured model. Flat, because a form renders one field per
 * property and no unions; the name is the id, so renaming saves a copy.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ConfiguredModelSchema = z.strictObject({
  id: ModelRecordIdSchema,
  ...modelShape,
  /** True only on a row the host reported. */
  builtin: z.boolean().optional()
})
/**
 * The decoded value accepted by {@link ConfiguredModelSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ConfiguredModel = z.infer<typeof ConfiguredModelSchema>

/**
 * Validates what a turn or a decision request carries to be answered on a
 * configured model: the record without its name. Never a value.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelBindingSchema = z.strictObject(modelShape)
/**
 * The decoded value accepted by {@link ModelBindingSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelBinding = z.infer<typeof ModelBindingSchema>
/**
 * The binding a record rides a request as.
 *
 * @since 1.0.0
 * @category conversions
 */
export const bindingOf = (model: ConfiguredModel): ModelBinding => ({
  protocol: model.protocol,
  ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
  ...(model.path === undefined ? {} : { path: model.path }),
  modelId: model.modelId,
  credential: model.credential
})

/**
 * The evaluation models a deployment key may be spent on. The form's select,
 * the planner and the Worker all read this tuple.
 *
 * @since 1.0.0
 * @category constants
 */
export const DECISION_MODEL_IDS = ["typesafe-ai/jev"] as const
/**
 * Validates an allowlisted decision model id at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const DecisionModelIdSchema = z.enum(DECISION_MODEL_IDS)
/**
 * The decoded value accepted by {@link DecisionModelIdSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type DecisionModelId = z.infer<typeof DecisionModelIdSchema>

/**
 * The seat ids, closed: a seat exists only while something reads it.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_SEAT_IDS = ["chat", "explainer", "front-door", "recommend"] as const
/**
 * Validates a seat id at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SeatIdSchema = z.enum(MODEL_SEAT_IDS)
/**
 * The decoded value accepted by {@link SeatIdSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type SeatId = z.infer<typeof SeatIdSchema>

/**
 * One seat: the kind of model it takes and the hosts that read it.
 *
 * @since 1.0.0
 * @category models
 */
export interface ModelSeat {
  readonly id: SeatId
  readonly label: string
  readonly kind: ModelKind
  readonly hosts: ReadonlyArray<ModelHost>
}
/**
 * The seats, each with a live reader: `explainer` is the sealed `agent.explain`
 * side turn, `front-door` and `recommend` are the Worker's two decision sites.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_SEATS = [
  { id: "chat", label: "Chat", kind: "generation", hosts: ["local"] },
  { id: "explainer", label: "Explainer", kind: "generation", hosts: ["local", "cloud"] },
  { id: "front-door", label: "Front door", kind: "decision", hosts: ["cloud"] },
  { id: "recommend", label: "Recommendations", kind: "decision", hosts: ["cloud"] }
] as const satisfies ReadonlyArray<ModelSeat>
/**
 * One seat's row.
 *
 * @since 1.0.0
 * @category accessors
 */
export const modelSeat = (id: SeatId): ModelSeat => MODEL_SEATS.find((seat) => seat.id === id) ?? MODEL_SEATS[0]
/**
 * The seat ids a host resolves, which is what its catalog lists.
 *
 * @since 1.0.0
 * @category accessors
 */
export const modelSeatsOf = (host: ModelHost): ReadonlyArray<SeatId> =>
  MODEL_SEATS.filter((seat) => (seat.hosts as ReadonlyArray<ModelHost>).includes(host)).map((seat) => seat.id)
/**
 * The one rule the assign flow, the reducer and the consumers share: a seat
 * takes only a model of its kind.
 *
 * @since 1.0.0
 * @category guards
 */
export const seatAccepts = (seat: SeatId, protocol: ModelProtocol): boolean =>
  modelSeat(seat).kind === modelKindOf(protocol)

/**
 * Validates a seat assignment. The row key is the seat: one model per seat,
 * and an unassigned seat has no row.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SeatAssignmentSchema = z.strictObject({ id: SeatIdSchema, recordId: ModelRecordIdSchema })
/**
 * The decoded value accepted by {@link SeatAssignmentSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type SeatAssignment = z.infer<typeof SeatAssignmentSchema>

/**
 * The one deadline a test runs under, headers and body. A timeout failure
 * echoes it as `deadlineMs`, and that record is what an interface reads.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_DEADLINE_MS = 15_000
/**
 * The ceiling of a test request body: a composed decision request carries a
 * state of up to {@link MODEL_CALL_STATE_MAX_BYTES} plus its questions.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_BODY_MAX_BYTES = 64 * 1024
/**
 * The output a generation test asks for, in tokens.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_MAX_TOKENS = 128
/**
 * The ceiling of the sample a passed test returns, in characters.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_SAMPLE_MAX = 80
/**
 * The one message a generation test sends.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_PROMPT = "Reply with the single word: ok"
/**
 * The one question a decision test asks.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_DECISION = {
  state: { text: "The sky is blue." },
  questions: { ok: { type: "boolean", instructions: "Does the text mention a color?" } }
} as const

/*
 * A composed call (the model-call card): the request a person edits and asks
 * a configured model, in place of the fixed Test input. A decision request is
 * one JSON state, authored as typed FIELDS so it renders as fields and never
 * as raw JSON, plus a map of typed questions; a generation request is a
 * prompt with a small parameter set. The question shapes and their limits
 * mirror `@smthrs/model`'s `Evaluator.Question` classes, which this module
 * cannot import (the rpc import law), so the limits are stated once in
 * {@link modelCallProblemOf} and the wire schema refuses through it.
 */

/**
 * The question kinds a decision model answers.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_QUESTION_TYPES = ["boolean", "choice", "score"] as const
/**
 * Validates a question kind.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelQuestionTypeSchema = z.enum(MODEL_QUESTION_TYPES)
/**
 * One question kind.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelQuestionType = z.infer<typeof ModelQuestionTypeSchema>
/**
 * The fewest options a choice question offers.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_QUESTION_OPTIONS_MIN = 2
/**
 * The most options a choice question offers.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_QUESTION_OPTIONS_MAX = 255
/**
 * The fewest rungs a score question orders.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_SCORE_RUNGS_MIN = 2
/**
 * The ceiling of a decision request's JSON state, in bytes.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CALL_STATE_MAX_BYTES = 32 * 1024
/**
 * The ceiling of a prompt, a system prompt, and the generated text a pass
 * carries, in characters.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CALL_TEXT_MAX = 16 * 1024
/**
 * The most output tokens a composed generation request may ask for.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CALL_MAX_TOKENS_MAX = 4096
/**
 * The longest name a choice option or a score rung may take, in characters.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CALL_NAME_MAX = 128
/**
 * The highest sampling temperature a composed generation request may ask
 * for; the lowest is 0.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CALL_TEMPERATURE_MAX = 2
/**
 * The longest temperature text a draft keeps, in characters.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_CALL_TEMPERATURE_TEXT_MAX = 32
/**
 * The name no option or rung may take: a plain object takes it as its
 * prototype, never as a key, so a distribution would lose that entry.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_NAME_RESERVED = "__proto__"

const criteriaName = z.string().min(1).max(MODEL_CALL_NAME_MAX)
/** A record parse drops the reserved key silently, so the own key is refused before the record is read. */
const unreserved = <Value>() =>
  z.custom<Record<string, Value>>((value) =>
    typeof value !== "object" || value === null || !Object.hasOwn(value, MODEL_NAME_RESERVED)
  )
const ChoiceCriteriaSchema = unreserved<string>().pipe(z.record(criteriaName, z.string().max(MODEL_CALL_TEXT_MAX)))

const questionShape = { instructions: z.string().max(MODEL_CALL_TEXT_MAX) }

/**
 * Validates one question as it crosses the wire: the same three shapes as
 * `Evaluator.Question`. The count and distinctness limits are
 * {@link modelCallProblemOf}'s, so a draft can hold a question that is not
 * yet askable. An option named {@link MODEL_NAME_RESERVED} is refused here,
 * because a record cannot hold it; a rung so named is held and named as a
 * problem.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelQuestionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("boolean"),
    ...questionShape,
    criteria: z.strictObject({ true: z.string().max(MODEL_CALL_TEXT_MAX), false: z.string().max(MODEL_CALL_TEXT_MAX) })
      .optional()
  }),
  z.strictObject({
    type: z.literal("choice"),
    ...questionShape,
    criteria: ChoiceCriteriaSchema
  }),
  z.strictObject({
    type: z.literal("score"),
    ...questionShape,
    criteria: z.array(criteriaName).max(MODEL_QUESTION_OPTIONS_MAX)
  })
])
/**
 * The decoded value accepted by {@link ModelQuestionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelQuestion = z.infer<typeof ModelQuestionSchema>

/**
 * How a state field is authored and drawn. The kind decides the control, and
 * `boolean`, `number` and `json` decide the JSON value the field becomes.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_FIELD_KINDS = ["text", "code", "path", "diff", "terminal", "boolean", "number", "json"] as const
/**
 * Validates a state field's kind.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelFieldKindSchema = z.enum(MODEL_FIELD_KINDS)
/**
 * One state field kind.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelFieldKind = z.infer<typeof ModelFieldKindSchema>
/**
 * The key a state field or a question may take: one JSON object key. Never
 * `__proto__`, which a plain object takes as its prototype, not as a key.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_FIELD_KEY = /^(?!__proto__$)[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
/**
 * Validates one authored state field. The value is always text; the kind says
 * what JSON it becomes ({@link modelStateOf}).
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelStateFieldSchema = z.strictObject({
  key: z.string().regex(MODEL_FIELD_KEY),
  kind: ModelFieldKindSchema,
  value: z.string().max(MODEL_CALL_STATE_MAX_BYTES * 4)
})
/**
 * The decoded value accepted by {@link ModelStateFieldSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelStateField = z.infer<typeof ModelStateFieldSchema>

const DecisionCallSchema = z.strictObject({
  kind: z.literal("decision"),
  state: z.array(ModelStateFieldSchema).max(64),
  // The key rule never sees the reserved id: the record parse drops it first, and the request would pass with the question gone.
  questions: unreserved<ModelQuestion>().pipe(z.record(z.string().regex(MODEL_FIELD_KEY), ModelQuestionSchema))
})
const generationCallShape = {
  kind: z.literal("generation"),
  system: z.string().max(MODEL_CALL_TEXT_MAX),
  prompt: z.string().max(MODEL_CALL_TEXT_MAX),
  maxTokens: z.number().int()
}

/**
 * Validates a composed request as a DRAFT: the shape, without the limits, so
 * the composer can hold a request that is not yet askable and say why. The
 * temperature is the text as typed, so what is on screen is what is kept;
 * {@link modelCallInputOf} makes it the wire's number. A number is a draft
 * written before the text was kept, and is read as that number.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelCallDraftSchema = z.discriminatedUnion("kind", [
  DecisionCallSchema,
  z.strictObject({
    ...generationCallShape,
    temperature: z.union([z.string().max(MODEL_CALL_TEMPERATURE_TEXT_MAX), z.number()]).optional()
  })
])
/**
 * The decoded value accepted by {@link ModelCallDraftSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCallDraft = z.infer<typeof ModelCallDraftSchema>
/**
 * Why a draft cannot be asked yet, as the composer states it inline. Each
 * carries the question or field it names and the number the limit is about.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCallProblem =
  | { readonly code: "no_questions" }
  | { readonly code: "question_empty"; readonly question: string }
  | { readonly code: "options_count"; readonly question: string; readonly count: number }
  | { readonly code: "rungs_count"; readonly question: string; readonly count: number }
  | { readonly code: "rungs_distinct"; readonly question: string }
  | { readonly code: "field_invalid"; readonly key: string; readonly kind: ModelFieldKind }
  | { readonly code: "field_duplicate"; readonly key: string }
  | { readonly code: "state_size"; readonly bytes: number; readonly max: number }
  | { readonly code: "name_reserved"; readonly question: string; readonly name: string }
  | { readonly code: "prompt_empty" }
  | { readonly code: "max_tokens"; readonly max: number }
  | { readonly code: "temperature"; readonly max: number }

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** The JSON value one field becomes, or undefined when its text is not one of its kind. */
const fieldValueOf = (field: ModelStateField): { readonly value: unknown } | undefined => {
  switch (field.kind) {
    case "boolean":
      return field.value === "true" || field.value === "false" ? { value: field.value === "true" } : undefined
    case "number": {
      const number = field.value.trim() === "" ? Number.NaN : Number(field.value)
      return Number.isFinite(number) ? { value: number } : undefined
    }
    case "json":
      try {
        return { value: JSON.parse(field.value) }
      } catch {
        return undefined
      }
    default:
      return { value: field.value }
  }
}

/**
 * The one JSON object a decision request's fields become: the state the model
 * reads. A field whose text is not of its kind is skipped; {@link modelCallProblemOf}
 * names it first.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelStateOf = (fields: ReadonlyArray<ModelStateField>): Record<string, unknown> => {
  // No prototype: a key an unvalidated caller lets through is still a key, never this object's prototype.
  const state: Record<string, unknown> = Object.create(null)
  for (const field of fields) {
    const decoded = fieldValueOf(field)
    if (decoded !== undefined) state[field.key] = decoded.value
  }
  return state
}

/**
 * A recorded JSON state back as authored fields, one per top-level key: a
 * string is text, a boolean and a number their own kinds, anything nested is
 * json. A state that is not an object is one `state` field.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelStateFieldsOf = (state: unknown): ReadonlyArray<ModelStateField> => {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return [
      typeof state === "string"
        ? { key: "state", kind: "text", value: state }
        : { key: "state", kind: "json", value: JSON.stringify(state ?? null) }
    ]
  }
  return Object.entries(state).map(([key, value]) => {
    const safeKey = MODEL_FIELD_KEY.test(key) ? key : "state"
    if (typeof value === "string") return { key: safeKey, kind: "text", value }
    if (typeof value === "boolean") return { key: safeKey, kind: "boolean", value: String(value) }
    if (typeof value === "number" && Number.isFinite(value)) {
      return { key: safeKey, kind: "number", value: String(value) }
    }
    return { key: safeKey, kind: "json", value: JSON.stringify(value ?? null) }
  })
}

/** Plain decimal digits only: `Number` also reads hex, exponents and blanks, which no temperature field shows as a number. */
const TEMPERATURE_TEXT = /^(?:\d+\.?\d*|\.\d+)$/

/** The number a drafted temperature is, or undefined when it is not one from 0 to {@link MODEL_CALL_TEMPERATURE_MAX}. */
const temperatureOf = (typed: string | number): number | undefined => {
  const value = typeof typed === "number" ? typed : TEMPERATURE_TEXT.test(typed) ? Number(typed) : Number.NaN
  return value >= 0 && value <= MODEL_CALL_TEMPERATURE_MAX ? value : undefined
}

/**
 * The first reason a draft cannot be asked, or undefined when it can. The
 * limits are the question classes' own: a choice offers 2 to 255 options, a
 * score orders at least 2 distinct rungs, none named
 * {@link MODEL_NAME_RESERVED}, a question says something, a state fits
 * {@link MODEL_CALL_STATE_MAX_BYTES}, a temperature is a number from 0 to
 * {@link MODEL_CALL_TEMPERATURE_MAX}.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelCallProblemOf = (draft: ModelCallDraft): ModelCallProblem | undefined => {
  if (draft.kind === "generation") {
    if (draft.prompt.trim() === "") return { code: "prompt_empty" }
    if (draft.maxTokens < 1 || draft.maxTokens > MODEL_CALL_MAX_TOKENS_MAX) {
      return { code: "max_tokens", max: MODEL_CALL_MAX_TOKENS_MAX }
    }
    if (draft.temperature !== undefined && temperatureOf(draft.temperature) === undefined) {
      return { code: "temperature", max: MODEL_CALL_TEMPERATURE_MAX }
    }
    return undefined
  }
  const seen = new Set<string>()
  for (const field of draft.state) {
    if (seen.has(field.key)) return { code: "field_duplicate", key: field.key }
    seen.add(field.key)
    if (fieldValueOf(field) === undefined) return { code: "field_invalid", key: field.key, kind: field.kind }
  }
  const bytes = utf8Bytes(JSON.stringify(modelStateOf(draft.state)))
  if (bytes > MODEL_CALL_STATE_MAX_BYTES) return { code: "state_size", bytes, max: MODEL_CALL_STATE_MAX_BYTES }
  const questions = Object.entries(draft.questions)
  if (questions.length === 0) return { code: "no_questions" }
  for (const [question, shape] of questions) {
    if (shape.instructions.trim() === "") return { code: "question_empty", question }
    if (shape.type === "choice") {
      const count = Object.keys(shape.criteria).length
      if (count < MODEL_QUESTION_OPTIONS_MIN || count > MODEL_QUESTION_OPTIONS_MAX) {
        return { code: "options_count", question, count }
      }
    }
    if (shape.type === "score") {
      if (shape.criteria.length < MODEL_SCORE_RUNGS_MIN) {
        return { code: "rungs_count", question, count: shape.criteria.length }
      }
      if (new Set(shape.criteria).size !== shape.criteria.length) return { code: "rungs_distinct", question }
      if (shape.criteria.includes(MODEL_NAME_RESERVED)) {
        return { code: "name_reserved", question, name: MODEL_NAME_RESERVED }
      }
    }
  }
  return undefined
}

/**
 * Validates a composed request as a host runs it: a draft with no problem,
 * its temperature a number.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelCallInputSchema = z.discriminatedUnion("kind", [
  DecisionCallSchema,
  z.strictObject({
    ...generationCallShape,
    temperature: z.number().min(0).max(MODEL_CALL_TEMPERATURE_MAX).optional()
  })
]).check((context) => {
  const problem = modelCallProblemOf(context.value)
  if (problem !== undefined) context.issues.push({ code: "custom", input: context.value, message: problem.code })
})
/**
 * The decoded value accepted by {@link ModelCallInputSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCallInput = z.infer<typeof ModelCallInputSchema>

/**
 * The request a host runs for a draft: the draft itself, its temperature the
 * number its text is. Undefined while the draft has a problem, so a value
 * that is not on screen is never sent in its place.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelCallInputOf = (draft: ModelCallDraft): ModelCallInput | undefined => {
  if (modelCallProblemOf(draft) !== undefined) return undefined
  if (draft.kind === "decision") return draft
  const { temperature: typed, ...rest } = draft
  const temperature = typed === undefined ? undefined : temperatureOf(typed)
  return temperature === undefined ? rest : { ...rest, temperature }
}

/**
 * The request a Test runs when none is composed: the fixed prompt, or the
 * fixed state and its one boolean question, as fields.
 *
 * @since 1.0.0
 * @category constructors
 */
export const modelCallDefault = (kind: ModelKind): ModelCallInput =>
  kind === "generation"
    ? { kind, system: "", prompt: MODEL_TEST_PROMPT, maxTokens: MODEL_TEST_MAX_TOKENS }
    : {
      kind,
      state: [...modelStateFieldsOf(MODEL_TEST_DECISION.state)],
      questions: { ok: { type: "boolean", instructions: MODEL_TEST_DECISION.questions.ok.instructions } }
    }

const Probability = z.number().min(0).max(1)

/**
 * A distribution read key by key. A record parse drops an entry named
 * {@link MODEL_NAME_RESERVED}, and that entry's mass with it; a provider may
 * send one, and a decoded answer may hold one.
 */
const distributionSchema = (entry: z.ZodType<number>) =>
  z.custom<Record<string, number>>((value) =>
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((probability) => entry.safeParse(probability).success)
  )

/**
 * Validates one typed answer, as the classifier decodes it: a boolean's value
 * and probability; a choice's option, distribution and confidence; a score's
 * value, nearest rung and distribution.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelAnswerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("boolean"), value: z.boolean(), probability: Probability }),
  z.strictObject({
    type: z.literal("choice"),
    value: z.string(),
    probabilities: distributionSchema(Probability),
    confidence: Probability
  }),
  z.strictObject({
    type: z.literal("score"),
    value: z.number().finite(),
    label: z.string(),
    probabilities: distributionSchema(Probability),
    confidence: Probability
  })
])
/**
 * The decoded value accepted by {@link ModelAnswerSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelAnswer = z.infer<typeof ModelAnswerSchema>

/**
 * Validates what a passed call produced: one typed answer per question, or
 * the generated text, scrubbed and bounded.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelCallOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("decision"), answers: z.record(z.string(), ModelAnswerSchema) }),
  z.strictObject({ kind: z.literal("generation"), text: z.string().max(MODEL_CALL_TEXT_MAX) })
])
/**
 * The decoded value accepted by {@link ModelCallOutputSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCallOutput = z.infer<typeof ModelCallOutputSchema>

const RawAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), probability: z.number() }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: distributionSchema(z.number()).optional()
  }),
  z.object({ type: z.literal("score"), score: z.number(), probabilities: distributionSchema(z.number()).optional() })
])

const isUnit = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1

/** A distribution over `keys`, one-hot on `chosen` when the provider sent none; undefined when a probability is not one. */
const distributionOf = (
  keys: ReadonlyArray<string>,
  chosen: string,
  given: Readonly<Record<string, number>> | undefined,
  alias: (index: number) => string
): Record<string, number> | undefined => {
  // No prototype, as the classifier's: a key is an entry whatever it is called.
  const probabilities: Record<string, number> = Object.create(null)
  for (const [index, key] of keys.entries()) {
    const provided = given === undefined
      ? undefined
      : Object.hasOwn(given, alias(index))
      ? given[alias(index)]
      : undefined
    const probability = provided ?? (given === undefined && key === chosen ? 1 : 0)
    if (!isUnit(probability)) return undefined
    probabilities[key] = probability
  }
  return probabilities
}

/**
 * Decodes a provider's raw answers against the questions they answer, the
 * way `Classifier.decodeAnswers` does on the local host: every question needs
 * an answer of its own type, a boolean's probability and every distribution
 * entry lie in [0, 1], a choice names one of its options, a score lies within
 * its rungs. A host that cannot import the classifier decodes here.
 *
 * @since 1.0.0
 * @category conversions
 */
export const decodeModelAnswers = (
  questions: Readonly<Record<string, ModelQuestion>>,
  raw: unknown
): { readonly ok: true; readonly answers: Record<string, ModelAnswer> } | { readonly ok: false } => {
  const no = { ok: false } as const
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return no
  const answers: Record<string, ModelAnswer> = Object.create(null)
  for (const [id, question] of Object.entries(questions)) {
    const parsed = RawAnswerSchema.safeParse(Object.hasOwn(raw, id) ? (raw as Record<string, unknown>)[id] : undefined)
    if (!parsed.success || parsed.data.type !== question.type) return no
    const answer = parsed.data
    switch (answer.type) {
      case "boolean": {
        if (!isUnit(answer.probability)) return no
        answers[id] = { type: "boolean", value: answer.probability >= 0.5, probability: answer.probability }
        break
      }
      case "choice": {
        const keys = Object.keys((question as Extract<ModelQuestion, { type: "choice" }>).criteria)
        if (!keys.includes(answer.choice)) return no
        const probabilities = distributionOf(keys, answer.choice, answer.probabilities, (index) => keys[index]!)
        if (probabilities === undefined) return no
        answers[id] = {
          type: "choice",
          value: answer.choice,
          probabilities,
          confidence: Math.max(...Object.values(probabilities))
        }
        break
      }
      case "score": {
        const rungs = (question as Extract<ModelQuestion, { type: "score" }>).criteria
        if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > rungs.length - 1) return no
        const label = rungs[Math.round(answer.score)]!
        const supplied = Object.keys(answer.probabilities ?? {})
        const indexes = rungs.map((_, index) => String(index))
        // One key space for the whole dictionary: every key an index, else every key a label.
        const byIndex = supplied.every((key) => indexes.includes(key))
        if (!byIndex && !supplied.every((key) => rungs.includes(key))) return no
        const probabilities = distributionOf(
          rungs,
          label,
          answer.probabilities,
          (index) => byIndex ? indexes[index]! : rungs[index]!
        )
        if (probabilities === undefined) return no
        answers[id] = {
          type: "score",
          value: answer.score,
          label,
          probabilities,
          confidence: Math.max(...Object.values(probabilities))
        }
        break
      }
    }
  }
  return { ok: true, answers }
}

/**
 * The row's sample of what a call produced: the generated words, scrubbed
 * and cut ({@link scrubModelSample}), or the first answer as its value and
 * its number, the way the fixed Test has always sampled `true 0.97`.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelCallSample = (output: ModelCallOutput, secret: string): string => {
  if (output.kind === "generation") return scrubModelSample(output.text, secret)
  const first = Object.values(output.answers)[0]
  if (first === undefined) return ""
  const line = first.type === "boolean"
    ? `${first.value} ${first.probability.toFixed(2)}`
    : first.type === "choice"
    ? `${first.value} ${first.confidence.toFixed(2)}`
    : `${first.label} ${first.confidence.toFixed(2)}`
  return scrubModelSample(line, secret)
}

/**
 * Validates a test request: the whole record, so a draft can be tested before
 * it is saved, and the composed input when a person asked one; with none the
 * host runs its fixed Test ({@link modelCallDefault}).
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelTestRequestSchema = z.strictObject({
  model: ConfiguredModelSchema,
  input: ModelCallInputSchema.optional()
})
/**
 * The decoded value accepted by {@link ModelTestRequestSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelTestRequest = z.infer<typeof ModelTestRequestSchema>

/**
 * The record fields an `invalid` failure may name; `model` is the record as a whole.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_INVALID_FIELDS = ["model", "protocol", "baseUrl", "path", "modelId", "credential"] as const
/**
 * A record field an `invalid` failure names.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelInvalidField = (typeof MODEL_INVALID_FIELDS)[number]

/**
 * Every way a configured model fails, by code.
 *
 * - `unreachable` no answer came back from the endpoint.
 * - `empty_output` the endpoint answered success with no model output at all.
 * - `refused` the endpoint answered with this status; a redirect is never followed, so a 3xx is one.
 * - `timeout` the deadline the failure states ran out.
 * - `invalid` the named field cannot be served, or the endpoint does not speak the protocol.
 * - `credential_missing` the host lists the name and holds no value for it.
 * - `credential_unknown` the host does not list the name.
 * - `endpoint_forbidden` the credential is not pinned to the base URL's origin.
 * - `model_not_allowed` a deployment key was asked for a decision model off {@link DECISION_MODEL_IDS}.
 * - `host_refused` the host itself refused or never answered; written by the client, never by a host.
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_FAILURE_CODES = [
  "unreachable",
  "empty_output",
  "refused",
  "timeout",
  "invalid",
  "credential_missing",
  "credential_unknown",
  "endpoint_forbidden",
  "model_not_allowed",
  "host_refused"
] as const

/** A refusal registry code's alphabet, so the one string a client writes into a failure is never prose. */
const HOST_REFUSAL_CODE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/

/**
 * Validates a model failure. Codes, numbers, enums and the echoed credential
 * NAME only: no branch has a field a provider's words, a URL or a key could
 * ride in, and every branch is strict.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelTestFailureSchema = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("unreachable") }),
  z.strictObject({ code: z.literal("empty_output") }),
  z.strictObject({ code: z.literal("refused"), status: z.number().int().min(300).max(599) }),
  z.strictObject({ code: z.literal("timeout"), deadlineMs: z.number().int().positive() }),
  z.strictObject({ code: z.literal("invalid"), field: z.enum(MODEL_INVALID_FIELDS) }),
  z.strictObject({ code: z.literal("credential_missing"), credential: ModelCredentialNameSchema }),
  z.strictObject({ code: z.literal("credential_unknown"), credential: ModelCredentialNameSchema }),
  z.strictObject({ code: z.literal("endpoint_forbidden") }),
  z.strictObject({ code: z.literal("model_not_allowed") }),
  z.strictObject({
    code: z.literal("host_refused"),
    /** The refusal's registry code (Refusal.ts), null when it carried none. */
    refusal: z.string().regex(HOST_REFUSAL_CODE).nullable(),
    /** Null when no response came back at all. */
    status: z.number().int().min(100).max(599).nullable(),
    /** The refusal's own fault: the registry judged it, this union does not. */
    fault: z.enum(PLUE_FAULTS)
  })
])
/**
 * The decoded value accepted by {@link ModelTestFailureSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelTestFailure = z.infer<typeof ModelTestFailureSchema>

/**
 * Whose problem a model failure is. An exhaustive switch, so a new code does
 * not compile until it has a fault. An unset key is the reader's own on their
 * machine and the deployment's on the Worker.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelFailureFault = (failure: ModelTestFailure, host: ModelHost): PlueFault => {
  switch (failure.code) {
    case "unreachable":
      return "dependency"
    case "empty_output":
      return "dependency"
    case "timeout":
      return "dependency"
    case "refused":
      return failure.status === 429 ? "wait" : failure.status >= 500 ? "dependency" : "user"
    case "invalid":
      return "user"
    case "credential_unknown":
      return "user"
    case "endpoint_forbidden":
      return "user"
    case "model_not_allowed":
      return "user"
    case "credential_missing":
      return host === "cloud" ? "infra" : "user"
    case "host_refused":
      return failure.fault
  }
}

/**
 * The Worker-vocabulary code a host refuses a TURN with when its model binding
 * fails. The test route never uses it: a test answers 200 with the failure.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelFailureRefusalCode = (failure: ModelTestFailure): WorkerFailureCode => {
  switch (failure.code) {
    case "invalid":
    case "credential_unknown":
    case "endpoint_forbidden":
    case "model_not_allowed":
      return "request_invalid"
    case "credential_missing":
      return "seam_not_configured"
    case "unreachable":
      return "upstream_unreachable"
    case "empty_output":
      return "upstream_refused"
    case "timeout":
      return "upstream_timeout"
    case "refused":
      return failure.status === 429 ? "model_rate_limited" : "upstream_refused"
    case "host_refused":
      return "unexpected_failure"
  }
}

/**
 * Validates a test's answer. Both outcomes are an HTTP 200: a failed test is
 * an answer, and only a refusal to run one uses the refusal envelopes.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelTestResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    latencyMs: z.number().int().nonnegative(),
    /** The model's own words, scrubbed and cut by {@link scrubModelSample}. */
    sample: z.string().max(MODEL_TEST_SAMPLE_MAX),
    /** What the call produced, typed; a host that ran the request carries it, and the composer prefills from it. */
    output: ModelCallOutputSchema.optional()
  }),
  z.strictObject({
    ok: z.literal(false),
    latencyMs: z.number().int().nonnegative(),
    failure: ModelTestFailureSchema,
    fault: z.enum(PLUE_FAULTS)
  })
])
/**
 * The decoded value accepted by {@link ModelTestResultSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelTestResult = z.infer<typeof ModelTestResultSchema>

/**
 * A failed result whose fault is looked up, never chosen at the call site.
 *
 * @since 1.0.0
 * @category conversions
 */
export const failedModelTest = (failure: ModelTestFailure, latencyMs: number, host: ModelHost): ModelTestResult => ({
  ok: false,
  latencyMs: Math.max(0, Math.round(latencyMs)),
  failure,
  fault: modelFailureFault(failure, host)
})

/**
 * The result a CLIENT stores when the host refused to run the test or never
 * answered: the refusal's registry code, status and fault (Refusal.ts), and
 * never its message.
 *
 * @since 1.0.0
 * @category conversions
 */
export const hostRefusedModelTest = (
  refusal: { readonly code: string | null; readonly status: number | null; readonly fault: PlueFault },
  latencyMs: number
): Extract<ModelTestResult, { ok: false }> => {
  const code = refusal.code !== null && HOST_REFUSAL_CODE.test(refusal.code) ? refusal.code : null
  const status = refusal.status !== null && Number.isInteger(refusal.status) && refusal.status >= 100 &&
      refusal.status <= 599 ?
    refusal.status :
    null
  return {
    ok: false,
    latencyMs: Math.max(0, Math.round(latencyMs)),
    failure: { code: "host_refused", refusal: code, status, fault: refusal.fault },
    fault: refusal.fault
  }
}

/**
 * Provider text with a credential's value cut out of it. Model output is
 * attacker-controlled on a custom endpoint, so every host cuts an echoed key
 * with this one rule, in a Test's sample and in a turn's text alike.
 *
 * @since 1.0.0
 * @category conversions
 */
export const cutModelCredential = (text: string, secret: string): string => {
  let kept = text
  // Again until none is left: cutting one echo out can join the halves of another.
  while (secret !== "" && kept.includes(secret)) kept = kept.split(secret).join("")
  return kept
}

/**
 * A sample fit to leave a host: the echoed key is cut out before anything
 * else happens.
 *
 * @since 1.0.0
 * @category conversions
 */
export const scrubModelSample = (text: string, secret: string): string =>
  cutModelCredential(text, secret).replace(/\s+/g, " ").trim().slice(0, MODEL_TEST_SAMPLE_MAX)

/**
 * Where a model's requests go, once its credential allowed it.
 *
 * @since 1.0.0
 * @category models
 */
export interface ResolvedModelEndpoint {
  readonly origin: string
  /** Canonical, with no trailing slash. */
  readonly baseUrl: string
  readonly path: string
  readonly url: string
}

/**
 * What a host that cannot leave the machine passes: `egress: false` admits loopback only.
 *
 * @since 1.0.0
 * @category models
 */
export interface ModelEndpointOptions {
  readonly egress?: boolean
}

const failed = (failure: ModelTestFailure) => ({ ok: false, failure }) as const

const pathIsSafe = (path: string): boolean =>
  path.startsWith("/") && !path.startsWith("//") && !/[?#\\]/.test(path) &&
  !path.split("/").some((segment) => segment === "." || segment === ".." || /%2e/i.test(segment))

/**
 * The one rule that decides where a credential may travel. `credentials` is
 * the HOST's table, never the request's: the base URL's origin must be one the
 * named credential is pinned to, or the answer is `endpoint_forbidden`.
 *
 * @since 1.0.0
 * @category conversions
 */
export const resolveModelEndpoint = (
  model: Pick<ConfiguredModel, "protocol" | "baseUrl" | "path" | "credential">,
  credentials: ReadonlyArray<ModelCredentialListing>,
  options: ModelEndpointOptions = {}
): { readonly ok: true; readonly endpoint: ResolvedModelEndpoint } | {
  readonly ok: false
  readonly failure: ModelTestFailure
} => {
  const credential = credentials.find((row) => row.name === model.credential)
  if (credential === undefined) return failed({ code: "credential_unknown", credential: model.credential })
  const defaults = MODEL_PROTOCOL_DEFAULTS[model.protocol]
  const raw = model.baseUrl ?? defaults.baseUrl
  if (raw === undefined) return failed({ code: "invalid", field: "baseUrl" })
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return failed({ code: "invalid", field: "baseUrl" })
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return failed({ code: "invalid", field: "baseUrl" })
  }
  // Canonicalised again here, so a table cannot admit what a declaration could not.
  const origin = modelOriginOf(url.origin)
  if (origin === undefined || !credential.origins.includes(origin)) return failed({ code: "endpoint_forbidden" })
  if (options.egress === false && !isLoopbackOrigin(origin)) return failed({ code: "endpoint_forbidden" })
  if (model.protocol !== "openai-chat" && model.path !== undefined && model.path !== defaults.path) {
    return failed({ code: "invalid", field: "path" })
  }
  const path = model.path ?? defaults.path
  if (!pathIsSafe(path)) return failed({ code: "invalid", field: "path" })
  const baseUrl = url.toString().replace(/\/+$/, "")
  const target = `${baseUrl}${path}`
  if (modelOriginOf(new URL(target).origin) !== origin) return failed({ code: "invalid", field: "path" })
  return { ok: true, endpoint: { origin, baseUrl, path, url: target } }
}

/**
 * A binding a host has agreed to serve: a credential NAME and an address,
 * never a value. The host reads the secret by that name afterwards.
 *
 * @since 1.0.0
 * @category models
 */
export interface ModelPlan extends ResolvedModelEndpoint {
  readonly kind: ModelKind
  readonly protocol: ModelProtocol
  readonly modelId: string
  readonly credential: string
}

/**
 * What the caller requires of a binding: the kind its seat takes, and whether this host has egress.
 *
 * @since 1.0.0
 * @category models
 */
export interface ModelPlanOptions extends ModelEndpointOptions {
  readonly kind?: ModelKind
}

/**
 * A plan, or the typed reason there is none.
 *
 * @since 1.0.0
 * @category models
 */
export type PlannedModel =
  | { readonly ok: true; readonly plan: ModelPlan }
  | { readonly ok: false; readonly failure: ModelTestFailure }

/**
 * An untrusted binding and a host's credential table in; a credential-free
 * plan or a typed failure out. Pure: no I/O, no value. Where a credential may
 * go is judged before whether it is set, so an unset key never excuses a
 * foreign origin. The decision allowlist binds the built-in credentials, which
 * are deployment keys; an operator's own endpoint names its own models.
 *
 * @since 1.0.0
 * @category conversions
 */
export const planModelBinding = (
  input: unknown,
  credentials: ReadonlyArray<ModelCredentialListing>,
  options: ModelPlanOptions = {}
): PlannedModel => {
  const parsed = ModelBindingSchema.safeParse(input)
  if (!parsed.success) {
    const named = parsed.error.issues[0]?.path[0]
    const field = MODEL_INVALID_FIELDS.find((candidate) => candidate === named) ?? "model"
    return failed({ code: "invalid", field })
  }
  const binding = parsed.data
  const kind = modelKindOf(binding.protocol)
  if (options.kind !== undefined && options.kind !== kind) return failed({ code: "invalid", field: "protocol" })
  const resolved = resolveModelEndpoint(binding, credentials, options)
  if (!resolved.ok) return resolved
  if (
    kind === "decision" && isBuiltinModelCredential(binding.credential) &&
    !DecisionModelIdSchema.safeParse(binding.modelId).success
  ) {
    return failed({ code: "model_not_allowed" })
  }
  if (credentials.find((row) => row.name === binding.credential)?.present !== true) {
    return failed({ code: "credential_missing", credential: binding.credential })
  }
  return {
    ok: true,
    plan: {
      kind,
      protocol: binding.protocol,
      modelId: binding.modelId,
      credential: binding.credential,
      ...resolved.endpoint
    }
  }
}

/**
 * The rows of a host's built-in list that host can serve: a row is listed only
 * when a Test of it there would plan, so its key is set and its endpoint is
 * one the host's egress reaches. Both hosts list through this one rule.
 *
 * @since 1.0.0
 * @category conversions
 */
export const servableModels = (
  rows: ReadonlyArray<ConfiguredModel>,
  credentials: ReadonlyArray<ModelCredentialListing>,
  options: ModelPlanOptions = {}
): ReadonlyArray<ConfiguredModel> => rows.filter((row) => planModelBinding(bindingOf(row), credentials, options).ok)

/**
 * Validates `GET /api/model/catalog`: the built-in models this host serves,
 * the credential names it resolves, and the seats it reads. Never a value.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelCatalogSchema = z.strictObject({
  models: z.array(ConfiguredModelSchema).max(64),
  credentials: z.array(ModelCredentialListingSchema).max(64),
  seats: z.array(SeatIdSchema).max(MODEL_SEAT_IDS.length),
  enrollment: ModelEnrollmentSchema.optional()
})
/**
 * The decoded value accepted by {@link ModelCatalogSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>

/**
 * Validates the last test of one model as it is stored and shown.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelTestRecordSchema = z.strictObject({
  id: ModelRecordIdSchema,
  testedAt: z.number().finite(),
  result: ModelTestResultSchema
})
/**
 * The decoded value accepted by {@link ModelTestRecordSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelTestRecord = z.infer<typeof ModelTestRecordSchema>

/**
 * The states a model row's test mark reads as (`data-test-state`).
 *
 * @since 1.0.0
 * @category constants
 */
export const MODEL_TEST_STATES = ["idle", "running", "passed", "failed"] as const
/**
 * One state of a model row's test mark.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelTestState = (typeof MODEL_TEST_STATES)[number]
/**
 * The state of one model row: running while its test is out, otherwise what
 * its last result says, and idle when it has none.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelTestStateOf = (test: ModelTestRecord | undefined, running: boolean): ModelTestState =>
  running ? "running" : test === undefined ? "idle" : test.result.ok ? "passed" : "failed"

/**
 * The one fix a failed test offers, chosen by the fault its result carries:
 * the record's own mistake (`user`) is edited, and any other fault is not the
 * record's, so the test is tried again. A host row cannot be edited.
 *
 * @since 1.0.0
 * @category conversions
 */
export const modelTestFixOf = (builtin: boolean, result: ModelTestResult | undefined): "test" | "edit" =>
  builtin || (result?.ok === false && result.fault !== "user") ? "test" : "edit"

/**
 * Validates the `models` card's payload (Cards.ts).
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelsCardPayloadSchema = z.object({
  models: z.array(ConfiguredModelSchema),
  /** Only the seats the host listed; a null `recordId` means the host's default answers. */
  seats: z.array(z.strictObject({
    id: SeatIdSchema,
    recordId: ModelRecordIdSchema.nullable(),
    /** False when the assigned record is gone or its credential is not present. */
    resolvable: z.boolean()
  })),
  /** Names, presence and origins. No value exists on this wire. */
  credentials: z.array(ModelCredentialListingSchema),
  enrollment: ModelEnrollmentSchema.optional(),
  credentialRequests: z.array(ModelCredentialPendingSchema).max(64).optional(),
  /** The last result per model, at most one each. */
  tests: z.array(ModelTestRecordSchema),
  /** Tests requested and not yet settled; relaunched after a reload. */
  testing: z.array(ModelRecordIdSchema),
  /** A catalog refresh survives reload; a failed refresh keeps its typed refusal until retried. */
  refresh: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("requested") }),
    z.strictObject({ state: z.literal("failed"), failure: ModelTestFailureSchema })
  ]).optional(),
  host: z.enum(["observed", "unavailable"]),
  selected: ModelRecordIdSchema.optional(),
  /** Why the card surfaced unasked: the one row it shows. */
  attention: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("test-failed"), recordId: ModelRecordIdSchema }),
    z.strictObject({ kind: z.literal("seat-unresolved"), seat: SeatIdSchema })
  ]).optional(),
  /** The catalog refresh's typed refusal, formatted as its code and detail. */
  error: z.string().optional()
})
/**
 * The decoded value accepted by {@link ModelsCardPayloadSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelsCardPayload = z.infer<typeof ModelsCardPayloadSchema>

/**
 * Validates an ask that is out: the request as it was accepted, the binding
 * it was sent to, the account that asked and the ask's own identity, written
 * before dispatch and never edited. A reload resumes exactly this.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelCallPendingSchema = z.strictObject({
  requestId: ModelCredentialRequestIdSchema,
  request: ModelCallDraftSchema,
  binding: ModelBindingSchema,
  /** The account's login; null for a visitor. */
  owner: z.string().nullable()
})
/**
 * The decoded value accepted by {@link ModelCallPendingSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCallPending = z.infer<typeof ModelCallPendingSchema>

/**
 * Validates the `model-call` card's payload (Cards.ts): the composer for one
 * configured model. The request is the editable draft and nothing else reads
 * it; `pending` is the ask that is out; the response is the answer one
 * binding gave to the request it carries, so an edit after it is visibly
 * stale and a rebound model keeps none of it.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModelCallCardPayloadSchema = z.strictObject({
  model: ModelRecordIdSchema,
  request: ModelCallDraftSchema,
  response: z.strictObject({
    askedAt: z.number().finite(),
    request: ModelCallDraftSchema,
    /** Absent only on a card written before answers kept their binding. */
    binding: ModelBindingSchema.optional(),
    result: ModelTestResultSchema
  }).optional(),
  pending: ModelCallPendingSchema.optional(),
  /** Written before `pending` existed, and read only so that journal replays; it names no request, so it resumes nothing. */
  asking: z.boolean().optional(),
  /** The `Evaluator.layerScripted` fixture written from the last decision answer. */
  fixture: z.string().max(MODEL_CALL_TEXT_MAX * 4).optional()
})
/**
 * The decoded value accepted by {@link ModelCallCardPayloadSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type ModelCallCardPayload = z.infer<typeof ModelCallCardPayloadSchema>
