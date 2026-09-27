/**
 * @since 1.0.0-rc.0
 *
 * Host domain errors, shaped after `effect/PlatformError`.
 *
 * Effect's platform errors carry normalized operation data — a stable `_tag`
 * reason, the `module` and `method` that failed, a human `description`, and the
 * original `cause` — and are constructed through small helpers rather than
 * `new`. We mirror that exactly, with two deliberate deviations:
 *
 *  - the normalized reason lives in a `code` field rather than a nested
 *    `reason._tag`, because ours is a small closed set per service; and
 *  - the classes are `Schema.TaggedError`, not `Data.TaggedError`, because
 *    Host failures cross the durability boundary and must round-trip.
 *
 * Codes are a STABLE public contract: callers branch on them, step keys digest
 * them, UIs map them to remediation. Never repurpose a code — add one.
 */

import type { JjError } from "@smthrs/jj"

/**
 * Every failure the Host surface is allowed to surface.
 *
 * `JjError` is declared by `@smthrs/jj` beside its contract; it is named here
 * because that service is still part of the closed Host surface
 * (`HostServices.ts`). This is a type union, not a re-export — import the
 * error itself from its package.
 *
 * Running a command is absent on purpose: process execution is Effect's
 * `ChildProcessSpawner`, so it fails with `PlatformError` like the rest of
 * `effect`'s platform surface.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type HostError = JjError
