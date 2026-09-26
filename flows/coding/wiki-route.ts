/** The host wiring of `coding/wiki` (wiki/flow.ts), beside the planning wiki it reuses. */
import { Interpreter } from "@smthrs/flow"
import { type FileSystem, Layer } from "effect"
import type { PageSpec } from "../wiki/schema.ts"
import { ReadPublishedWiki, readPublishedWiki } from "./wiki-refresh.ts"
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
    ReadPublishedWiki.toLayer(({ base, refreshed }) => readPublishedWiki({ ...options, fs }, base, refreshed))
  )
