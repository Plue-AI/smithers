/** A recording model resolved through the CLI's shared seat services. */
import * as NodeControl from "@smthrs/cli/NodeControl"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

const executor = RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))
export const liveModel = (seat: string): Model.Model => Model.make({
  stream: (request) => Stream.unwrap(Effect.gen(function*() {
    const transport = yield* RequestExecutor.RequestExecutor
    const resolved = yield* NodeControl.seatResolver(process.env, transport).resolve(seat).pipe(
      Effect.mapError((error) => new ModelError.ModelError({ code: "authentication", message: error.message }))
    )
    return resolved.model.stream(request)
  }).pipe(Effect.provide(executor)))
})
