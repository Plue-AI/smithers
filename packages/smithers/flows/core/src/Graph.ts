/**
 * Plan-time graph building: the topology a flow reveals when planned.
 *
 * The builder itself lives in `@smthrs/flow` (`@smthrs/flow/Graph`), the
 * library that also executes what it plans. This module is the re-export
 * `@smthrs/core` consumers reach it through and carries no logic of its own:
 * one graph builder, one set of refusals, whichever package asks.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */

export * from "@smthrs/flow/Graph"
