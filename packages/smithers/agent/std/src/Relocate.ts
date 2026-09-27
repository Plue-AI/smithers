/**
 * What can be pointed at a checkpoint, and what cannot.
 *
 * {@link relocate} is the closed answer, and it is the half of the checkpoint
 * feature that tracks the flows rather than git: it knows that `bash` carries
 * its working directory in `cwd` and that `read`, `ls`, `grep` and `glob` carry
 * their subject in `path`, `path`, `root` and `root`. `Checkpoints` changes when
 * git does; this changes when one of those five input shapes does, which is why
 * it is a module of its own. `Relocate.test.ts` decodes every rewritten input
 * with the flow's own `Input` schema, so a renamed field fails there rather than
 * silently relocating nothing.
 *
 * `bash` names *where it runs*, so it is relocated by its `cwd` — into the
 * checkpoint, and into the same subdirectory of it the call asked for, because a
 * check declared in `tests/` that silently ran at the top would come back
 * failing for a reason nobody chose. `read`, `ls`, `grep` and `glob` name *what
 * they touch* relative to the workspace root, so they are relocated by prefixing
 * that root — and only when the path they name stays inside the tree, because an
 * absolute path in these runs is a container path the host cannot rebase and a
 * `..` path is the live tree under another name. Every other flow answers
 * `checkpoint_unsupported` through the harness, including `test`, which already
 * has `against: "base"` for exactly this question and would otherwise have two
 * mechanisms that can disagree.
 *
 * @since 1.0.0
 */

import type { Schema } from "effect"
import type { Materialized } from "./Checkpoints.ts"
import { withoutTrailingSlash } from "./internal/Paths.ts"

/**
 * The flows whose input names where they run or what they read, and the field
 * that says so.
 *
 * A closed table rather than a per-flow hook, because the set is small and the
 * rule for admitting one is exact: the field has to name a location the whole
 * call is relative to. `bash` runs in a directory; the four readers resolve
 * their subject against the workspace root. Everything else — an edit, a patch,
 * a web fetch, a memory write — either names no location or writes, and both
 * are refused above this module.
 *
 * `test` is deliberately absent. It answers this exact question already, with
 * `against: "base"`, and a second mechanism pointed at the same tree is a way
 * for two answers to disagree.
 */
const located: Readonly<Record<string, { readonly field: string; readonly kind: "cwd" | "path" }>> = {
  bash: { field: "cwd", kind: "cwd" },
  read: { field: "path", kind: "path" },
  ls: { field: "path", kind: "path" },
  grep: { field: "root", kind: "path" },
  glob: { field: "root", kind: "path" }
}

/**
 * Why one input could not be pointed at a checkpoint.
 *
 * @category models
 * @since 1.0.0
 */
export type Relocation =
  | { readonly _tag: "Relocated"; readonly input: Schema.Json }
  | { readonly _tag: "UnsupportedFlow" }
  | { readonly _tag: "AbsolutePath"; readonly path: string }
  | { readonly _tag: "OutsideTree"; readonly path: string }

/**
 * Resolves `.` and `..` inside a relative path, or answers `undefined` when the
 * path climbs out of whatever it would be joined under.
 *
 * This is the whole of the isolation the reader rule can enforce, and it is not
 * optional. Prefixing blindly turns `../../mod.py` into
 * `.flows-checkpoints/cp-1-0/../../mod.py`, which is a path back into the live
 * tree — so the cell would read the work it is trying to take a baseline
 * against, the journal would record that reading under the checkpoint it named,
 * and the call key folds the checkpoint in, so the live reading would replay as
 * a pinned one forever. A proof built on it is a proof of nothing, which is the
 * exact failure this module exists to abolish.
 */
const contained = (path: string): string | undefined => {
  const parts: Array<string> = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment !== "..") {
      parts.push(segment)
      continue
    }
    if (parts.length === 0) return undefined
    parts.pop()
  }
  return parts.join("/")
}

/**
 * The part of `declared` that names a place inside `root`, or `undefined` when
 * it names somewhere the checkpoint does not hold a copy of.
 *
 * A relative path is already workspace-relative. An absolute one is compared
 * against the root on the side that issued it — a container call names the
 * mount, a host call names this machine — because that is the only prefix the
 * store can strip without guessing.
 */
const within = (root: string, declared: string): string | undefined => {
  if (!declared.startsWith("/")) return contained(declared)
  if (withoutTrailingSlash(declared) === root) return ""
  return declared.startsWith(`${root}/`) ? contained(declared.slice(root.length + 1)) : undefined
}

/**
 * Rewrites one call's input so the call runs against a materialized checkpoint.
 *
 * Returns the rewritten input, or the reason there is none. A `bash` call runs
 * in the checkpoint's directory — from the *guest* side when it names a
 * container, because that is the path the container will be given — and keeps
 * whatever subdirectory it asked for: a check declared in `tests/` runs in the
 * checkpoint's `tests/`. A working directory the checkpoint holds no copy of,
 * such as somewhere else on the machine, becomes the checkpoint's own top,
 * because a tree is all this can offer and there is no subpath in it to keep.
 *
 * A reader takes the checkpoint's workspace-relative directory as the prefix of
 * what it names, because these flows resolve their subject against the
 * workspace root and the checkpoint is a directory under it.
 *
 * Two paths are refused rather than rewritten, and both for the same reason —
 * the host would otherwise hand back a reading of a tree the cell did not name.
 * An absolute path in these runs is a container path, and the host cannot know
 * which prefix of it names the tree. A relative path that climbs past the
 * checkpoint with `..` names the live tree, exactly the tree the reading was
 * taken to avoid.
 *
 * @category conversions
 * @since 1.0.0
 */
export const relocate = (
  flow: string,
  input: Schema.Json,
  materialized: Materialized
): Relocation => {
  const rule = located[flow]
  if (rule === undefined) return { _tag: "UnsupportedFlow" }
  const record = input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, Schema.Json>
    : {}
  const declared = record[rule.field]
  if (rule.kind === "cwd") {
    // A container call is given the path the container will resolve; a host
    // call is given the host's. `bash` chooses which by naming a container, so
    // this reads the same field it does.
    const containerised = typeof record["container"] === "string" && record["container"] !== ""
    const base = containerised ? materialized.guest : materialized.host
    const kept = typeof declared === "string" && declared !== ""
      ? within(containerised ? materialized.guestRoot : materialized.root, declared)
      : ""
    return {
      _tag: "Relocated",
      input: { ...record, cwd: kept === undefined || kept === "" ? base : `${base}/${kept}` }
    }
  }
  const relative = materialized.host.slice(withoutTrailingSlash(materialized.root).length + 1)
  if (declared === undefined) return { _tag: "Relocated", input: { ...record, [rule.field]: relative } }
  if (typeof declared !== "string") return { _tag: "UnsupportedFlow" }
  if (declared.startsWith("/")) return { _tag: "AbsolutePath", path: declared }
  const kept = contained(declared)
  if (kept === undefined) return { _tag: "OutsideTree", path: declared }
  return { _tag: "Relocated", input: { ...record, [rule.field]: kept === "" ? relative : `${relative}/${kept}` } }
}
