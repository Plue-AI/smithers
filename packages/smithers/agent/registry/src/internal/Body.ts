/**
 * The shared source-byte integrity boundary for registry bodies.
 *
 * @since 1.0.0-rc.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import type { FlowDescriptor } from "../Descriptor.ts"

type BodyFailure =
  | { readonly _tag: "unmeasured" }
  | { readonly _tag: "changed" }
  | { readonly _tag: "unreadable"; readonly cause: unknown }

/**
 * Reads only measured bodies and verifies their complete source bytes.
 * File URLs are decoded through the host Path service without changing the
 * descriptor's import specifier. Callers adapt failures to their public errors.
 *
 * @category loading
 * @since 1.0.0-rc.0
 */
export const readVerifiedBody = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  descriptor: FlowDescriptor
): Effect.Effect<Uint8Array, BodyFailure> =>
  Effect.gen(function*() {
    const digest = descriptor.body.contentDigest
    if (digest === undefined) return yield* Effect.fail({ _tag: "unmeasured" } as const)

    const bytes = yield* Effect.gen(function*() {
      const sourcePath = descriptor.body.path
      const bodyPath = sourcePath.startsWith("file:")
        ? yield* Effect.flatMap(Effect.try(() => new URL(sourcePath)), (url) => path.fromFileUrl(url))
        : path.normalize(sourcePath)
      return yield* fs.readFile(bodyPath)
    }).pipe(Effect.mapError((cause) => ({ _tag: "unreadable" as const, cause })))

    if (Digest.digest(bytes) !== digest) return yield* Effect.fail({ _tag: "changed" } as const)
    return bytes
  })
