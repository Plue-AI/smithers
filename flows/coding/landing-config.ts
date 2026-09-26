/** Consume the existing provisioned repository credential at the executable boundary. */
import { Config, ConfigProvider, Effect, FileSystem, Option, Schema } from "effect"
import type { Options } from "./landing.ts"
import { SourcePublication } from "./native-schema.ts"
import { CodingError } from "./schema.ts"

const Binding = Schema.Struct({
  version: Schema.Literal(1),
  repositoryPath: Schema.NonEmptyString,
  repositorySlug: Schema.NonEmptyString,
  apiBaseUrl: Schema.NonEmptyString,
  repositoryId: SourcePublication.fields.repositoryId,
  workspaceId: SourcePublication.fields.workspaceId
})
const unavailable = () =>
  new CodingError({
    code: "unavailable",
    message:
      "Cloud finalization requires the existing provisioned workspace binding and its reserved repository API credential"
  })

/** The mutable record is the executable's environment, not a workflow value.
 * Consume before any host/model/process layers start. Checks already use their
 * explicit environment; ordinary approved shell tools must not inherit this token.
 */
export const load = (
  root: string,
  environment: Record<string, string | undefined>,
  filename = "/etc/smithers/workspace-coding.json"
): Effect.Effect<Options | undefined, CodingError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const provider = yield* Effect.sync(() => {
      const selected = {
        SMITHERS_JJHUB_TOKEN: environment.SMITHERS_JJHUB_TOKEN,
        SMITHERS_JJHUB_API_URL: environment.SMITHERS_JJHUB_API_URL
      }
      delete environment.SMITHERS_JJHUB_TOKEN
      return ConfigProvider.fromEnvRecord(selected, { preserveEmptyStrings: true })
    })
    const token = yield* Config.option(Config.Redacted("SMITHERS_JJHUB_TOKEN")).parse(provider).pipe(
      Effect.mapError(unavailable)
    )
    const api = yield* Config.option(Config.String("SMITHERS_JJHUB_API_URL")).parse(provider).pipe(
      Effect.mapError(unavailable)
    )
    if (Option.isNone(token) && Option.isNone(api)) return undefined
    if (Option.isNone(token) || Option.isNone(api)) return yield* unavailable()
    const fs = yield* FileSystem.FileSystem
    const stat = yield* fs.stat(filename).pipe(Effect.mapError(unavailable))
    if (stat.type !== "File" || stat.size > 16_384n) return yield* unavailable()
    const binding = yield* fs.readFileString(filename).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(Schema.fromJsonString(Binding))(value)),
      Effect.mapError(unavailable)
    )
    if (
      binding.apiBaseUrl !== api.value || binding.repositoryPath !== root ||
      (yield* fs.realPath(binding.repositoryPath).pipe(Effect.mapError(unavailable))) !==
        (yield* fs.realPath(root).pipe(Effect.mapError(unavailable)))
    ) {
      return yield* unavailable()
    }
    return {
      apiBaseUrl: api.value,
      token: token.value,
      repositorySlug: binding.repositorySlug,
      repositoryId: binding.repositoryId,
      workspaceId: binding.workspaceId
    }
  })
