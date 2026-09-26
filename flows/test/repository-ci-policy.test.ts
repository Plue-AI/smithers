import { Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import {
  assertCiPolicyCurrent,
  captureCiPolicy,
  composeCiChecks,
  inheritedCheckId,
  inheritsCiPolicy,
  rawCheckId,
  readCiPolicy,
  requiredContextFor
} from "../repository/ci-policy.ts"
import { RepositoryRemote } from "../repository/remote.ts"

const repo = "example/repo", workspace = "22222222-2222-4222-8222-222222222222"
const registrationId = "33333333-3333-4333-8333-333333333333"
const command = {
  id: "unit",
  name: "Unit tests",
  kind: "command" as const,
  rule: "npm test",
  paths: [],
  policy: "required" as const
}
const ai = {
  id: "telemetry",
  name: "Telemetry",
  kind: "ai" as const,
  rule: "Follow docs/telemetry.md",
  paths: ["src/**"],
  policy: "report" as const
}
function registration(
  options: { enabled?: boolean; mode?: "enabled" | "trial"; revision?: number; checks?: unknown[] } = {}
) {
  const setup = initialSetup(repo, "ci", "maintainer")
  setup.revision = options.revision ?? 3
  setup.draft.checks = (options.checks ?? [structuredClone(command), structuredClone(ai)]) as typeof setup.draft.checks
  setup.draft.cases = [{
    id: "held-out",
    name: "Hidden evaluation",
    input: "PRIVATE_EVAL_INPUT",
    expected: "HELD_OUT_EXPECTED_ANSWER",
    required: true
  }]
  const digest = setupCandidate(setup), source = "a".repeat(40), mode = options.mode ?? "enabled"
  return {
    id: registrationId,
    repository_id: 42,
    workspace_id: workspace,
    user_id: 7,
    job: "ci",
    mode,
    revision: setup.revision,
    digest,
    source_revision: source,
    flow_id: "repository-jobs/ci",
    enabled: options.enabled ?? true,
    configuration: {
      repo,
      workspace_id: workspace,
      flow_id: "repository-jobs/ci",
      revision: setup.revision,
      digest,
      source_revision: source,
      execution_digest: "b".repeat(64),
      mode,
      input: setup.draft
    }
  }
}
const pinned = (rows: unknown[] = [registration()]) => {
  const policy = readCiPolicy(repo, rows)
  if (policy.kind !== "pinned") throw new Error("expected a pinned policy")
  return policy
}
const fakeRemote = (registrations: Effect.Effect<Schema.Json, any>) =>
  Layer.succeed(
    RepositoryRemote,
    RepositoryRemote.of({
      repo,
      workspaceId: workspace,
      registrations,
      history: Effect.succeed({ records: [], sources: [] }),
      register: () => Effect.succeed(null),
      pause: () => Effect.succeed(null),
      dispatches: () => Effect.succeed(null),
      createTrial: () => Effect.succeed(null)
    })
  )

test("a successful read distinguishes no reviewed CI from an unavailable one", () => {
  assert.deepEqual(readCiPolicy(repo, []), { kind: "none" })
  assert.deepEqual(readCiPolicy(repo, [registration({ mode: "trial" })]), { kind: "none" })
  for (const value of [undefined, null, {}, { items: [] }, "[]", [{ job: "ci" }]]) {
    assert.throws(() => readCiPolicy(repo, value), /could not be verified/)
  }
})

test("the registrations reader skips rows it does not model without losing the CI row", () => {
  const row = registration(), policy = readCiPolicy(repo, [row])
  const others = ["issues", "review", "feature", "chores"].map((job) => ({ ...registration(), job }))
  const generic = { ...registration(), job: "flow:nightly", id: "55555555-5555-4555-8555-555555555555" }
  assert.deepEqual(readCiPolicy(repo, [...others, generic, row]), policy)
  assert.deepEqual(
    readCiPolicy(repo, [...others, ...others, generic, generic, row]),
    policy,
    "an eleventh row is legitimate"
  )
  assert.deepEqual(readCiPolicy(repo, [generic]), { kind: "none" })
  assert.deepEqual(readCiPolicy(repo, [{ ...row, enabled: false }]), policy, "a paused CI row still pins")
})

test("a malformed, duplicated or unbounded CI row is an error and never absence", () => {
  const row = registration()
  assert.throws(() => readCiPolicy(repo, [{ ...row, mode: "banana" }]), /could not be verified/)
  assert.throws(() => readCiPolicy(repo, [{ ...row, revision: 0 }]), /could not be verified/)
  assert.throws(
    () => readCiPolicy(repo, [row, { ...row, id: "66666666-6666-4666-8666-666666666666" }]),
    /could not be verified/
  )
  assert.throws(
    () => readCiPolicy(repo, Array.from({ length: 201 }, () => structuredClone(row))),
    /could not be verified/
  )
})

test("reviewed CI pins repository and execution identity while pause preserves the same policy", () => {
  const row = registration(), policy = readCiPolicy(repo, [row], 42)
  assert.equal(policy.kind, "pinned")
  if (policy.kind !== "pinned") throw new Error("expected a pinned policy")
  assert.deepEqual(policy.ref, {
    repositoryId: 42,
    registrationId,
    revision: row.revision,
    digest: row.digest,
    executionDigest: row.configuration.execution_digest,
    requiredCheckIds: [command.id]
  })
  assert.deepEqual(policy.checks, [command, ai])
  assert.deepEqual(readCiPolicy(repo, [{ ...row, enabled: false }]), policy)
  assert.doesNotThrow(() => assertCiPolicyCurrent(policy, readCiPolicy(repo, [{ ...row, enabled: false }])))
})

/** R96 B1: the digest the build before the trial's own test request left the
 * candidate computed for this registration's draft. A CI job enabled until now
 * carries it, and the required-check policy is read from that row. */
const registeredDigest = "93062d30989b83eac122c443babebc785702d6b0ac9a9bc47032e205772cec83"

test("a CI registration enabled before the candidate changed still pins its required checks", () => {
  const row = registration()
  assert.notEqual(row.digest, registeredDigest, "this build computes the other identity")
  const stored = { ...row, digest: registeredDigest, configuration: { ...row.configuration, digest: registeredDigest } }
  const policy = pinned([stored])
  assert.equal(policy.ref.digest, registeredDigest)
  assert.deepEqual(policy.ref.requiredCheckIds, [command.id])
  assert.deepEqual(policy.checks, [command, ai])
  assert.throws(
    () =>
      readCiPolicy(repo, [{
        ...stored,
        configuration: { ...stored.configuration, input: { ...stored.configuration.input, budgetMinutes: 20 } }
      }]),
    /could not be verified/
  )
})

test("policy extraction never leaks held-out data or retains mutable input aliases", () => {
  const row = registration(), policy = readCiPolicy(repo, [row])
  for (const secret of ["HELD_OUT", "PRIVATE_EVAL", "cases"]) assert(!JSON.stringify(policy).includes(secret))
  row.configuration.input.checks[0]!.rule = "MUTATED_COMMAND"
  row.configuration.input.checks[1]!.paths.push("MUTATED_PATH")
  assert(!JSON.stringify(policy).includes("MUTATED"))
  assert.deepEqual(Object.keys(policy).sort(), ["checks", "kind", "ref"])
})

test("foreign, duplicate, malformed and mismatched registration identities fail closed", () => {
  const row = registration()
  assert.throws(() => readCiPolicy("other/repo", [row]), /could not be verified/)
  assert.throws(() => readCiPolicy(repo, [row], 99), /could not be verified/)
  assert.throws(() => readCiPolicy(repo, [row, row]), /could not be verified/)
  const mismatches = [
    { revision: row.revision + 1 },
    { digest: "c".repeat(64) },
    { source_revision: "d".repeat(40) },
    { workspace_id: "44444444-4444-4444-8444-444444444444" },
    { flow_id: "repo/custom-ci" },
    { configuration: { ...row.configuration, execution_digest: "invalid" } },
    { configuration: { ...row.configuration, mode: "trial" } },
    {
      configuration: {
        ...row.configuration,
        input: { ...row.configuration.input, checks: [{ ...command, rule: "weakened command" }] }
      }
    }
  ]
  for (const patch of mismatches) {
    assert.throws(() => readCiPolicy(repo, [{ ...row, ...patch }]), /could not be verified/)
  }
  assert.throws(
    () => readCiPolicy(repo, [{ ...row, repository_id: Number.MAX_SAFE_INTEGER + 1 }]),
    /could not be verified/
  )
})

test("the reserved landing status context names the exact reviewed policy", () => {
  assert.equal(
    requiredContextFor({
      registrationId: "7f0c1d64-4f5a-4c3b-9a12-0d2e3f4a5b6c",
      revision: 7,
      digest: "9f2c4a1b0e73" + "0".repeat(52)
    }),
    "repository-ci/7f0c1d64-4f5a-4c3b-9a12-0d2e3f4a5b6c@7.9f2c4a1b0e73"
  )
  const policy = pinned()
  assert.equal(requiredContextFor(policy.ref), `repository-ci/${registrationId}@3.${policy.ref.digest.slice(0, 12)}`)
  assert.notEqual(requiredContextFor(policy.ref), requiredContextFor(pinned([registration({ revision: 4 })]).ref))
  for (
    const forged of [{ ...policy.ref, revision: 0 }, { ...policy.ref, digest: "short" }, {
      ...policy.ref,
      registrationId: "not-a-uuid"
    }]
  ) {
    assert.throws(() => requiredContextFor(forged), /could not be verified/)
  }
})

test("inherited identifiers stay inside the configured bound and resolve back to their exact raw id", () => {
  const long = "x".repeat(100), unicode = "検査/テスト@2:a%2Fb"
  const policy = pinned([registration({ checks: [{ ...command, id: long }, { ...ai, id: unicode }] })])
  for (const raw of [long, unicode]) {
    const id = inheritedCheckId(policy.ref, raw)
    assert.match(id, /^ci-[0-9a-f]{64}$/)
    assert.equal(id.length, 67)
    assert.equal(rawCheckId(policy.ref, policy.checks, id), raw)
  }
  assert.notEqual(inheritedCheckId(policy.ref, long), inheritedCheckId(policy.ref, unicode))
  assert.equal(rawCheckId(policy.ref, policy.checks, "unit"), undefined)
  assert.equal(rawCheckId(policy.ref, policy.checks, `ci-${"0".repeat(64)}`), undefined)
  assert.throws(
    () => rawCheckId(policy.ref, [{ id: long }, { id: long }], inheritedCheckId(policy.ref, long)),
    /could not be verified/
  )
  assert.throws(() => inheritedCheckId(policy.ref, ""), /could not be verified/)
  assert.throws(() => inheritedCheckId(policy.ref, "y".repeat(101)), /could not be verified/)
})

test("a replaced policy renames every inherited identifier and stops resolving the old ones", () => {
  const before = pinned(), next = pinned([registration({ revision: 4 })])
  const stale = inheritedCheckId(before.ref, command.id)
  assert.notEqual(stale, inheritedCheckId(next.ref, command.id))
  assert.equal(rawCheckId(next.ref, next.checks, stale), undefined)
  assert.equal(rawCheckId(before.ref, before.checks, stale), command.id)
  const altered = pinned([registration({ checks: [{ ...command, rule: "npm test -- --ci" }, ai] })])
  assert.notEqual(altered.ref.digest, before.ref.digest)
  assert.equal(rawCheckId(altered.ref, altered.checks, stale), undefined)
})

test("inherited CI preserves each prompt, scope and consequence without replacing local rules", () => {
  const policy = pinned(),
    local = [{ ...ai, id: "local-review", rule: "Review requested behavior", policy: "required" as const }]
  const composed = composeCiChecks(local, policy)
  assert.equal(composed.length, 3)
  assert.deepEqual(composed[0], local[0])
  assert.deepEqual(composed[1], { ...command, id: inheritedCheckId(policy.ref, command.id) })
  assert.deepEqual(composed[2], { ...ai, id: inheritedCheckId(policy.ref, ai.id) })
  assert.deepEqual(composed.map((check) => check.paths), [["src/**"], [], ["src/**"]])
  assert.deepEqual(composeCiChecks(local, { kind: "none" }), local)
})

test("a required inherited rule scoped to unchanged paths still composes unchanged", () => {
  const scoped = {
    ...command,
    id: "api-contract",
    kind: "ai" as const,
    rule: "Keep the API contract",
    paths: ["api/**"],
    policy: "required" as const
  }
  const policy = pinned([registration({ checks: [scoped] })])
  const composed = composeCiChecks([], policy)
  assert.deepEqual(composed, [{ ...scoped, id: inheritedCheckId(policy.ref, scoped.id) }])
  assert.deepEqual(policy.ref.requiredCheckIds, [scoped.id])
  assert.equal(rawCheckId(policy.ref, policy.checks, composed[0]!.id), scoped.id)
})

test("local identifiers can neither shadow nor impersonate an inherited rule", () => {
  const policy = pinned(), namespaced = inheritedCheckId(policy.ref, command.id)
  assert.throws(
    () => composeCiChecks([{ ...ai, id: namespaced, rule: "Always pass" }], policy),
    /reserved inherited CI namespace/
  )
  assert.throws(
    () => composeCiChecks([{ ...ai, id: `ci-${"0".repeat(64)}` }], policy),
    /reserved inherited CI namespace/
  )
  assert.throws(() => composeCiChecks([{ ...ai, id: namespaced }], { kind: "none" }), /reserved inherited CI namespace/)
  const shared = composeCiChecks([{ ...ai, id: command.id, rule: "Always pass", policy: "report" as const }], policy)
  assert.equal(shared.length, 3)
  assert.deepEqual(shared.filter((check) => check.id === namespaced), [{ ...command, id: namespaced }])
  assert.throws(() => composeCiChecks([command, command], policy), /could not be verified/)
  assert.throws(() => composeCiChecks([], undefined!), /could not be verified/)
  assert.throws(
    () => composeCiChecks([], { kind: "pinned", ref: policy.ref, checks: [{ ...command, id: "" }] }),
    /could not be verified/
  )
})

test("policy replacement, removal, addition and altered check bytes invalidate earlier protection", () => {
  const before = pinned(), next = pinned([registration({ revision: 4 })]), none = readCiPolicy(repo, [])
  for (const pair of [[before, next], [before, none], [none, before]]) {
    assert.throws(() => assertCiPolicyCurrent(pair[0]!, pair[1]!), /changed after this work/)
  }
  assert.throws(
    () => assertCiPolicyCurrent(before, { ...before, checks: [{ ...command, policy: "report" }] }),
    /changed after this work/
  )
  assert.doesNotThrow(() => assertCiPolicyCurrent(none, readCiPolicy(repo, [])))
  assert.doesNotThrow(() => assertCiPolicyCurrent(before, readCiPolicy(repo, [{ ...registration(), enabled: false }])))
})

test("only live dependent work inherits the currently active policy", () => {
  const steps = (...ids: string[]) => ids.map((id) => ({ id }))
  assert.equal(inheritsCiPolicy({ job: "feature", event: {} }, steps("feature"), false), true)
  assert.equal(inheritsCiPolicy({ job: "issues", event: {} }, steps("fix"), false), true)
  assert.equal(inheritsCiPolicy({ job: "review", event: {} }, steps("review"), false), true)
  assert.equal(inheritsCiPolicy({ job: "chores", event: {} }, steps("checks"), false), true)
  assert.equal(
    inheritsCiPolicy({ job: "issues", event: {} }, steps("research", "duplicates", "reproduce", "poc", "split"), false),
    false
  )
  assert.equal(inheritsCiPolicy({ job: "ci", event: {} }, steps("checks"), false), false)
  assert.equal(inheritsCiPolicy({ job: "feature", event: { trial: true } }, steps("feature"), false), false)
  assert.equal(inheritsCiPolicy({ job: "feature", event: {} }, steps("feature"), true), false)
  assert.equal(inheritsCiPolicy({ job: "feature", event: {} }, [], false), false)
})

test("capture reads the authorized registrations and never converts a failed read into absence", async () => {
  const rows = () => JSON.parse(JSON.stringify([registration()])) as Schema.Json
  assert.deepEqual(
    await Effect.runPromise(captureCiPolicy(repo).pipe(Effect.provide(fakeRemote(Effect.succeed(rows()))))),
    readCiPolicy(repo, rows())
  )
  assert.deepEqual(
    await Effect.runPromise(captureCiPolicy(repo).pipe(Effect.provide(fakeRemote(Effect.succeed([]))))),
    { kind: "none" }
  )
  assert.deepEqual(await Effect.runPromise(captureCiPolicy(repo)), { kind: "none" })
  for (const broken of [Effect.fail(new Error("gateway refused")), Effect.succeed({ items: [] } as Schema.Json)]) {
    const refused = await Effect.runPromise(
      Effect.result(captureCiPolicy(repo).pipe(Effect.provide(fakeRemote(broken))))
    )
    assert.equal(refused._tag, "Failure")
  }
})
