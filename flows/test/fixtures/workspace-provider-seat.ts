import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Effect, Layer } from "effect"
import { platform } from "../../../packages/smithers/src/internal/NodeControlHost.ts"
import * as Host from "../../coding/host.ts"

// Launched with the rendered workspace boot profile by the PostgreSQL-backed
// bootstrap regression. Resolve through the same startup and seat layers as serve.
const options = await Effect.runPromise(
  Host.optionsFromEnv(process.env).pipe(Effect.provide(platform.requestExecutor))
)
const request = await Effect.runPromise(
  Effect.gen(function*() {
    const seats = yield* SeatResolver.SeatResolver
    const seat = yield* seats.resolve("coding/implement")
    const request = yield* seat.route.prepare({
      modelId: seat.modelId,
      system: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      params: {}
    } as never)
    return { model: options.implementationModel, url: request.url }
  }).pipe(
    Effect.provide(
      Host.roleSeats({
        ...options,
        repositoryPath: process.cwd(),
        gatewayId: "11111111-1111-4111-8111-111111111111",
        credential: "fixture-host"
      })(process.env).pipe(Layer.provide(platform.requestExecutor))
    )
  )
)
process.stdout.write(JSON.stringify(request))
