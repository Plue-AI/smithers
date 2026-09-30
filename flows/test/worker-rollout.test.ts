import assert from "node:assert/strict"
import { test } from "node:test"
import { REVIEW_MIGRATIONS } from "../../apps/review/src/server/migrations.ts"
import { type Release, rollout, type RolloutReceipt } from "../rollout/runtime.ts"
import {
  qualifiedWorkerHost,
  type WorkerApp,
  type WorkerArtifact,
  type WorkerQualification,
  type WorkerRolloutPorts
} from "../rollout/worker.ts"

const artifact = { revision: "a".repeat(40), sha256: "b".repeat(64) }
const previous = { version: "previous-version", revision: "c".repeat(40) }
const candidate = { version: "candidate-version", revision: artifact.revision }
const migrationNames = REVIEW_MIGRATIONS.map(({ name }) => name)

function qualification(app: WorkerApp): WorkerQualification {
  return {
    app,
    mainRevision: artifact.revision,
    gate: { revision: artifact.revision, status: "passed" },
    artifact: { ...artifact },
    adoption: { artifact: { ...artifact }, status: "retained", receipt: "adoption receipt" },
    ...(app === "review" ?
      {
        migrations: { revision: artifact.revision, applied: [...migrationNames], receipt: "migration readback" }
      } :
      {})
  }
}

function fixture(app: WorkerApp, options: {
  evidence?: WorkerQualification
  release?: Release
  verifyArtifact?: boolean
  serviceStatus?: "passed" | "failed"
  beforePublishError?: boolean
  publishingRecordError?: boolean
  input?: WorkerArtifact
} = {}) {
  const events: string[] = []
  const receipts: RolloutReceipt[] = []
  const published: WorkerArtifact[] = []
  const ports: WorkerRolloutPorts = {
    checks: ["service-response"],
    rollbackChecks: ["service-response"],
    capture: async () => {
      events.push("capture")
      return previous
    },
    beforePublish: async () => {
      events.push("beforePublish")
      if (options.beforePublishError) throw Error("lease lost")
    },
    qualification: async () => {
      events.push("qualification")
      return options.evidence ?? qualification(app)
    },
    publish: async (input) => {
      events.push("publish")
      published.push({ ...input })
      return options.release ?? candidate
    },
    verifyArtifact: async (release, input) => {
      events.push(`verifyArtifact:${release.version}:${input.sha256}`)
      return options.verifyArtifact ?? true
    },
    check: async (name, _release, phase) => {
      events.push(`check:${phase}:${name}`)
      return { status: phase === "candidate" ? options.serviceStatus ?? "passed" : "passed" }
    },
    restore: async (release) => {
      events.push(`restore:${release.version}`)
    },
    record: async (receipt) => {
      events.push(`record:${receipt.status}`)
      if (options.publishingRecordError && receipt.status === "publishing") throw Error("receipt store unavailable")
      receipts.push(structuredClone(receipt))
    }
  }
  const host = qualifiedWorkerHost(app, options.input ?? artifact, ports)
  return { host, ports, events, receipts, published }
}

function assertRefusedBeforePublication(
  result: RolloutReceipt,
  events: string[],
  receipts: RolloutReceipt[],
  expected: string[] = ["beforePublish", "qualification"]
) {
  assert.equal(result.status, "refused")
  assert.deepEqual(result.failedChecks, ["deployment-changed"])
  assert.deepEqual(events.filter((event) => event === "publish" || event.startsWith("restore:")), [])
  assert.deepEqual(events.filter((event) => event === "beforePublish" || event === "qualification"), expected)
  assert.equal(receipts.at(-1)?.status, "refused")
  assert.equal(receipts.some((receipt) => receipt.status === "publishing"), false)
}

for (const app of ["review", "bug-worker"] as const) {
  test(`${app}: a source-matched qualification publishes and records a passed receipt`, async () => {
    const f = fixture(app)
    const result = await rollout(f.host)
    assert.equal(result.status, "passed")
    assert.deepEqual(result.failedChecks, [])
    assert.deepEqual(result.checks, [
      { name: "qualified-artifact", status: "passed" },
      { name: "service-response", status: "passed" }
    ])
    assert.deepEqual(f.published, [artifact])
    assert.equal(f.receipts.at(-1)?.status, "passed")
    assert.deepEqual(
      f.events.filter((event) => event === "beforePublish" || event === "qualification" || event === "publish"),
      ["beforePublish", "qualification", "publish"]
    )
    assert.equal(f.events.some((event) => event.startsWith("restore:")), false)
  })

  test(`${app}: failed service response restores and rechecks the previous release`, async () => {
    const f = fixture(app, { serviceStatus: "failed" })
    const result = await rollout(f.host)
    assert.equal(result.status, "rolled-back")
    assert.deepEqual(result.failedChecks, ["service-response"])
    assert.equal(result.rollback, "succeeded")
    assert.deepEqual(result.reverification, [{ name: "service-response", status: "passed" }])
    assert.equal(f.events.filter((event) => event === "restore:previous-version").length, 1)
    assert.equal(f.receipts.at(-1)?.status, "rolled-back")
  })

  test(`${app}: a failed lease check refuses before qualification or publication`, async () => {
    const f = fixture(app, { beforePublishError: true })
    assertRefusedBeforePublication(await rollout(f.host), f.events, f.receipts, ["beforePublish"])
  })

  test(`${app}: a changed deployed digest restores the captured release`, async () => {
    const f = fixture(app, { verifyArtifact: false })
    const result = await rollout(f.host)
    assert.equal(result.status, "rolled-back")
    assert.deepEqual(result.failedChecks, ["qualified-artifact"])
    assert.deepEqual(result.reverification, [{ name: "service-response", status: "passed" }])
    assert.equal(f.events.filter((event) => event === "restore:previous-version").length, 1)
  })

  test(`${app}: a deployed revision mismatch restores without trusting a digest check`, async () => {
    const f = fixture(app, { release: { ...candidate, revision: "d".repeat(40) } })
    const result = await rollout(f.host)
    assert.equal(result.status, "rolled-back")
    assert.deepEqual(result.failedChecks, ["qualified-artifact"])
    assert.equal(f.events.some((event) => event.startsWith("verifyArtifact:")), false)
    assert.equal(f.events.filter((event) => event === "restore:previous-version").length, 1)
  })

  test(`${app}: publication waits for its durable intent receipt`, async () => {
    const f = fixture(app, { publishingRecordError: true })
    await assert.rejects(rollout(f.host), /receipt store unavailable/)
    assert.equal(f.events.includes("publish"), false)
    assert.equal(f.events.some((event) => event.startsWith("restore:")), false)
    assert.equal(f.receipts.at(-1)?.status, "prepared")
  })
}

const qualificationCases: Array<[string, WorkerApp, (evidence: WorkerQualification) => WorkerQualification]> = [
  ["wrong app", "review", (e) => ({ ...e, app: "bug-worker" })],
  ["wrong main revision", "review", (e) => ({ ...e, mainRevision: "d".repeat(40) })],
  ["gate revision mismatch", "review", (e) => ({ ...e, gate: { ...e.gate, revision: "d".repeat(40) } })],
  ["failed gate", "review", (e) => ({ ...e, gate: { ...e.gate, status: "failed" } })],
  ["artifact digest mismatch", "review", (e) => ({ ...e, artifact: { ...e.artifact, sha256: "d".repeat(64) } })],
  [
    "adoption artifact mismatch",
    "review",
    (e) => ({ ...e, adoption: { ...e.adoption, artifact: { ...e.adoption.artifact, sha256: "d".repeat(64) } } })
  ],
  ["missing adoption receipt", "review", (e) => ({ ...e, adoption: { ...e.adoption, receipt: "  " } })],
  ["replacement required", "review", (e) => ({ ...e, adoption: { ...e.adoption, status: "replacement-required" } })],
  ["missing migration readback", "review", (e) => {
    const { migrations: _migrations, ...rest } = e
    return rest
  }],
  [
    "migration revision mismatch",
    "review",
    (e) => ({ ...e, migrations: { ...e.migrations!, revision: "d".repeat(40) } })
  ],
  ["missing migration receipt", "review", (e) => ({ ...e, migrations: { ...e.migrations!, receipt: "  " } })]
]

for (const name of migrationNames) {
  qualificationCases.push([
    `missing ${name}`,
    "review",
    (e) => ({
      ...e,
      migrations: { ...e.migrations!, applied: e.migrations!.applied.filter((applied) => applied !== name) }
    })
  ])
}

for (const [name, app, change] of qualificationCases) {
  test(`${app}: ${name} refuses before the publisher`, async () => {
    const f = fixture(app, { evidence: change(qualification(app)) })
    assertRefusedBeforePublication(await rollout(f.host), f.events, f.receipts)
    assert.deepEqual(f.published, [])
  })
}

test("bug-worker needs no review migration receipt", async () => {
  const f = fixture("bug-worker")
  assert.equal((await rollout(f.host)).status, "passed")
  assert.equal(f.events.includes("publish"), true)
})

for (
  const [name, input] of [
    ["revision", { ...artifact, revision: "A".repeat(40) }],
    ["digest", { ...artifact, sha256: "B".repeat(64) }]
  ] as const
) {
  test(`malformed ${name} refuses before the publisher`, async () => {
    const f = fixture("bug-worker", { input })
    assertRefusedBeforePublication(await rollout(f.host), f.events, f.receipts)
  })
}

test("mutating the input artifact after host creation cannot change the published bytes identity", async () => {
  const input = { ...artifact }
  const f = fixture("bug-worker", { input })
  input.revision = "d".repeat(40)
  input.sha256 = "e".repeat(64)
  const result = await rollout(f.host)
  assert.equal(result.status, "passed")
  assert.deepEqual(f.published, [artifact])
  assert.equal(f.events.includes(`verifyArtifact:candidate-version:${artifact.sha256}`), true)
})

for (
  const [name, checks] of [
    ["reserved qualified-artifact", ["qualified-artifact", "service-response"]],
    ["missing service-response", ["health"]]
  ] as const
) {
  test(`${name} is rejected while creating the host`, () => {
    const f = fixture("bug-worker")
    f.ports.checks = [...checks]
    assert.throws(() => qualifiedWorkerHost("bug-worker", artifact, f.ports), /service-response check required/)
    assert.deepEqual(f.events, [])
  })
}
