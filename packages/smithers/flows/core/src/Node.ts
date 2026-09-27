/**
 * The pipeable node AST a flow body returns.
 *
 * The model itself lives in `@smthrs/plan` (`@smthrs/plan/Node`), the lowest
 * package both this one and the library that executes a plan depend on. This
 * module is the re-export `@smthrs/core` consumers reach it through and
 * carries no logic of its own: one node model, one AST, one set of
 * combinators, whichever package asks.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */

export * from "@smthrs/plan/Node"
