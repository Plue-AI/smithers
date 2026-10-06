import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { describe, expect, it } from "@effect/vitest"
import * as ControlError from "@smthrs/control/ControlError"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { RpcSerialization } from "effect/unstable/rpc"
import { createServer } from "node:http"
import * as HostBranchPresence from "../src/HostBranchPresence.ts"

const server = HttpRouter.serve(
  HostBranchPresence.layer({
    runtimeArtifactDigest: "a".repeat(64),
    sourceRevision: "b".repeat(40),
    ownerGeneration: 1,
    authenticate: (headers) =>
      headers.authorization === "Bearer test-host"
        ? Effect.succeed({ id: "host", kind: "bearer", stampedAt: 1 })
        : Effect.fail(new ControlError.Unauthorized({ message: "Unauthorized" }))
  }),
  { disableListenLog: true, disableLogger: true }
).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
  Layer.orDie
)
const scope = {
  branchId: "b1",
  capability: {
    signature: "ignored",
    claims: { kid: "host", branchId: "b1", capabilityId: "ignored", access: "write", issuedAtMs: 0, expiresAtMs: 0 }
  }
}

describe("host branch protocol HTTP", () => {
  it.effect("authenticates each call and retains independent session leases and literal coordinates", () =>
    Effect.gen(function*() {
      const host = yield* HttpServer.HttpServer
      const address = host.address
      if (address._tag !== "InetAddressV4") throw new Error("TCP server required")
      const call = (tag: string, payload: unknown, token = "test-host") =>
        Effect.promise(async () => {
          const response = await fetch(`http://127.0.0.1:${address.port}/branch`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ _tag: "Request", id: 1, tag, payload, headers: [] }) + "\n"
          })
          const raw = await response.text()
          return JSON.parse(raw.trim().split("\n")[0]!).exit
        })
      const announce = {
        ...scope,
        participantId: "member:2",
        displayName: "Alice",
        kind: "person",
        cursor: null,
        where: { kind: "file", path: "retry.ts", line: 12 }
      }
      expect((yield* call("Branch.Announce", { ...announce, sessionId: "tab1" }, "wrong"))._tag).toBe("Failure")
      expect((yield* call("Branch.Roster", scope)).value).toEqual([])
      expect((yield* call("Branch.Announce", { ...announce, sessionId: "tab1" }))._tag).toBe("Success")
      yield* call("Branch.Announce", {
        ...announce,
        sessionId: "tab2",
        where: { kind: "file", path: "retry.ts", line: 40 }
      })
      const rows = (yield* call("Branch.Roster", scope)).value
      expect(rows).toHaveLength(2)
      expect(rows.map((row: any) => row.where.line).sort()).toEqual([12, 40])
      yield* call("Branch.Leave", { ...scope, participantId: "member:2", sessionId: "tab1" })
      expect((yield* call("Branch.Roster", scope)).value.map((row: any) => row.sessionId)).toEqual(["tab2"])
      yield* call("Branch.Leave", { ...scope, participantId: "member:2", sessionId: "tab2" })
      expect((yield* call("Branch.Roster", scope)).value).toEqual([])
    }).pipe(Effect.provide(server), Effect.scoped))
})
