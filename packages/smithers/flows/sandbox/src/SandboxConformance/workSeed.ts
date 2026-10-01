/**
 * The tree a `work` conformance seed's base commit must contain.
 *
 * @since 1.0.0
 */

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

/**
 * The files, relative to the repository root, that the base commit of a
 * {@link WorkSeed} must contain, each a regular non-executable file.
 *
 * The `captures-its-work` check edits exactly these: it appends to
 * `tracked.txt`, renames `rename-me.txt`, deletes `delete-me.txt`, marks
 * `chmod-me.sh` executable, and rewrites `binary.bin`. A caller commits them
 * with its own `git`, bundles the commit, and passes both; the suite runs no
 * host `git` itself.
 *
 * @category models
 * @since 1.0.0
 */
export const workSeedFiles: Readonly<Record<string, Uint8Array>> = {
  "tracked.txt": text("tracked\n"),
  // Long enough that a pure rename scores far above git's similarity floor.
  "rename-me.txt": text(
    Array.from({ length: 32 }, (_, line) => `rename fixture line ${line}\n`).join("")
  ),
  "delete-me.txt": text("delete me\n"),
  "chmod-me.sh": text("#!/bin/sh\nexit 0\n"),
  "binary.bin": new Uint8Array([0, 1, 2, 255, 254, 0, 10, 13, 0])
}

/**
 * A repository a session can check out without reaching the network: a `git
 * bundle` holding `base`, whose tree contains {@link workSeedFiles}.
 *
 * @category models
 * @since 1.0.0
 */
export interface WorkSeed {
  /** The bytes of a `git bundle create` file whose refs reach `base`. */
  readonly bundle: Uint8Array
  /** The full commit id, in the bundle, that the session checks out. */
  readonly base: string
}
