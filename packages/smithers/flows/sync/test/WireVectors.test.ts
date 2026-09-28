/**
 * Golden wire vectors: the exact bytes this package puts on a connection.
 *
 * Every other test in this suite round-trips a value through the package's own
 * schemas, so it asserts that the encoder and the decoder agree with each other
 * and nothing about what either produces. A renamed field, a reordered struct,
 * a changed tag, or a changed signing encoding keeps every one of those tests
 * green while breaking every already-deployed follower and every outstanding
 * share link.
 *
 * These vectors are the frozen answer. They are literals on purpose: an
 * intentional wire change edits them and says so in the changelog, and an
 * unintentional one fails here.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Effect, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CommandReceipt, type ShareClaims } from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as SyncAuth from "../src/SyncAuth.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as WorkspaceShare from "../src/WorkspaceShare.ts"

const runId = "vector-run" as JournalEvent.RunId

/** The JSON text a value takes on the wire, through its own schema encoder. */
const wire = <A, I>(schema: Schema.Codec<A, I>, value: A): string =>
  JSON.stringify(Schema.encodeUnknownSync(schema)(value))

const entry = new JournalEvent.Entry({
  runId,
  seq: 7 as JournalEvent.Seq,
  eventId: "vector-event",
  sourceId: "vector-source" as JournalEvent.SourceId,
  sourceSeq: 3 as JournalEvent.SourceSeq,
  emittedAtMs: 1_700_000_000_000,
  eventType: "run.started",
  payload: { note: "hello" },
  meta: null
})

describe("frame vectors", () => {
  it("freezes the encoding of every Frame variant", () => {
    expect(
      wire(SyncProtocol.Frame, {
        generation: 0,
        _tag: "Entries",
        runId,
        fromSeq: 7 as JournalEvent.Seq,
        toSeq: 7 as JournalEvent.Seq,
        entries: [entry]
      })
    ).toBe(
      `{"_tag":"Entries","runId":"vector-run","generation":0,"fromSeq":7,"toSeq":7,"entries":[{"runId":"vector-run","seq":7,"eventId":"vector-event","sourceId":"vector-source","sourceSeq":3,"emittedAtMs":1700000000000,"eventType":"run.started","payload":{"note":"hello"},"meta":null}]}`
    )

    expect(wire(SyncProtocol.Frame, { _tag: "Heartbeat" })).toBe(`{"_tag":"Heartbeat"}`)

    expect(wire(SyncProtocol.Frame, { _tag: "Closed", reason: "server shutting down" })).toBe(
      `{"_tag":"Closed","reason":"server shutting down"}`
    )
    expect(wire(SyncProtocol.Frame, { _tag: "Closed" })).toBe(`{"_tag":"Closed"}`)
  })

  it("freezes the encoding of a read response and its cursors", () => {
    expect(
      wire(SyncProtocol.ReadResponse, {
        entries: [entry],
        cursors: [{ generation: 0, runId, afterSeq: 7 as JournalEvent.Seq }],
        done: false
      })
    ).toBe(
      `{"entries":[{"runId":"vector-run","seq":7,"eventId":"vector-event","sourceId":"vector-source","sourceSeq":3,"emittedAtMs":1700000000000,"eventType":"run.started","payload":{"note":"hello"},"meta":null}],"cursors":[{"runId":"vector-run","afterSeq":7,"generation":0}],"done":false}`
    )
  })

  it("freezes the encoding of a command receipt", () => {
    expect(
      wire(
        CommandReceipt,
        new CommandReceipt({
          branchId: "vector-branch" as ShareClaims["branchId"],
          commandId: "vector-command" as CommandReceipt["commandId"],
          status: "duplicate",
          seq: 7 as JournalEvent.Seq
        })
      )
    ).toBe(
      `{"branchId":"vector-branch","commandId":"vector-command","status":"duplicate","seq":7}`
    )
  })
})

/**
 * A signature is the tightest possible vector for a canonical encoding: it
 * covers the scheme label, the field order, the separators, and the UTF-8
 * length prefixes at once, and no part of it can drift without changing the
 * hex below. The two hexes differ under one secret and one set of trailing
 * fields, which is the domain separation between the authorities stated as a
 * number rather than as a comment.
 *
 * Neither hex was copied out of this package. Both were computed with
 * `node:crypto` over the canonical string written beside each one, so they
 * check the package's encoding against an independent implementation of the
 * same rule rather than against itself:
 *
 *     crypto.createHmac("sha256", Buffer.from("vector-secret-0123456789abcdefgh", "utf8"))
 *       .update(Buffer.from(canonical, "utf8")).digest("hex")
 */
describe("signing vectors", () => {
  const secret = Redacted.make("vector-secret-0123456789abcdefgh")

  it.effect("freezes the branch authority's signature over fixed claims", () =>
    Effect.gen(function*() {
      const share = yield* BranchShare.makeHmac({ activeKid: "vector-kid", keys: [{ kid: "vector-kid", secret }] })
      const capability = yield* share.mint({
        branchId: "vector-branch" as ShareClaims["branchId"],
        capabilityId: "vector-capability",
        access: "read",
        ttlMs: 60_000
      })

      expect(capability.claims.issuedAtMs).toBe(0)
      expect(capability.claims.expiresAtMs).toBe(60_000)
      expect(capability.claims.kid).toBe("vector-kid")
      // canonical:
      // 27:@smthrs/sync/BranchShare/v210:vector-kid13:vector-branch17:vector-capability4:read1:05:60000
      expect(capability.signature).toBe(
        "d0c5ddd57dc1e03bb6c98cb73bd9aae245c7b3c8b17514945c68276a847f97a3"
      )
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("freezes the workspace authority's signature over fixed claims", () =>
    Effect.gen(function*() {
      const share = yield* WorkspaceShare.makeHmac({
        activeKid: "vector-kid",
        keys: [{ kid: "vector-kid", secret }]
      })
      const capability = yield* share.mint({
        capabilityId: "vector-capability",
        access: "read",
        ttlMs: 60_000
      })

      expect(capability.claims.kid).toBe("vector-kid")
      // canonical:
      // 30:@smthrs/sync/WorkspaceShare/v110:vector-kid17:vector-capability4:read1:05:60000
      expect(capability.signature).toBe(
        "e2fed097e508c17323c6689fca24f10503fbca5fcb790863caa779d8f3008bf3"
      )
    }).pipe(Effect.provide(TestClock.layer())))
})

describe("capability header vectors", () => {
  it.effect("freezes the base64url header a connection presents", () =>
    Effect.gen(function*() {
      const header = yield* SyncAuth.encodeCapability(
        new WorkspaceShare.WorkspaceCapability({
          claims: new WorkspaceShare.WorkspaceClaims({
            kid: "vector-kid",
            capabilityId: "vector-capability",
            access: "read",
            issuedAtMs: 0,
            expiresAtMs: 60_000
          }),
          signature: "abc123"
        })
      )

      // base64url of
      // {"claims":{"kid":"vector-kid","capabilityId":"vector-capability",
      //  "access":"read","issuedAtMs":0,"expiresAtMs":60000},
      //  "signature":"abc123"}
      expect(header).toBe(
        "eyJjbGFpbXMiOnsia2lkIjoidmVjdG9yLWtpZCIsImNhcGFiaWxpdHlJZCI6InZlY3Rvci1jYXBhYmlsaXR5IiwiYWNjZXNzIjoicmVhZCIsImlzc3VlZEF0TXMiOjAsImV4cGlyZXNBdE1zIjo2MDAwMH0sInNpZ25hdHVyZSI6ImFiYzEyMyJ9"
      )
      expect(yield* SyncAuth.decodeCapability(header)).toStrictEqual(
        new WorkspaceShare.WorkspaceCapability({
          claims: new WorkspaceShare.WorkspaceClaims({
            kid: "vector-kid",
            capabilityId: "vector-capability",
            access: "read",
            issuedAtMs: 0,
            expiresAtMs: 60_000
          }),
          signature: "abc123"
        })
      )
    }))
})
