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
import { expandSeat } from "../../packages/smithers/src/Providers.ts"
import { configuredCodingRoutes, layer, reviewDefault, roleResolver, roleSeats, seatProvider } from "../coding/host.ts"
import { Landing } from "../coding/landing.ts"
import { loadProject } from "../coding/project-config.ts"
import { makeHostJudge } from "./fixtures/scripted-judge.ts"

/** Configuration never calls the adapter; every method refuses if a layer is built. */
const refused = Effect.die("host configuration must not reach the landing adapter")
const landing = Layer.succeed(Landing, {
  kind: "backend",
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
  // A host without the backend binding lands through the project's own lander.
  for (const lander of ["fast-forward", "pull-request"] as const) {
    assert.deepEqual(
      configuredCodingRoutes({ planning: { ...planning, wiki: false, landing: lander } }).map((route) => route.name),
      ["coding/request", "coding/vibe", "coding/verify"]
    )
  }
})

test("a project lander configures coding/vibe without a backend binding", () => {
  const options = {
    repositoryPath: "/unused",
    gatewayId: "11111111-1111-4111-8111-111111111111",
    implementationModel: "test:model",
    credential: "operator-key",
    planning: { implementation: "coding/implementation", checks: [], wiki: false, landing: "fast-forward" as const }
  }
  assert.doesNotThrow(() => layer({ ...platform, evaluator: makeHostJudge().layer }, options))
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
    seats: { "coding/implement": "luna", "coding/plan": "sol", triage: "luna", review: "opus" }
  })
  for (const id of ["coding/implement", "coding/plan", "coding/poc", "triage", "review", "repository/author"]) {
    assert.equal((await Effect.runPromise(roles.resolve(id))).id, id)
  }
  assert.deepEqual(resolved, ["luna", "sol", "test:implementation", "luna", "opus", "test:implementation"])
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
  assert.deepEqual(undeclared.decision.candidates, ["luna", "sol", "opus", "fable", "sonnet"])
  assert.deepEqual([undeclared.decision.seat, undeclared.decision.backups], ["sonnet", []])
  assert.equal(undeclared.seat.modelId, "sonnet")
  const auto = await routed(Seat.auto, "Summarize the Anthropic thread")
  assert.deepEqual([auto.decision.seat, auto.decision.backups], ["opus", ["sol"]])
  const declared = await routed("coding/plan", "Summarize the Anthropic thread")
  assert.equal(declared.decision.decidedBy, "declared")
  assert.equal(declared.seat.id, "coding/plan")
  assert.equal(declared.seat.modelId, "luna")
})

test("a role whose seat is auto routes by the graph as its phase, and never resolves to a fixed seat", async () => {
  const resolved: Array<string> = []
  const model = Model.make({
    stream: () => {
      throw new Error("seat resolution must not invoke a provider")
    }
  })
  const base: SeatResolver.Service = {
    resolve: (id) =>
      Effect.sync(() => {
        resolved.push(id)
        return Seat.make({
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
      })
  }
  const roles = roleResolver(base, "sol", {
    seats: { "coding/implement": "auto", "coding/review": "auto", "wiki/reviewer": "auto", triage: "auto" }
  })
  assert.deepEqual(roles.routedAs?.("coding/implement"), { phase: "implement" })
  assert.deepEqual(roles.routedAs?.("coding/review"), { phase: "review" })
  assert.deepEqual(roles.routedAs?.("wiki/reviewer"), { phase: "review" })
  // A repository's own role routes too; Jev classifies its phase.
  assert.deepEqual(roles.routedAs?.("triage"), { phase: undefined })
  // Roles with a fixed seat, and ids that are not roles, resolve as declared.
  assert.equal(roles.routedAs?.("coding/plan"), undefined)
  assert.equal(roles.routedAs?.("opus"), undefined)
  const unresolved = await Effect.runPromise(Effect.flip(roles.resolve("coding/implement")))
  assert.equal(unresolved.seat, "coding/implement")
  assert.equal((await Effect.runPromise(roles.resolve("coding/plan"))).modelId, "sol")
  assert.deepEqual(resolved, ["sol"])
  // An implementer the graph routes leaves the review to the graph as well.
  assert.equal(reviewDefault(Seat.auto), Seat.auto)
  assert.deepEqual(roleResolver(base, "sol", { seats: { "coding/implement": "auto" } }).routedAs?.("coding/review"), {
    phase: "review"
  })
})

test("this repository routes every coding role by the graph", async () => {
  const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)))
  const planning = await Effect.runPromise(loadProject(root, undefined).pipe(Effect.provide(NodeServices.layer)))
  assert.ok(planning?.seats)
  const roles = roleResolver(SeatResolver.makeNoop(), "sol", { seats: planning.seats })
  for (
    const [role, phase] of [
      ["coding/implement", "implement"],
      ["coding/dispatch", undefined],
      ["coding/plan", "plan"],
      ["coding/poc", "implement"],
      ["coding/review", "review"],
      ["wiki/reviewer", "review"],
      ["repository/research", "other"],
      ["repository/evaluator", "review"],
      ["repository/author", "implement"],
      ["flow/author", "implement"]
    ] as const
  ) assert.deepEqual(roles.routedAs?.(role), { phase }, role)
})

test("coding/review defaults to a provider different from the effective implementer", async () => {
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
        modelId: expandSeat(id),
        contextWindowTokens: 16_000,
        route: {
          prepare: () => {
            throw new Error("seat resolution must not prepare provider requests")
          }
        }
      })
  }
  const provider = (seat: string) => expandSeat(seat).split(":")[0]
  const resolve = (implementationModel: string, models?: Parameters<typeof roleResolver>[2]) =>
    Effect.runPromise(
      Effect.all({
        implement: roleResolver(base, implementationModel, models).resolve("coding/implement"),
        review: roleResolver(base, implementationModel, models).resolve("coding/review")
      })
    )
  // The literal role is replaced by a model seat whose provider differs from the implementer's.
  for (const implementationModel of ["luna", "sol", "opus", "fable", "qwen", "openai:gpt-6-luna"]) {
    const { implement, review } = await resolve(implementationModel)
    assert.equal(review.id, "coding/review")
    assert.notEqual(review.modelId, "coding/review", "the role resolves to a model seat")
    assert.notEqual(provider(review.modelId), provider(implement.modelId), `review beside ${implementationModel}`)
  }
  assert.equal(reviewDefault("luna"), "opus")
  assert.equal(reviewDefault("anthropic:claude-opus-5-5"), "sol")
  // A harness or a router runs its model's vendor: never reviewed by that vendor again.
  assert.equal(seatProvider("codex:sol"), "openai")
  assert.equal(seatProvider("openrouter:openai/gpt-6-sol"), "openai")
  assert.equal(seatProvider("openrouter:anthropic/claude-opus-5-5"), "anthropic")
  assert.equal(seatProvider("gpt-6-sol"), "")
  assert.equal(reviewDefault("codex:sol"), "opus")
  assert.equal(reviewDefault("codex:gpt-6.1-sol"), "opus")
  assert.equal(reviewDefault("openrouter:openai/gpt-6-sol"), "opus")
  assert.equal(reviewDefault("openrouter:anthropic/claude-opus-5-5"), "sol")
  // The repository's implementer override moves the default with it.
  const overridden = await resolve("luna", { seats: { "coding/implement": "opus" } })
  assert.equal(overridden.implement.modelId, "anthropic:claude-opus-5-5")
  assert.equal(provider(overridden.review.modelId), "openai")
  // An explicit review seat, from the environment or the repository, is kept as declared.
  const pinned = await resolve("luna", { reviewModel: "sol" })
  assert.equal(pinned.review.modelId, "openai:gpt-6.1-sol")
  const declared = await resolve("luna", { reviewModel: "sol", seats: { "coding/review": "fable" } })
  assert.equal(declared.review.modelId, "anthropic:claude-fable-5-1")
})
