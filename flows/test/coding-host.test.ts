import { NodeServices } from "@effect/platform-node"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as SeatRouter from "@smthrs/agent/SeatRouter"
import * as ApprovalAuthority from "@smthrs/control/ApprovalAuthority"
import * as Model from "@smthrs/model/Model"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { realpath } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { platform } from "../../packages/smithers/src/internal/NodeControlHost.ts"
import { configuredCodingRoutes, layer, roleResolver, roleSeats } from "../coding/host.ts"
import { Landing } from "../coding/landing.ts"
import { loadProject } from "../coding/project-config.ts"
import { makeHostJudge } from "./fixtures/scripted-judge.ts"

/** Configuration never calls the adapter; every method refuses if a layer is built. */
const refused = Effect.die("host configuration must not reach the landing adapter")
const landing = Layer.succeed(Landing, {
  binding: { repositoryId: 1, workspaceId: "22222222-2222-4222-8222-222222222222" },
  readMain: refused,
  pinMain: refused,
  prepare: () => refused,
  create: () => refused,
  queue: () => refused,
  observe: () => refused,
  readDelivery: refused,
  openPull: () => refused
})

test("the repository default and a landing binding select the coding routes", async () => {
  const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)))
  const planning = await Effect.runPromise(loadProject(root, undefined).pipe(Effect.provide(NodeServices.layer)))
  assert.ok(planning)
  assert.deepEqual(configuredCodingRoutes({ planning, landing }), [
    { name: "coding/request", capability: "coding-request/v1" },
    { name: "coding/vibe", capability: "coding-vibe/v1" },
    { name: "coding/verify", capability: "coding-verify/v1" },
    { name: "coding/wiki", capability: "coding-wiki/v1" }
  ])
  assert.deepEqual(configuredCodingRoutes({ planning }), [
    { name: "coding/request", capability: "coding-request/v1" },
    { name: "coding/verify", capability: "coding-verify/v1" },
    { name: "coding/wiki", capability: "coding-wiki/v1" }
  ])
  // A project without a wiki registers no wiki route.
  assert.deepEqual(configuredCodingRoutes({ planning: { ...planning, wiki: false } }).map((route) => route.name), [
    "coding/request",
    "coding/verify"
  ])
  assert.deepEqual(configuredCodingRoutes({ landing }), [])
})

test("coding deployment requires an explicit model and owning gateway before opening services", () => {
  const options = {
    repositoryPath: "/unused",
    gatewayId: "11111111-1111-4111-8111-111111111111",
    implementationModel: ""
  }
  assert.throws(() => layer({ ...platform, evaluator: makeHostJudge().layer }, options), /explicit provider:model/)
  assert.throws(
    () =>
      layer({ ...platform, evaluator: makeHostJudge().layer }, { ...options, implementationModel: "implicit-model" }),
    /explicit provider:model/
  )
  assert.throws(
    () =>
      layer({ ...platform, evaluator: makeHostJudge().layer }, {
        ...options,
        implementationModel: "test:model",
        gatewayId: ""
      }),
    /owning SMITHERS_GATEWAY_ID/
  )
  assert.throws(
    () =>
      layer({ ...platform, evaluator: makeHostJudge().layer }, {
        ...options,
        implementationModel: "test:model",
        gatewayId: "00000000-0000-0000-0000-000000000000"
      }),
    /owning SMITHERS_GATEWAY_ID/
  )
  for (const credential of [undefined, "", "  "]) {
    assert.throws(
      () =>
        layer({ ...platform, evaluator: makeHostJudge().layer }, {
          ...options,
          implementationModel: "test:model",
          credential
        }),
      /SMITHERS_API_KEY or an explicit approval authority/
    )
  }
  assert.doesNotThrow(() =>
    layer({ ...platform, evaluator: makeHostJudge().layer }, {
      ...options,
      implementationModel: "test:model",
      credential: "operator-key"
    })
  )
  assert.doesNotThrow(() =>
    layer({ ...platform, evaluator: makeHostJudge().layer }, {
      ...options,
      implementationModel: "test:model",
      approvalAuthority: ApprovalAuthority.local
    })
  )
  // A landing binding alone is a supported deployment: repository automation
  // consumes Landing without the prompt route. `coding/vibe` stays out of the
  // catalog until the project configuration is present too, so this configures
  // rather than refuses (b1aebc1a19a6; flows/coding/finalization.md).
  assert.doesNotThrow(() =>
    layer({ ...platform, evaluator: makeHostJudge().layer }, {
      ...options,
      implementationModel: "test:model",
      credential: "operator-key",
      landing
    })
  )
})

test("the coding role reuses the existing seat resolver and keeps the approved role identity", async () => {
  const resolved: string[] = []
  const model = Model.make({
    stream: () => {
      throw new Error("seat resolution must not invoke a provider")
    }
  })
  const base: SeatResolver.Service = {
    resolve: (id) => {
      resolved.push(id)
      return Effect.succeed({
        id,
        model,
        modelId: "chosen-model",
        contextWindowTokens: 16_000,
        route: {
          prepare: () => {
            throw new Error("seat resolution must not prepare provider requests")
          }
        }
      })
    }
  }
  const seats = roleResolver(base, "test:chosen-model")
  const coding = await Effect.runPromise(seats.resolve("coding/implement"))
  assert.equal(coding.id, "coding/implement")
  assert.equal(coding.model, model)
  assert.equal(coding.modelId, "chosen-model")
  const other = await Effect.runPromise(seats.resolve("test:other-model"))
  assert.equal(other.id, "test:other-model")
  assert.deepEqual(resolved, ["test:chosen-model", "test:other-model"])
  const roles = roleResolver(base, "test:implementation", {
    planningModel: "test:planning",
    pocModel: "test:cheap-prototype",
    wikiModel: "test:wiki-review"
  })
  for (const id of ["coding/implement", "coding/plan", "coding/poc", "wiki/reviewer", "constructor"]) {
    assert.equal((await Effect.runPromise(roles.resolve(id))).id, id)
  }
  assert.deepEqual(resolved.slice(2), [
    "test:implementation",
    "test:planning",
    "test:cheap-prototype",
    "test:wiki-review",
    "constructor"
  ])
  for (const id of ["coding/plan", "coding/poc", "wiki/reviewer"]) await Effect.runPromise(seats.resolve(id))
  assert.deepEqual(resolved.slice(-3), ["test:chosen-model", "test:chosen-model", "test:chosen-model"])
})

test("repository seats win for the roles they name and add roles its flows declare", async () => {
  const resolved: string[] = []
  const model = Model.make({
    stream: () => {
      throw new Error("seat resolution must not invoke a provider")
    }
  })
  const base: SeatResolver.Service = {
    resolve: (id) => {
      resolved.push(id)
      return Effect.succeed({
        id,
        model,
        modelId: id,
        contextWindowTokens: 16_000,
        route: {
          prepare: () => {
            throw new Error("seat resolution must not prepare provider requests")
          }
        }
      })
    }
  }
  const roles = roleResolver(base, "test:implementation", {
    planningModel: "test:planning",
    seats: { "coding/implement": "luna", "coding/plan": "sol", triage: "luna", review: "astra" }
  })
  for (const id of ["coding/implement", "coding/plan", "coding/poc", "triage", "review", "repository/author"]) {
    assert.equal((await Effect.runPromise(roles.resolve(id))).id, id)
  }
  assert.deepEqual(resolved, ["luna", "sol", "test:implementation", "luna", "astra", "test:implementation"])
})

test("an undeclared or auto flow routes by the graph over the host's seats, and a declared role is kept", async () => {
  const model = Model.make({
    stream: () => {
      throw new Error("seat resolution must not invoke a provider")
    }
  })
  const base: SeatResolver.Service = {
    resolve: (id) =>
      Effect.succeed({
        id,
        model,
        modelId: id,
        contextWindowTokens: 16_000,
        route: {
          prepare: () => {
            throw new Error("seat resolution must not prepare provider requests")
          }
        }
      })
  }
  const options = {
    repositoryPath: "/unused",
    gatewayId: "11111111-1111-4111-8111-111111111111",
    implementationModel: "sol",
    planningModel: "luna",
    seats: { "wiki/reviewer": "opus" }
  }
  const judge = makeHostJudge().layer
  const state = (task: string) => ({ task, flow: "chore", description: "", capabilities: [] })
  const routed = (declared: string, task: string) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const decision = yield* SeatRouter.route({ declared, state: state(task) })
        const seats = yield* SeatResolver.SeatResolver
        return { decision, seat: yield* seats.resolve(decision.seat) }
      }).pipe(
        Effect.provide(
          Layer.merge(
            roleSeats(options, base)({ OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "sk-ant" }).pipe(
              Layer.provide(platform.requestExecutor)
            ),
            judge
          )
        )
      )
    )
  // AgentSession routes a flow with no `model:` exactly as `model: auto`.
  const undeclared = await routed(Seat.auto, "Rename one variable")
  assert.equal(undeclared.decision.decidedBy, "jev")
  assert.deepEqual(undeclared.decision.candidates, ["luna", "sol", "astra", "opus", "fable", "sonnet"])
  assert.deepEqual([undeclared.decision.seat, undeclared.decision.backups], ["sonnet", []])
  assert.equal(undeclared.seat.modelId, "sonnet")
  const auto = await routed(Seat.auto, "Summarize the Anthropic thread")
  assert.deepEqual([auto.decision.seat, auto.decision.backups], ["opus", ["sol"]])
  const declared = await routed("coding/plan", "Summarize the Anthropic thread")
  assert.equal(declared.decision.decidedBy, "declared")
  assert.equal(declared.seat.id, "coding/plan")
  assert.equal(declared.seat.modelId, "luna")
})
