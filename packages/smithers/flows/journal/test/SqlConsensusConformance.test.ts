/**
 * The shared consensus conformance contract instantiated for the default
 * database-backed strategy, whose lease lives in `flows_consensus_leases` and
 * whose guard joins the append transaction, plus the failure shape only a
 * database-backed strategy has: a lease store that cannot answer.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Duration, Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Consensus, heartbeatStaleAfter, type LivenessEvidence } from "../src/Consensus.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlConsensus from "../src/SqlConsensus.ts"
import { conformance } from "./ConsensusConformance.ts"

conformance("SqlConsensus.layer", SqlConsensus.layer)

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-b", pid: 202, nonce: "owner-b" }
const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)

const evidence = (expectedOwner: OwnerId, checkedAtMs: number): LivenessEvidence => ({
  expectedOwner,
  checkedAtMs,
  kind: "lease-expired"
})

const stack = SqlConsensus.layer.pipe(
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)

const withStack = <A, E>(
  body: Effect.Effect<A, E, Consensus | DurableWriter | Scope.Scope | SqlClient.SqlClient>
) => Effect.scoped(body.pipe(Effect.provide(stack)))

describe("SqlConsensus over a lease store that cannot answer", () => {
  it.effect("reports every operation as persistence_failed with the storage cause preserved", () =>
    withStack(Effect.gen(function*() {
      const consensus = yield* Consensus
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const nowMs = staleAfterMs + 1
      yield* consensus.claim("run-broken", ownerA, 0)
      yield* consensus.activate("run-broken", ownerA, 0, 0)
      yield* sql`DROP TABLE flows_consensus_leases`
      const failures = yield* Effect.forEach([
        consensus.claim("run-broken", ownerB, 1),
        consensus.activate("run-broken", ownerA, 0, 1),
        consensus.heartbeat("run-broken", ownerA, 1),
        consensus.release("run-broken", ownerA),
        consensus.steal("run-broken", ownerB, nowMs, evidence(ownerA, nowMs)),
        consensus.recover("run-broken", ownerA, 0, ownerB, nowMs, evidence(ownerA, nowMs)),
        consensus.guard("run-broken", ownerA)
      ], Effect.flip)
      expect(failures.map((failure) => failure.code)).toEqual(Array.from(failures, () => "persistence_failed"))
      for (const failure of failures) {
        expect(failure.cause).toBeDefined()
      }
    })))
})
