import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { afterAll, expect, it } from "@effect/vitest"
import { SecretUnavailable } from "@smthrs/targets/SecretProxy"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { caller, holder, Ship } from "../src/42-placed-deploy.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-placed-deploy-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const token = `deploy-secret-${randomBytes(16).toString("hex")}`
const holderEnv = (name: string) => (name === "DEPLOY_TOKEN" ? token : undefined)
const callerEnv = () => undefined

/** An HTTP endpoint that records the Authorization header of every request. */
const endpoint = Effect.acquireRelease(
  Effect.promise(async () => {
    const seen: Array<string | undefined> = []
    const server = createServer((request, response) => {
      seen.push(request.headers.authorization)
      request.resume()
      response.writeHead(201).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    return { seen, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
  }),
  ({ server }) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
)

/** Every byte a SQLite engine file and its sidecars hold. */
const journalText = (file: string) =>
  [file, `${file}-wal`, `${file}-shm`].filter(existsSync).map((path) => readFileSync(path).toString("latin1")).join("")

it.effect("runs the secret-using action only on the holder, against the holder's endpoint", () =>
  Effect.gen(function*() {
    const deployEndpoint = yield* endpoint
    // What the caller would reach if the action ran here: it must see nothing.
    const callerEndpoint = yield* endpoint
    const holderFile = join(directory, "holder.sqlite")
    const held = yield* Layer.build(
      holder(holderFile, holderEnv, deployEndpoint.url, NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" }))
    )
    const address = Context.get(held, HttpServer.HttpServer).address
    if (address._tag !== "InetAddressV4") return yield* Effect.die("expected a TCP holder")
    const holderUrl = `http://127.0.0.1:${address.port}/`

    const first = join(directory, "caller.sqlite")
    const shipped = yield* Ship.execute({ version: "1.2.3" }, { executionId: "ship-1" }).pipe(
      Effect.provide(caller(first, callerEnv, callerEndpoint.url, holderUrl)),
      Effect.scoped
    )
    expect(shipped).toEqual({ version: "1.2.3", status: 201 })
    expect(deployEndpoint.seen).toEqual([`Bearer ${token}`])
    expect(callerEndpoint.seen).toEqual([])

    // A caller that lost its journal before recording the reply asks again
    // under the same invocation key; the holder answers from its record.
    const again = yield* Ship.execute({ version: "1.2.3" }, { executionId: "ship-1" }).pipe(
      Effect.provide(caller(join(directory, "caller-again.sqlite"), callerEnv, callerEndpoint.url, holderUrl)),
      Effect.scoped
    )
    expect(again).toEqual(shipped)
    expect(deployEndpoint.seen).toHaveLength(1)

    for (const file of [first, join(directory, "caller-again.sqlite"), holderFile]) {
      expect(journalText(file)).toContain("examples/PlacedDeploy/PushRelease")
      expect(journalText(file)).not.toContain(token)
    }
    expect(journalText(first)).not.toContain(deployEndpoint.url)
    expect(JSON.stringify(shipped)).not.toContain(token)
  }).pipe(Effect.scoped), 120_000)

it.effect("fails with SecretUnavailable when the table runs the action on the caller", () =>
  Effect.gen(function*() {
    const callerEndpoint = yield* endpoint
    const exit = yield* Ship.execute({ version: "1.2.4" }, { executionId: "ship-here" }).pipe(
      Effect.provide(caller(join(directory, "caller-here.sqlite"), callerEnv, callerEndpoint.url)),
      Effect.scoped,
      Effect.exit
    )
    // The defect crossed the caller's journal, so it is the recorded shape, not the class instance.
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
      name: new SecretUnavailable("DEPLOY_TOKEN").name,
      message: new SecretUnavailable("DEPLOY_TOKEN").message
    })
    expect(callerEndpoint.seen).toEqual([])
  }).pipe(Effect.scoped), 60_000)
