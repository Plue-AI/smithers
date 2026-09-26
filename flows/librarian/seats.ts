import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Digest from "@smthrs/core/Digest"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import { ModelRequest } from "@smthrs/model/ModelRequest"
import { Effect, Schema, Stream } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

// The existing native Anthropic route supports this explicit, versioned model.
export const defaultModel = "anthropic:claude-sonnet-4-5"
export const roles = ["librarian/history-author", "librarian/reviewer"] as const
export interface Options {
  readonly model?: string | undefined
  readonly transcripts?: string | undefined
  readonly record?: boolean | undefined
  readonly apiUrl?: string | undefined
}
export const configured = (options: Options = {}): string => {
  const model = options.model ?? defaultModel
  if (!/^[a-z0-9-]+:[^\s:]+$/.test(model)) {
    throw new Seat.SeatUnresolved({
      seat: model,
      message: "Set SMITHERS_LIBRARIAN_MODEL to an explicit provider:model"
    })
  }
  if (options.transcripts !== undefined && (!options.transcripts.trim() || !loopback(options.apiUrl ?? ""))) {
    throw new Seat.SeatUnresolved({
      seat: "librarian/transcripts",
      message: "SMITHERS_LIBRARIAN_TRANSCRIPTS requires a directory and a loopback SMITHERS_PRODUCT_API_URL"
    })
  }
  return model
}
export const fromEnvironment = (env: Readonly<Record<string, string | undefined>>): Options => ({
  model: env.SMITHERS_LIBRARIAN_MODEL ?? defaultModel,
  transcripts: env.SMITHERS_LIBRARIAN_TRANSCRIPTS,
  record: env.SMITHERS_LIBRARIAN_RECORD === "1",
  apiUrl: env.SMITHERS_PRODUCT_API_URL
})
export const loopback = (value: string): boolean => {
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
      (url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
  } catch {
    return false
  }
}

// Canonical model requests contain no route headers or credentials. Preserve all
// prompt bytes and sampling knobs; dropping any would make a false replay hit.
export const canonicalRequest = (request: ModelRequest): string =>
  Digest.canonical(Schema.encodeSync(ModelRequest)(request))
export const transcriptKey = (request: ModelRequest): string => Digest.digest(canonicalRequest(request))
const Transcript = Schema.Struct({
  version: Schema.Literal(1),
  request: Schema.String,
  events: Schema.Array(ModelEvent)
})

export const transcriptModel = (directory: string, live?: Model.Model): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.unwrap(Effect.gen(function*() {
        const canonical = canonicalRequest(request), path = join(directory, `${transcriptKey(request)}.json`)
        const saved = yield* Effect.tryPromise({
          try: async () => {
            try {
              return await readFile(path, "utf8")
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
              throw cause
            }
          },
          catch: () =>
            new ModelError({ code: "invalid_provider_output", message: `Cannot read Librarian transcript ${path}` })
        })
        if (saved !== undefined) {
          const transcript = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(Transcript)(JSON.parse(saved)),
            catch: () =>
              new ModelError({ code: "invalid_provider_output", message: `Invalid Librarian transcript ${path}` })
          })
          if (transcript.request !== canonical) {
            return yield* new ModelError({
              code: "invalid_provider_output",
              message: `Librarian transcript request mismatch: ${path}`
            })
          }
          return Stream.fromIterable(transcript.events)
        }
        if (live === undefined) {
          return yield* new ModelError({
            code: "no_route",
            message: `Missing Librarian transcript ${path}; recording is opt-in`
          })
        }
        // Only complete successful streams become fixtures. Exclusive creation keeps
        // concurrent recordings from silently replacing the answer to one request.
        const events = yield* Stream.runCollect(live.stream(request))
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(directory, { recursive: true })
            const bytes = JSON.stringify({ version: 1, request: canonical, events })
            try {
              await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
            } catch (cause) {
              if (
                (cause as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== bytes
              ) throw cause
            }
          },
          catch: () =>
            new ModelError({ code: "invalid_provider_output", message: `Cannot record Librarian transcript ${path}` })
        })
        return Stream.fromIterable(events)
      }))
  })

export const roleResolver = (
  base: SeatResolver.Service,
  model: string = defaultModel,
  options: Options = {}
): SeatResolver.Service => {
  configured({ ...options, model })
  const replay = options.transcripts === undefined ? undefined : transcriptModel(options.transcripts)
  return SeatResolver.make({
    resolve: (id) => {
      if (!roles.some((role) => role === id)) return base.resolve(id)
      // Replay never resolves the provider, even when inherited credentials exist.
      if (replay !== undefined && !options.record) {
        return Effect.succeed(Seat.make({
          id,
          modelId: Seat.modelIdOf(model),
          model: replay,
          contextWindowTokens: SeatResolver.contextWindowTokensFor(Seat.modelIdOf(model)),
          route: {
            prepare: (request) =>
              Effect.succeed({
                routeId: "librarian/transcript",
                protocolId: "librarian/transcript-v1",
                method: "POST",
                url: "http://127.0.0.1/librarian/transcript",
                publicHeaders: {},
                body: new TextEncoder().encode(canonicalRequest(request)),
                bodyText: canonicalRequest(request)
              })
          }
        }))
      }
      return base.resolve(model).pipe(
        Effect.map((seat) =>
          Seat.make({
            ...seat,
            id,
            model: options.transcripts === undefined ? seat.model : transcriptModel(options.transcripts, seat.model)
          })
        ),
        Effect.mapError((error) => new Seat.SeatUnresolved({ seat: id, message: error.message }))
      )
    }
  })
}
