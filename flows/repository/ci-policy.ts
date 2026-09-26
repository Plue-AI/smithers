/** Reviewed repository CI is a separate dependency of local job checks. */
import * as Digest from "@smthrs/core/Digest"
import { Effect, Option, Schema } from "effect"
import { SetupCheckSchema, SetupDraftSchema, storedSetupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { Landing } from "../coding/landing.ts"
import { CodingError } from "../coding/schema.ts"
import { RepositoryRemote } from "./remote.ts"
import { Check, Job } from "./schema.ts"

const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const Commit = Schema.String.check(Schema.isPattern(/^(?!0{40}$)[0-9a-f]{40}$/))
const UUID = Schema.String.check(Schema.isPattern(/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))
const Repo = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/), Schema.makeFilter(repo => repo.split("/").every(part => part !== "." && part !== "..")))
/** requiredCheckIds holds the raw configured ids the reviewed policy requires. */
export const CiPolicyRef = Schema.Struct({ repositoryId: Positive, registrationId: UUID, revision: Positive,
  digest: Hash, executionDigest: Hash, requiredCheckIds: Schema.Array(Check.fields.id).check(Schema.isMaxLength(50)) })
export type CiPolicyRef = typeof CiPolicyRef.Type
/** One reviewed CI rule, still carrying the exact id stored in its registration. */
export const InheritedCheck = Check
export type InheritedCheck = typeof Check.Type
export const CiPolicy = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("pinned"), ref: CiPolicyRef, checks: Schema.Array(InheritedCheck).check(Schema.isMaxLength(50)) })
])
export type CiPolicy = typeof CiPolicy.Type
const Registration = Schema.Struct({ id: UUID, repository_id: Positive, workspace_id: UUID, user_id: Positive,
  job: Job, mode: Schema.Literals(["enabled", "trial"]), revision: Positive, digest: Hash, source_revision: Commit,
  flow_id: Schema.NonEmptyString, enabled: Schema.Boolean, configuration: Schema.Unknown })
const Configuration = Schema.Struct({ repo: Repo, workspace_id: UUID, flow_id: Schema.NonEmptyString, revision: Positive,
  digest: Hash, source_revision: Commit, execution_digest: Hash, mode: Schema.Literals(["enabled", "trial"]), input: Schema.Unknown })
const unavailable = () => new CodingError({ code: "unavailable", message: "The reviewed repository CI policy could not be verified" })
const changed = () => new CodingError({ code: "stale_revision", message: "Repository CI policy changed after this work was checked; run its checks again" })
const conflict = () => new CodingError({ code: "invalid_plan", message: "A local check identifier uses the reserved inherited CI namespace" })
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, value: unknown): S["Type"] => {
  const result = Schema.decodeUnknownOption(schema)(value)
  if (Option.isNone(result)) throw unavailable()
  return result.value
}
const canonicalRepo = (repo: string) => decode(Repo, repo).toLowerCase()
const copyCheck = (check: typeof Check.Type): typeof Check.Type => ({ id: check.id, name: check.name, kind: check.kind,
  rule: check.rule, paths: [...check.paths], policy: check.policy })
const checks = (value: unknown): ReadonlyArray<typeof Check.Type> => {
  const parsed = SetupCheckSchema.array().max(50).safeParse(value)
  if (!parsed.success || new Set(parsed.data.map(check => check.id)).size !== parsed.data.length) throw unavailable()
  return parsed.data.map(copyCheck)
}
/** Only call with a successful response from the provisioned repository GET.
 * Transport errors are not inputs and must never be converted into an empty list. */
/** A row this build does not model is another job's registration, not this
 * projection's business: it is skipped, never truncated away and never turned
 * into absence. Only a malformed or duplicated CI row is an error. */
const CiRow = Schema.Struct({ job: Schema.Literal("ci") })
export const readCiPolicy = (repo: string, response: unknown, repositoryId?: number): CiPolicy => {
  const expected = canonicalRepo(repo)
  if (!Array.isArray(response) || response.length > 200) throw unavailable()
  if (repositoryId !== undefined) decode(Positive, repositoryId)
  const active: Array<typeof Registration.Type> = []
  for (const value of response) {
    if (!Schema.is(CiRow)(value)) continue
    const row = decode(Registration, value)
    if (row.mode !== "enabled") continue
    if ((repositoryId !== undefined && row.repository_id !== repositoryId) ||
        typeof row.configuration !== "object" || row.configuration === null || Array.isArray(row.configuration) ||
        canonicalRepo(String((row.configuration as Record<string, unknown>).repo)) !== expected) throw unavailable()
    active.push(row)
  }
  if (!active.length) return { kind: "none" }
  if (active.length !== 1) throw unavailable()
  const row = active[0]!, configuration = decode(Configuration, row.configuration)
  if (configuration.workspace_id !== row.workspace_id || configuration.flow_id !== row.flow_id || row.flow_id !== "repository-jobs/ci" ||
      configuration.revision !== row.revision || configuration.digest !== row.digest || configuration.source_revision !== row.source_revision || configuration.mode !== "enabled") throw unavailable()
  const draft = SetupDraftSchema.safeParse(configuration.input)
  if (!draft.success || !storedSetupCandidate({ repo: configuration.repo, job: "ci", revision: row.revision, draft: draft.data }, row.digest)) throw unavailable()
  const reviewed = checks(draft.data.checks)
  // Deliberate whitelist: no cases, expected answers, prompts for other steps,
  // source records or mutable registration/configuration objects leave this read.
  return { kind: "pinned", ref: { repositoryId: row.repository_id, registrationId: row.id, revision: row.revision,
    digest: row.digest, executionDigest: configuration.execution_digest,
    requiredCheckIds: reviewed.filter(check => check.policy === "required").map(check => check.id) }, checks: reviewed }
}

const reserved = /^ci-[0-9a-f]{64}$/
/** Bounded because Check.id holds 100 characters and a raw id may hold all 100.
 * The tuple is shared with the later authoritative proof verifier. */
export const inheritedCheckId = (ref: CiPolicyRef, rawId: string): string => {
  const raw = decode(Check.fields.id, rawId)
  if (!raw.length) throw unavailable()
  return `ci-${Digest.digest(Digest.canonical(["repository/ci-check/v1", ref.repositoryId, decode(UUID, ref.registrationId),
    decode(Positive, ref.revision), decode(Hash, ref.digest), decode(Hash, ref.executionDigest), raw]))}`
}
/** Provenance is recomputed from the pinned policy, never parsed out of the id,
 * so a local identifier can never present itself as an inherited CI result. */
export const rawCheckId = (ref: CiPolicyRef, reviewed: ReadonlyArray<{ readonly id: string }>, inheritedId: string): string | undefined => {
  if (!reserved.test(inheritedId)) return undefined
  const matches = reviewed.filter(check => inheritedCheckId(ref, check.id) === inheritedId)
  if (matches.length > 1) throw unavailable()
  return matches[0]?.id
}
export const composeCiChecks = (local: ReadonlyArray<typeof Check.Type>, policy: CiPolicy): ReadonlyArray<typeof Check.Type> => {
  const own = checks(local), selected = decode(CiPolicy, policy)
  if (own.some(check => reserved.test(check.id))) throw conflict()
  if (selected.kind === "none") return own
  return [...own, ...checks(selected.checks).map(check => ({ ...check, id: inheritedCheckId(selected.ref, check.id) }))]
}
/** Pause is absent from the redacted policy, so it cannot withdraw protection. */
export const assertCiPolicyCurrent = (expected: CiPolicy, observed: CiPolicy): void => {
  const before = decode(CiPolicy, expected), after = decode(CiPolicy, observed)
  if (Digest.canonical(before) !== Digest.canonical(after)) throw changed()
}
/** The reserved native landing status context for this exact reviewed policy. */
export const requiredContextFor = (ref: Pick<CiPolicyRef, "registrationId" | "revision" | "digest">): string =>
  `repository-ci/${decode(UUID, ref.registrationId)}@${decode(Positive, ref.revision)}.${decode(Hash, ref.digest).slice(0, 12)}`
/** Research-only issue work, the CI candidate itself, trials and replayed
 * evaluations keep their own checks and never inherit the active policy. */
export const inheritsCiPolicy = (input: { readonly job: typeof Job.Type; readonly event: { readonly trial?: boolean } },
  steps: ReadonlyArray<{ readonly id: string }>, evaluation: boolean): boolean =>
  input.job !== "ci" && !evaluation && input.event.trial !== true &&
  steps.some(step => input.job === "review" || ["checks", "fix", "feature", "chore"].includes(step.id))
/** A repository without the provisioned registration read has no reviewed CI;
 * a refused or malformed read is unavailable and never absence. */
export const captureCiPolicy = (repo: string) => Effect.gen(function*() {
  const remote = yield* Effect.serviceOption(RepositoryRemote)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsc needs it for inference
  if (Option.isNone(remote)) return { kind: "none" } as CiPolicy
  const landing = yield* Effect.serviceOption(Landing)
  const response = yield* remote.value.registrations.pipe(Effect.mapError(error => error instanceof CodingError ? error : unavailable()))
  return yield* Effect.try({ try: () => readCiPolicy(repo, response, Option.isSome(landing) ? landing.value.binding.repositoryId : undefined),
    catch: error => error instanceof CodingError ? error : unavailable() })
})
/** Re-read immediately before a delivering step: a replaced or revoked policy
 * refuses, while a paused one keeps its reviewed rules and proceeds. */
export const revalidateCiPolicy = (repo: string, expected: CiPolicy) => captureCiPolicy(repo).pipe(
  Effect.flatMap(observed => Effect.try({ try: () => assertCiPolicyCurrent(expected, observed),
    catch: error => error instanceof CodingError ? error : changed() })))
