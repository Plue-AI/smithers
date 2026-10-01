/**
 * Captures the work a session did as a diff the host can apply.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "./Session.ts"

/**
 * The session changed its checkout: `patch` is a `git diff --binary` from
 * `base` to the checkout's final tree.
 *
 * `base` is a full commit id that existed in the checkout when the session
 * opened. It is never a commit the session made, so a host that has fetched
 * the same history resolves it; `SandboxMerge.apply` fetches it when it is
 * missing. The patch covers committed and uncommitted edits, new files,
 * deletions, renames, mode changes and binary contents alike, because it
 * compares trees rather than history.
 *
 * @category models
 * @since 1.0.0
 */
export class Changed extends Schema.TaggedClass<Changed>()("Changed", {
  /** The session key the work was captured from. */
  session: Schema.String,
  /** The commit the patch applies to. */
  base: Schema.String,
  /** A `git diff --binary --full-index --find-renames` from `base`. */
  patch: Schema.String
}) {}

/**
 * The session left its checkout's tree exactly at `base`.
 *
 * @category models
 * @since 1.0.0
 */
export class Unchanged extends Schema.TaggedClass<Unchanged>()("Unchanged", {
  /** The session key the work was captured from. */
  session: Schema.String,
  /** The commit the tree still matches. */
  base: Schema.String
}) {}

/**
 * What a session did to its checkout. It is a plain JSON value, so an action
 * that returns it journals it, and the work survives the machine.
 *
 * @category models
 * @since 1.0.0
 */
export const Work = Schema.Union([Changed, Unchanged])

/**
 * The value form of {@link Work}.
 *
 * @category models
 * @since 1.0.0
 */
export type Work = Changed | Unchanged

/**
 * Why a session's work could not be captured.
 *
 * - `not_a_repository`: the checkout is not the top of a git work tree, or
 *   the guest has no `git`.
 * - `base_unresolved`: the base revision names no commit in the checkout.
 * - `capture_failed`: `git` failed while diffing.
 *
 * @category errors
 * @since 1.0.0
 */
export class CaptureError extends Schema.TaggedError<CaptureError>()("@smthrs/sandbox/Sandbox/CaptureError", {
  reason: Schema.Literals(["not_a_repository", "base_unresolved", "capture_failed"]),
  message: Schema.String
}) {}

/**
 * Where a session's checkout is and which commit its work is measured from.
 *
 * @category models
 * @since 1.0.0
 */
export interface CheckoutOptions {
  /** The absolute guest path of the git work tree. Default: the session's workdir. */
  readonly checkout?: string | undefined
}

// Exit statuses the guest scripts below reserve for their own verdicts.
const notARepository = 3
const unresolved = 4

// The checkout must be the top of a work tree: patch paths are relative to it.
const repositoryGuard = `top=$(git rev-parse --show-toplevel 2>/dev/null) || exit ${notARepository}
[ "$top" = "$(pwd -P)" ] || exit ${notARepository}
`

const baseScript =
  `${repositoryGuard}git rev-parse --verify --quiet "$SMITHERS_REVISION^{commit}" || exit ${unresolved}`

/**
 * Diffs the work tree against the base through a private copy of the index,
 * so untracked files count and neither the checkout's own index nor its
 * history changes. Copying the real index first keeps git's stat cache, so a
 * large tree is not rehashed. Every option that could reshape the patch is
 * pinned on the command line rather than left to guest configuration.
 */
const captureScript = `set -e
${repositoryGuard}git rev-parse --verify --quiet "$SMITHERS_BASE^{commit}" >/dev/null || exit ${unresolved}
index="$(git rev-parse --absolute-git-dir)/smithers-capture.$$.index"
trap 'rm -f "$index"' EXIT
real="$(git rev-parse --git-path index)"
if [ -f "$real" ]; then cp "$real" "$index"; else GIT_INDEX_FILE="$index" git read-tree "$SMITHERS_BASE"; fi
GIT_INDEX_FILE="$index" git add -A .
GIT_INDEX_FILE="$index" git -c core.quotePath=false -c diff.noprefix=false diff --cached --binary --full-index \\
  --find-renames --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ "$SMITHERS_BASE" --`

const ran = (session: Session, script: string, checkout: string, env: Record<string, string>) =>
  Effect.scoped(Effect.gen(function*() {
    const process = yield* session.spawn(script, { cwd: checkout, env })
    const [stdout, stderr, code] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(process.stdout)),
        Stream.mkString(Stream.decodeText(process.stderr)),
        process.exitCode
      ],
      { concurrency: "unbounded" }
    )
    return { stdout, stderr, code }
  }))

const verdict = (
  checkout: string,
  revision: string,
  exited: { readonly stderr: string; readonly code: number }
): CaptureError =>
  exited.code === notARepository || exited.code === 127
    ? new CaptureError({
      reason: "not_a_repository",
      message: `${checkout} is not the top of a git work tree in the session`
    })
    : exited.code === unresolved
    ? new CaptureError({ reason: "base_unresolved", message: `${revision} names no commit in ${checkout}` })
    : new CaptureError({
      reason: "capture_failed",
      message: `git exited ${exited.code} in ${checkout}: ${exited.stderr.trim().split("\n").slice(-3).join("\n")}`
    })

/**
 * Resolves `revision` in the session's checkout to a full commit id. Called
 * when a session opens, it fixes the base its work is measured from before
 * anything in the guest can move it.
 *
 * @category capture
 * @since 1.0.0
 */
export const resolveBase = (
  session: Session,
  options: CheckoutOptions & { readonly revision?: string | undefined } = {}
): Effect.Effect<string, CaptureError | ProviderError> =>
  Effect.gen(function*() {
    const checkout = options.checkout ?? session.workdir
    const revision = options.revision ?? "HEAD"
    const exited = yield* ran(session, baseScript, checkout, { SMITHERS_REVISION: revision })
    if (exited.code !== 0) return yield* verdict(checkout, revision, exited)
    return exited.stdout.trim()
  })

/**
 * Captures the session's checkout as {@link Work} relative to `base`:
 * {@link Unchanged} when its tree equals the base's, else {@link Changed}
 * with the patch. Files the checkout's `.gitignore` excludes are not work.
 *
 * Call it while the session is still held. `run` does, before the scope that
 * owns the machine closes, so the diff exists before any provider tears the
 * guest down.
 *
 * @category capture
 * @since 1.0.0
 */
export const capture = (
  session: Session,
  options: CheckoutOptions & { readonly base: string }
): Effect.Effect<Work, CaptureError | ProviderError> =>
  Effect.gen(function*() {
    const checkout = options.checkout ?? session.workdir
    const exited = yield* ran(session, captureScript, checkout, { SMITHERS_BASE: options.base })
    if (exited.code !== 0) return yield* verdict(checkout, options.base, exited)
    return exited.stdout === ""
      ? new Unchanged({ session: session.id, base: options.base })
      : new Changed({ session: session.id, base: options.base, patch: exited.stdout })
  })
