/**
 * The signing boundary's adversarial cases: encodings that do not survive
 * UTF-8, domain separation between the two authorities, and claim sets mutated
 * while Web Crypto is in flight.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import type { JournalEvent } from "@smthrs/journal"
import { ConfigProvider, Duration, Effect, Exit, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import type { Access } from "../src/BranchProtocol.ts"
import { branchOfRunId, branchRunId, ShareCapability, ShareClaims } from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import { SyncError } from "../src/SyncError.ts"
import * as WorkspaceShare from "../src/WorkspaceShare.ts"
import { died, refusalOf } from "./refusal.ts"

const secret = "shared-hardening-secret-01234567"
const branchId = "branch-hardening" as ShareClaims["branchId"]

const run = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provide(TestClock.layer()))

const branchAuthority = BranchShare.makeHmac({
  activeKid: "primary",
  keys: [{ kid: "primary", secret: Redacted.make(secret) }]
})

const workspaceAuthority = WorkspaceShare.makeHmac({
  activeKid: "primary",
  keys: [{ kid: "primary", secret: Redacted.make(secret) }]
})

describe("share claim encoding", () => {
  // `TextEncoder` folds every unpaired surrogate to U+FFFD, so two claim sets
  // differing only in a lone surrogate sign to identical bytes and a length
  // prefix cannot separate them: both encode to the same three bytes. The
  // input is refused before it is signed.
  it.effect("refuses to sign or verify claims carrying an unpaired surrogate", () =>
    Effect.gen(function*() {
      const [mintFailure, verifyFailure] = yield* run(
        Effect.gen(function*() {
          const share = yield* branchAuthority
          const lone = "\uD800" as typeof branchId
          const minted = yield* Effect.flip(
            share.mint({ branchId: lone, capabilityId: "cap", access: "read", ttlMs: 60_000 })
          )
          const forged = new ShareCapability({
            claims: new ShareClaims({
              kid: "primary",
              branchId: lone,
              capabilityId: "cap",
              access: "read",
              issuedAtMs: 0,
              expiresAtMs: 60_000
            }),
            signature: "00"
          })
          return [minted, yield* Effect.flip(share.verify(forged, { branchId: lone, access: "read" }))] as const
        })
      )

      expect(mintFailure.code).toBe("invalid_request")
      expect(verifyFailure.code).toBe("invalid_request")
    }))

  // `TextEncoder` folds an unpaired surrogate in a SECRET to U+FFFD too, so
  // two differently configured secrets would import the same HMAC key and a
  // capability signed under one would verify under the other. Construction
  // refuses such a secret for both authorities.
  it.effect("refuses a signing secret carrying an unpaired surrogate", () =>
    Effect.gen(function*() {
      const keyring = { activeKid: "primary", keys: [{ kid: "primary", secret: Redacted.make("key-\uD800") }] }
      const branchFailure = yield* Effect.flip(BranchShare.makeHmac(keyring))
      const workspaceFailure = yield* Effect.flip(WorkspaceShare.makeHmac(keyring))
      expect(branchFailure.code).toBe("invalid_request")
      expect(workspaceFailure.code).toBe("invalid_request")
      // The replacement character itself is a well-formed secret.
      yield* BranchShare.makeHmac({
        activeKid: "primary",
        keys: [{ kid: "primary", secret: Redacted.make("key-\uFFFD-0123456789abcdefghijklmnopqrstuv") }]
      })
    }))

  // A well-formed astral id round-trips through UTF-8 and is signed normally,
  // so the refusal above is about non-round-trippable input and not about
  // anything outside the basic multilingual plane.
  it.effect("mints and verifies an astral-plane branch id", () =>
    Effect.gen(function*() {
      const claims = yield* run(
        Effect.gen(function*() {
          const share = yield* branchAuthority
          const astral = "branch-\u{1F680}" as typeof branchId
          const capability = yield* share.mint({
            branchId: astral,
            capabilityId: "cap-\u{1F680}",
            access: "read",
            ttlMs: 60_000
          })
          return yield* share.verify(capability, { branchId: astral, access: "read" })
        })
      )

      expect(claims.branchId).toBe("branch-\u{1F680}")
      // The run-id mapping is reversible for the same id.
      expect(branchOfRunId(branchRunId(claims.branchId))).toBe("branch-\u{1F680}")
    }))

  // `flows/branch/` with nothing after it is a non-branch run, not a branch
  // with an empty id: `BranchId` is a branded NonEmptyString, and branding
  // `""` would hand `share.verify` a value the brand forbids.
  it("treats the bare branch prefix as a non-branch run", () => {
    expect(branchOfRunId("flows/branch/" as JournalEvent.RunId)).toBeNull()
    expect(branchOfRunId("flows/engine/run-1" as JournalEvent.RunId)).toBeNull()
    expect(branchOfRunId(branchRunId(branchId))).toBe(branchId)
  })
})

describe("share domain separation", () => {
  // Both authorities can be configured with one secret. Each leads its signed
  // encoding with its own scheme label, so neither's signature can be replayed
  // as the other's. Before, only the workspace side carried a label, which
  // protected exactly one direction.
  it.effect("refuses a workspace signature presented as a branch capability", () =>
    Effect.gen(function*() {
      const outcome = yield* run(
        Effect.gen(function*() {
          const branch = yield* branchAuthority
          const workspace = yield* WorkspaceShare.makeHmac({
            activeKid: "k1",
            keys: [{ kid: "k1", secret: Redacted.make(secret) }]
          })
          const workspaceCapability = yield* workspace.mint({
            capabilityId: branchId,
            access: "read",
            ttlMs: 60_000
          })
          const branchCapability = yield* branch.mint({
            branchId,
            capabilityId: "cap",
            access: "read",
            ttlMs: 60_000
          })
          const replayed = new ShareCapability({
            claims: new ShareClaims({
              kid: "primary",
              branchId,
              capabilityId: "cap",
              access: "read",
              issuedAtMs: workspaceCapability.claims.issuedAtMs,
              expiresAtMs: workspaceCapability.claims.expiresAtMs
            }),
            signature: workspaceCapability.signature
          })
          return {
            branchSignature: branchCapability.signature,
            replayFailure: yield* Effect.flip(branch.verify(replayed, { branchId, access: "read" })),
            workspaceSignature: workspaceCapability.signature
          }
        })
      )

      expect(outcome.replayFailure.code).toBe("unauthorized")
      expect(outcome.branchSignature).not.toBe(outcome.workspaceSignature)
    }))
})

describe("share verification under concurrent mutation", () => {
  // `Schema.Class` instances are not frozen, and `verify` awaits Web Crypto
  // between signing the claims and authorizing them. Everything it authorizes
  // is read from a snapshot taken at entry, so a holder of the same decoded
  // instance cannot widen the grant mid-verification.
  it.effect("authorizes the claims it signed, not the claims as they are afterwards", () =>
    Effect.gen(function*() {
      const outcome = yield* run(
        Effect.gen(function*() {
          const share = yield* branchAuthority
          const capability = yield* share.mint({
            branchId,
            capabilityId: "cap",
            access: "read",
            ttlMs: 60_000
          })
          const verification = yield* Effect.forkChild(
            Effect.exit(share.verify(capability, { branchId, access: "write" })),
            { startImmediately: true }
          ) // The adversary holds the same decoded object while the HMAC is in
           // flight and widens it from read to write.
          ;(capability.claims as { access: string }).access = "write"
          return yield* Fiber.join(verification)
        })
      )

      // The REASON is the point. Without the entry snapshot the widened
      // `access` is what the authorization check reads, and `verify` succeeds;
      // with it the check reads "read" and refuses for exactly that. Asserting
      // only that it failed would also pass on a signature mismatch or a
      // defect, neither of which is what this test is about.
      const refusal = refusalOf(outcome)
      expect(died(outcome)).toBe(false)
      expect(SyncError.is(refusal)).toBe(true)
      expect(refusal?.code).toBe("unauthorized")
      expect(refusal?.message).toBe("The share capability is read-only")
    }))
})

describe("share authorities that are switched off", () => {
  // `mint` used to DIE where its own declared type promises a `SyncError`, and
  // `WorkspaceShare.layerNoop` is what the shipped CLI gateway wires: a
  // consumer handling `SyncError` there got a crash instead of a refusal.
  it.effect("refuses rather than dies when sharing is unavailable", () =>
    Effect.gen(function*() {
      const [branchMint, workspaceMint] = yield* run(
        Effect.gen(function*() {
          const branch = yield* BranchShare.BranchShare
          const workspace = yield* WorkspaceShare.WorkspaceShare
          return [
            yield* Effect.flip(branch.mint({ branchId, capabilityId: "c", access: "read", ttlMs: 1 })),
            yield* Effect.flip(workspace.mint({ capabilityId: "c", access: "read", ttlMs: 1 }))
          ] as const
        }).pipe(Effect.provide(Layer.mergeAll(BranchShare.layerNoop, WorkspaceShare.layerNoop)))
      )

      expect(SyncError.is(branchMint)).toBe(true)
      expect(branchMint.code).toBe("unauthorized")
      expect(SyncError.is(workspaceMint)).toBe(true)
      expect(workspaceMint.code).toBe("unauthorized")
    }))
})

/**
 * The two authorities as one table, so every refusal below is asserted against
 * both.
 *
 * `ShareHardening` tested each authority separately, which is what let the
 * expiry boundary and the read-only refusal drift: a fix landing in one
 * verification pipeline was not caught if it missed the other. Both now run
 * through `shareSigner.verifyClaims`, and this table is what says so.
 */
const authorities = [
  {
    name: "BranchShare",
    subject: "The share capability",
    /** Requests whose declared TypeScript type admits a value the schema forbids. */
    invalid: [
      { label: "an empty branch id", request: { branchId: "", capabilityId: "cap", access: "read", ttlMs: 1_000 } },
      { label: "an empty capability id", request: { branchId, capabilityId: "", access: "read", ttlMs: 1_000 } },
      { label: "a zero ttl", request: { branchId, capabilityId: "cap", access: "read", ttlMs: 0 } },
      { label: "a NaN ttl", request: { branchId, capabilityId: "cap", access: "read", ttlMs: NaN } }
    ],
    mintUnchecked: (request: unknown): Effect.Effect<unknown, SyncError> =>
      Effect.flatMap(branchAuthority, (share) => share.mint(request as BranchShare.MintRequest)),
    minted: (access: Access, ttlMs: number) =>
      Effect.flatMap(
        branchAuthority,
        (share) =>
          Effect.map(share.mint({ branchId, capabilityId: "cap", access, ttlMs }), (capability) => ({
            verify: (requested: Access): Effect.Effect<unknown, SyncError> =>
              share.verify(capability, { branchId, access: requested })
          }))
      )
  },
  {
    name: "WorkspaceShare",
    subject: "The workspace capability",
    invalid: [
      { label: "an empty capability id", request: { capabilityId: "", access: "read", ttlMs: 1_000 } },
      { label: "a zero ttl", request: { capabilityId: "cap", access: "read", ttlMs: 0 } },
      { label: "a NaN ttl", request: { capabilityId: "cap", access: "read", ttlMs: NaN } }
    ],
    mintUnchecked: (request: unknown): Effect.Effect<unknown, SyncError> =>
      Effect.flatMap(workspaceAuthority, (share) => share.mint(request as WorkspaceShare.MintRequest)),
    minted: (access: Access, ttlMs: number) =>
      Effect.flatMap(
        workspaceAuthority,
        (share) =>
          Effect.map(share.mint({ capabilityId: "cap", access, ttlMs }), (capability) => ({
            verify: (requested: Access): Effect.Effect<unknown, SyncError> =>
              share.verify(capability, { access: requested })
          }))
      )
  }
] as const

describe("share mint admission", () => {
  // `mint` is typed `Effect<_, SyncError>` over a request whose schema forbids
  // an empty id and a non-positive ttl, and neither authority decoded it: the
  // TypeScript type admits `""` and `NaN`, so an in-process caller passing one
  // got a `Schema.Class` defect out of an operation that promised a refusal,
  // and `ttlMs: 0` was accepted and minted an already-expired capability.
  for (const authority of authorities) {
    for (const { label, request } of authority.invalid) {
      it.effect(`${authority.name} refuses ${label} typed`, () =>
        Effect.gen(function*() {
          const outcome = yield* run(Effect.exit(authority.mintUnchecked(request)))

          expect(died(outcome)).toBe(false)
          expect(SyncError.is(refusalOf(outcome))).toBe(true)
          expect(refusalOf(outcome)?.code).toBe("invalid_request")
        }))
    }
  }
})

describe("share verification, both authorities", () => {
  // The boundary is `>=`: a capability is dead at the instant it expires, not
  // one millisecond after. Asserted on both authorities through the shared
  // pipeline, so the boundary cannot drift in one of them alone.
  for (const authority of authorities) {
    it.effect(`${authority.name} accepts the last millisecond and refuses the expiry instant`, () =>
      Effect.gen(function*() {
        const [before, at] = yield* run(
          Effect.gen(function*() {
            const capability = yield* authority.minted("read", 60_000)
            yield* TestClock.adjust(Duration.millis(59_999))
            const before = yield* Effect.exit(capability.verify("read"))
            yield* TestClock.adjust(Duration.millis(1))
            return [before, yield* Effect.exit(capability.verify("read"))] as const
          })
        )

        expect(Exit.isSuccess(before)).toBe(true)
        expect(died(at)).toBe(false)
        expect(refusalOf(at)?.code).toBe("unauthorized")
        expect(refusalOf(at)?.message).toBe(`${authority.subject} has expired`)
      }))

    it.effect(`${authority.name} refuses a write against a read capability`, () =>
      Effect.gen(function*() {
        const [widened, narrowed] = yield* run(
          Effect.gen(function*() {
            const read = yield* authority.minted("read", 60_000)
            const write = yield* authority.minted("write", 60_000)
            return [yield* Effect.exit(read.verify("write")), yield* Effect.exit(write.verify("read"))] as const
          })
        )

        expect(died(widened)).toBe(false)
        expect(refusalOf(widened)?.code).toBe("unauthorized")
        expect(refusalOf(widened)?.message).toBe(`${authority.subject} is read-only`)
        expect(Exit.isSuccess(narrowed)).toBe(true)
      }))
  }
})

describe("branch key rotation", () => {
  // The branch authority signed under one bare secret with no `kid`, so
  // rotating the branch secret invalidated every share link already out. It
  // now carries the workspace scheme: the retired key stays in the ring until
  // its links expire, and dropping it is what revokes them.
  it.effect("verifies a link minted under a retired key and refuses it once the key leaves the ring", () =>
    Effect.gen(function*() {
      const [minted, rotated, revoked] = yield* run(
        Effect.gen(function*() {
          const retired = { kid: "2026-08", secret: Redacted.make("retired-secret-0123456789abcdefg") }
          const active = { kid: "2026-09", secret: Redacted.make("active-secret-0123456789abcdefgh") }
          const old = yield* BranchShare.makeHmac({ activeKid: retired.kid, keys: [retired] })
          const capability = yield* old.mint({ branchId, capabilityId: "cap", access: "read", ttlMs: 60_000 })
          const rotated = yield* BranchShare.makeHmac({ activeKid: active.kid, keys: [active, retired] })
          const dropped = yield* BranchShare.makeHmac({ activeKid: active.kid, keys: [active] })
          return [
            capability.claims.kid,
            yield* rotated.verify(capability, { branchId, access: "read" }),
            yield* Effect.exit(dropped.verify(capability, { branchId, access: "read" }))
          ] as const
        })
      )

      expect(minted).toBe("2026-08")
      expect(rotated.kid).toBe("2026-08")
      expect(died(revoked)).toBe(false)
      expect(refusalOf(revoked)?.message).toBe("The share capability names an unknown signing key")
    }))

  it.effect("refuses a branch keyring that names a kid twice or an active kid it has no key for", () =>
    Effect.gen(function*() {
      const [duplicate, missing] = yield* run(
        Effect.gen(function*() {
          const key = { kid: "k1", secret: Redacted.make(secret) }
          return [
            yield* Effect.flip(BranchShare.makeHmac({ activeKid: "k1", keys: [key, key] })),
            yield* Effect.flip(BranchShare.makeHmac({ activeKid: "k2", keys: [key] }))
          ] as const
        })
      )

      expect(duplicate.code).toBe("invalid_request")
      expect(duplicate.message).toBe("The branch keyring names kid k1 twice")
      expect(missing.code).toBe("invalid_request")
      expect(missing.message).toBe("The branch keyring's active kid names no key in the ring")
    }))

  it.effect("layerConfig reads the redacted branch secret and key id from configuration", () =>
    Effect.gen(function*() {
      const mintedKid = (environment: Record<string, string>) =>
        Effect.gen(function*() {
          const share = yield* BranchShare.BranchShare
          const capability = yield* share.mint({ branchId, capabilityId: "cap", access: "read", ttlMs: 60_000 })
          yield* share.verify(capability, { branchId, access: "read" })
          return capability.claims.kid
        }).pipe(
          Effect.provide(
            BranchShare.layerConfig.pipe(
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment)))
            )
          )
        )
      const [defaultKid, namedKid, unconfigured] = yield* run(
        Effect.gen(function*() {
          return [
            yield* mintedKid({ SMITHERS_SYNC_BRANCH_SECRET: "configured-secret-0123456789abcd" }),
            yield* mintedKid({
              SMITHERS_SYNC_BRANCH_SECRET: "configured-secret-0123456789abcd",
              SMITHERS_SYNC_BRANCH_KEY_ID: "2026-09"
            }),
            yield* Effect.exit(mintedKid({}))
          ] as const
        })
      )

      expect(defaultKid).toBe("primary")
      expect(namedKid).toBe("2026-09")
      // No default secret: an unconfigured deployment fails to construct the
      // authority and every branch operation stays closed.
      expect(Exit.isSuccess(unconfigured)).toBe(false)
    }))
})
