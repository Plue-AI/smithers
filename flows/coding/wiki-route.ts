/** The host wiring of `coding/wiki` (wiki/flow.ts), beside the planning wiki it reuses. */
import { Interpreter } from "@smthrs/flow"
import { Effect, FileSystem, Layer } from "effect"
import { importDeclared } from "../memory/deps.ts"
import { type PageSpec, WikiError } from "../wiki/schema.ts"
import { ImportDocs, ReadPublishedWiki, readPublishedWiki } from "./wiki-refresh.ts"
import CodingWiki from "./wiki/flow.ts"

export const wikiRefreshRegistration = (options: {
  readonly repositoryPath: string
  readonly wikiOutput: string
  readonly pages: ReadonlyArray<PageSpec>
  readonly reviewer: string
  readonly hostPolicy?: string | undefined
}, fs?: FileSystem.FileSystem) =>
  Layer.mergeAll(
    Interpreter.layer(CodingWiki),
    ReadPublishedWiki.toLayer(({ base, refreshed }) => readPublishedWiki({ ...options, fs }, base, refreshed)),
    ImportDocs.toLayer(() =>
      importDeclared(options.repositoryPath).pipe(
        fs === undefined ? (effect) => effect : Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError((error) =>
          new WikiError({
            // Only a failed fetch can pass on retry; every other code needs the declaration or install fixed.
            code: error._tag === "DocsImportError" && error.code !== "fetch" ? "invalid-input" : "io",
            message: `Dependency docs were not imported: ${error.message}`
          })
        )
      )
    )
  )
