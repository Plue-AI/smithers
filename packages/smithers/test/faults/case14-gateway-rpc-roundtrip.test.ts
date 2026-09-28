/**
 * Case 14 — `smthrs serve` answers a real remote round trip.
 *
 * The whole point of the case is that nothing here shares a process with the
 * server: planning, launching, and listing cross a socket through the shipped
 * RPC schemas. Approval uses a separate local operator CLI, since bearer
 * authentication does not delegate approval authority. Both paths land in a
 * SQLite file this process never opens.
 * The server is the product's own command — `smthrs serve`, spawned from the
 * bin `@smthrs/cli` declares — so the composition, the authentication, and the
 * database location are the verb's decisions rather than the suite's.
 */
import { Control } from "@smthrs/control"
import { isAlive, parentPid } from "@smthrs/testing/Faults"
import * as Effect from "effect/Effect"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { controlClient, localDecision, type ServeProcess, startServe } from "./harness/serveProcess.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case14-"))
let server: ServeProcess

beforeAll(async () => {
  server = await startServe(directory)
}, 180_000)

afterAll(async () => {
  await server?.stop()
  rmSync(directory, { recursive: true, force: true })
})

const remote = <A, E>(body: Effect.Effect<A, E, Control.Control>): Promise<A> =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(controlClient({ url: server.url, credential: server.token }).layer),
      Effect.scoped
    )
  )

describe("case14 gateway RPC round trip", () => {
  it("plans remotely, refuses bearer approval, then launches a locally approved run", async () => {
    const result = await remote(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* control.plan({ flowId: "system/test", input: { case: "case14" } })
        expect((yield* Effect.flip(control.approve(card.approval)))._tag).toBe("/control/Unauthorized")
        const decision = yield* Effect.promise(() => localDecision(directory, "approve", card.approval))
        expect(decision, decision.stderr).toMatchObject({ status: 0 })
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: `run:${card.planId}`
        })
        const listed = yield* control.list({ _tag: "runs" })
        return { card, receipt, listed }
      })
    )

    expect(result.card.flowId).toBe("system/test")
    expect(result.receipt._tag).toBe("Accepted")
    expect(result.listed).toMatchObject({ _tag: "runs" })
  }, 180_000)

  it("is answered by a separate `smthrs serve` process, over its own database", async () => {
    // The server is another process: it has its own pid, it is this suite's
    // child rather than this suite, and it is still alive after the round trip
    // above. Without these three the case could pass against a server built in
    // this process, which is the thing it exists to rule out.
    expect(server.pid).not.toBe(process.pid)
    expect(parentPid(server.pid)).toBe(process.pid)
    expect(isAlive(server.pid)).toBe(true)
    expect(server.argv).toContain("serve")
    expect(server.argv.slice(0, 2)).toEqual(["--import", expect.stringContaining("scripted-native-host.ts")])
    expect(server.argv[2]?.endsWith("bin/smithers.mjs")).toBe(true)

    // And it chose where the run went. `.flows/control.db` under the project
    // root is the verb's decision, not a path this suite handed it.
    expect(server.databasePath).toBe(join(directory, ".flows", "control.db"))
    expect(existsSync(server.databasePath)).toBe(true)
  })

  it("keeps local approval across restart while environment credentials remain unable to decide", async () => {
    const card = await remote(Effect.gen(function*() {
      const control = yield* Control.Control
      const card = yield* control.plan({ flowId: "system/test", input: { case: "case14-restart" } })
      const decision = yield* Effect.promise(() => localDecision(directory, "approve", card.approval))
      expect(decision, decision.stderr).toMatchObject({ status: 0 })
      return card
    }))
    const pid = server.pid
    const credential = server.token
    await server.stop()
    server = await startServe(directory, { credential })
    expect(server.pid).not.toBe(pid)
    expect(server.argv).not.toContain("--credential")
    await remote(Effect.gen(function*() {
      const control = yield* Control.Control
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: `restart:${card.planId}`
      })
      expect(receipt._tag).toBe("Accepted")
      const approved = yield* control.plan({ flowId: "system/test", input: { case: "case14-env-approve" } })
      expect((yield* Effect.flip(control.approve(approved.approval)))._tag).toBe("/control/Unauthorized")
      const approval = yield* Effect.promise(() => localDecision(directory, "approve", approved.approval))
      expect(approval, approval.stderr).toMatchObject({ status: 0 })
      expect(
        (yield* control.run({
          _tag: "Plan",
          planId: approved.planId,
          digest: approved.digest,
          envelope: approved.envelope,
          idempotencyKey: `env:${approved.planId}`
        }))._tag
      ).toBe("Accepted")
      const denied = yield* control.plan({ flowId: "system/test", input: { case: "case14-env-deny" } })
      expect((yield* Effect.flip(control.deny(denied.approval)))._tag).toBe("/control/Unauthorized")
      const denial = yield* Effect.promise(() => localDecision(directory, "deny", denied.approval))
      expect(denial, denial.stderr).toMatchObject({ status: 0 })
      expect(
        (yield* Effect.flip(control.run({
          _tag: "Plan",
          planId: denied.planId,
          digest: denied.digest,
          envelope: denied.envelope,
          idempotencyKey: `deny:${denied.planId}`
        })))._tag
      ).toBe("/control/PlanDenied")
    }))
  }, 180_000)
})
