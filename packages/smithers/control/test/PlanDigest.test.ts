/**
 * Golden vectors for `PlanCard.digest`.
 *
 * Every approval is bound to this digest: `ApprovalTarget` carries it, both
 * runtimes compare against it, and a recorded approval that no longer matches
 * is refused with `PlanDigestMismatch`. Until now no test named a value, only
 * its shape, so any change to the hashed preimage would have passed the suite
 * while silently invalidating every approval already recorded in a
 * `.flows/control.db`.
 *
 * THE LITERALS BELOW ARE A WIRE CONTRACT. Changing one is a breaking change
 * for every persisted approval, not a test update. If a change makes them move,
 * that is the finding.
 *
 * The one exception already taken: the enveloped vector's budget named a `usd`
 * key `Envelope` has never carried, so it described a plan no caller could
 * submit and the type checker refused it. The literal beside it was regenerated
 * for `{ tokens: 5 }`. No envelope a caller can build hashes differently
 * because of it.
 */
import * as Sha256 from "@smthrs/crypto/Sha256"
import { Effect, Layer } from "effect"
import * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import type { Envelope } from "../src/ControlSchema.ts"
import { planCard, type PlanSource } from "../src/internal/planning.ts"

const crypto = Layer.succeed(Crypto.Crypto, Sha256.syncCrypto)

const emptyEnvelope: Envelope = { capabilities: [], flows: [], budget: {} }

const cardFor = (source: PlanSource) => Effect.runPromise(planCard(source).pipe(Effect.provide(crypto)))

/** A plan with no persisted graph and no declared capabilities. */
const bare: PlanSource = {
  planId: "plan-1",
  flowId: "system/up",
  decodedInput: { repo: "smithers", branch: "main" },
  envelope: emptyEnvelope,
  deployClass: false
}

/** The same flow, deploy-class, with capabilities and a persisted plan digest. */
const enveloped: PlanSource = {
  planId: "plan-2",
  flowId: "system/up",
  decodedInput: { repo: "smithers", branch: "main" },
  envelope: { capabilities: ["fs.read", "net.fetch"], flows: ["system/ls"], budget: { tokens: 5 } },
  deployClass: true,
  handoff: {
    plan: { digest: "0".repeat(64), nodes: [{ id: "a", key: "k", status: "run" }] } as never
  }
}

describe("PlanCard.digest golden vectors", () => {
  it("digests a bare plan to its frozen value", async () => {
    const card = await cardFor(bare)
    expect(card.digest).toBe("4c6562b17ef484810f1bd308b7954deddd8bb1c192ff6e219211f8bef5659739")
  })

  it("digests an enveloped deploy-class plan to its frozen value", async () => {
    const card = await cardFor(enveloped)
    expect(card.digest).toBe("889851c21fd54488e87cf5fb5526264539119bbb13ce15c22584940b748fa810")
  })

  it("binds the approval target to the same digest", async () => {
    const card = await cardFor(bare)
    expect(card.approval.target).toMatchObject({ _tag: "Plan", planId: "plan-1", digest: card.digest })
  })

  it("does not hash the plan id, so two ids over one intent agree", async () => {
    const first = await cardFor(bare)
    const second = await cardFor({ ...bare, planId: "plan-9" })
    expect(second.digest).toBe(first.digest)
  })

  it("separates plans that differ only in input", async () => {
    const first = await cardFor(bare)
    const second = await cardFor({ ...bare, decodedInput: { repo: "smithers", branch: "next" } })
    expect(second.digest).not.toBe(first.digest)
  })

  it("binds unrestricted imports into the approval while preserving guarded capabilities", async () => {
    const original = await cardFor(bare)
    const native = await cardFor({ ...bare, envelope: { ...emptyEnvelope, hostImports: ["microsandbox", "node:fs"] } })
    const changed = await cardFor({ ...bare, envelope: { ...emptyEnvelope, hostImports: ["node:child_process"] } })
    expect(native.envelope.capabilities).toEqual([])
    expect(native.approval.target.envelope.hostImports).toEqual(["microsandbox", "node:fs"])
    expect(native.digest).not.toBe(original.digest)
    expect(changed.digest).not.toBe(native.digest)
  })

  it("persists executable identity and binds it into the approval independently of the envelope", async () => {
    const original = await cardFor({ ...bare, executionDigest: "a".repeat(64) })
    const unchanged = await cardFor({ ...bare, planId: "another-plan", executionDigest: "a".repeat(64) })
    const changed = await cardFor({ ...bare, executionDigest: "b".repeat(64) })
    expect(original.executionDigest).toBe("a".repeat(64))
    expect(unchanged.digest).toBe(original.digest)
    expect(changed.digest).not.toBe(original.digest)
    expect(changed.envelope).toEqual(original.envelope)
    expect(changed.approval.target.digest).toBe(changed.digest)
  })

  it("separates plans that differ only in flow, envelope, deploy class, or persisted graph", async () => {
    const base = await cardFor(bare)
    const variants = await Promise.all([
      cardFor({ ...bare, flowId: "system/ls" }),
      cardFor({ ...bare, envelope: { ...emptyEnvelope, capabilities: ["fs.read"] } }),
      cardFor({ ...bare, deployClass: true }),
      cardFor({ ...bare, handoff: { plan: { digest: "a".repeat(64), nodes: [] } as never } })
    ])
    for (const variant of variants) expect(variant.digest).not.toBe(base.digest)
    expect(new Set(variants.map((card) => card.digest)).size).toBe(variants.length)
  })

  it("ignores input key order, because the preimage is canonical", async () => {
    const first = await cardFor(bare)
    const second = await cardFor({ ...bare, decodedInput: { branch: "main", repo: "smithers" } })
    expect(second.digest).toBe(first.digest)
  })
})
