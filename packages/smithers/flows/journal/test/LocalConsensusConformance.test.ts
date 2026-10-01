/**
 * The shared consensus conformance contract instantiated for the in-memory
 * single-process strategy — the browser-safe default for tests and local
 * embedding.
 */
import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Consensus from "../src/Consensus.ts"
import { conformance } from "./ConsensusConformance.ts"

conformance("Consensus.layerLocal", Consensus.layerLocal)

it.effect("noop consensus refuses lease reconfirm without an owner", () =>
  Effect.gen(function*() {
    const consensus = yield* Consensus.Consensus
    expect(yield* consensus.reconfirm("unowned", { hostId: "host", pid: 1, nonce: "owner" }, 0))
      .toEqual({ _tag: "Lost" })
  }).pipe(Effect.provide(Consensus.layerNoop())))
