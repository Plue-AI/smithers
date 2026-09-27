/**
 * The implementation seam for the ripgrep search contract.
 *
 * Both implementations answer the same normalized calls. `PortableSearch`
 * performs the work in-process; `NativeSearch` drives the `rg` executable.
 * Callers select an implementation by Layer and cannot observe which one was
 * selected from the result.
 *
 * @since 1.0.0
 */

import { Context, Effect, Layer } from "effect"
import * as StdError from "./StdError.ts"

/**
 * Normalized grep input shared by both implementations.
 *
 * @category models
 * @since 1.0.0
 */
export interface GrepInput {
  readonly pattern: string
  readonly root: string
  readonly fixedStrings: boolean
  readonly ignoreCase: boolean
  readonly smartCase: boolean
  readonly globs: ReadonlyArray<string>
  readonly beforeContext: number
  readonly afterContext: number
  readonly maxCount?: number | undefined
  readonly filesWithMatches: boolean
  /** Opt out of root-scoped .gitignore rules; defaults to false. */
  readonly noIgnore?: boolean | undefined
  readonly hidden: boolean
  readonly symbols: boolean
  readonly limit: number
}

/**
 * One matching or context line, as a peer produces it before grouping.
 *
 * @category models
 * @since 1.0.0
 */
export interface GrepLine {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly kind: "match" | "context"
}

/**
 * One context line carried inside the match it belongs to.
 *
 * @category models
 * @since 1.0.0
 */
export interface ContextLine {
  readonly line: number
  readonly text: string
}

/**
 * The definition enclosing a hit, when the file's shape says so plainly.
 *
 * @category models
 * @since 1.0.0
 */
export interface Symbol {
  readonly kind: string
  readonly name: string
  readonly startLine: number
  readonly endLine: number
}

/**
 * One hit: the matching line, the context that belongs to it, and the
 * definition it sits in.
 *
 * @category models
 * @since 1.0.0
 */
export interface GrepMatch {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly before: ReadonlyArray<ContextLine>
  readonly after: ReadonlyArray<ContextLine>
  readonly symbol?: Symbol | undefined
}

/**
 * Normalized grep output.
 *
 * @category models
 * @since 1.0.0
 */
export interface GrepOutput {
  readonly matches: ReadonlyArray<GrepMatch>
  readonly files: ReadonlyArray<string>
  readonly filesSearched: number
  readonly skippedBinary: number
  readonly truncated: boolean
  readonly notice?: string | undefined
}

/**
 * Normalized glob input.
 *
 * @category models
 * @since 1.0.0
 */
export interface GlobInput {
  readonly pattern: string
  readonly root: string
  /** Opt out of root-scoped .gitignore rules; defaults to false. */
  readonly noIgnore?: boolean | undefined
  readonly hidden: boolean
  readonly limit: number
}

/**
 * Normalized glob output.
 *
 * @category models
 * @since 1.0.0
 */
export interface GlobOutput {
  readonly paths: ReadonlyArray<string>
  readonly total: number
  readonly truncated: boolean
  readonly notice?: string | undefined
}

/**
 * The one search contract implemented by native and portable peers.
 *
 * @category services
 * @since 1.0.0
 */
export interface Search {
  readonly grep: (input: GrepInput) => Effect.Effect<GrepOutput, StdError.StdError>
  readonly glob: (input: GlobInput) => Effect.Effect<GlobOutput, StdError.StdError>
}

/**
 * The {@link Search} service tag.
 *
 * @category services
 * @since 1.0.0
 */
export const Search: Context.Service<Search, Search> = Context.Service("@smthrs/std/Search")

/**
 * Builds a search service from its two operations.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (service: Search): Search => Search.of(service)

/**
 * Builds an unavailable search service for compositions that deliberately omit search.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeNoop = (): Search => {
  const unavailable = () =>
    Effect.fail(
      new StdError.StdError({
        code: "provider_unavailable",
        message: "No search implementation is configured"
      })
    )
  return make({ grep: unavailable, glob: unavailable })
}

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerNoop: Layer.Layer<Search> = Layer.succeed(Search, makeNoop())
