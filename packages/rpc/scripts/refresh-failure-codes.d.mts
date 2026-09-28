/**
 * Types for the vendoring script, consumed by the rpc vitest suite.
 *
 * The suite recomputes plue's digest with the same function the generator
 * uses, so the two can never disagree about what the digest covers. That only
 * holds if the row shape is declared once — here — rather than restated at
 * each call site.
 */

/** One row of plue's `docs/failure-codes.json`, in plue's own snake_case wire spelling. */
export interface FailureCodeRow {
  readonly code: string
  readonly fault: string
  readonly status: number
  readonly retry_after: number
  readonly doc: string
}

/**
 * plue's digest over the code rows: sha256 over Go's compact JSON encoding of
 * the rows in document order, with Go's default HTML escaping.
 */
export const digestOf: (codes: ReadonlyArray<FailureCodeRow>) => string

/**
 * Why a parsed document cannot be rendered into TypeScript; empty when every
 * field has the shape the generator emits as data.
 */
export const validationErrors: (document: unknown) => ReadonlyArray<string>
