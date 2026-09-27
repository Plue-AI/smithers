/**
 * Consumer-scoped source overlays for build-system execution.
 *
 * Overlay declarations stay inert file-set values. A consumer whose `data`
 * closure reaches one receives the replacement files in a scratch workspace,
 * leaving the real source tree untouched.
 *
 * @since 0.1.0
 */

import * as Input from "@smthrs/targets/Input"
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Target from "@smthrs/targets/Target"
import { constants } from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

/** One replacement applied to a consumer scratch tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface Replacement {
  readonly overlay: string
  readonly path: string
  readonly source: string
  readonly digest: string
}

/** A resolved overlay closure, or a typed planning refusal.
 *
 * @category models
 * @since 0.1.0
 */
export type Resolution =
  | { readonly replacements: ReadonlyArray<Replacement>; readonly refusal?: undefined }
  | { readonly replacements: ReadonlyArray<Replacement>; readonly refusal: string }

const targetsIn = (value: unknown, into: Array<Target.AnyTarget>, seen: Set<object>): void => {
  if (Target.isTarget(value)) {
    into.push(value)
    return
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) targetsIn(entry, into, seen)
    return
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor !== undefined && "value" in descriptor) targetsIn(descriptor.value, into, seen)
  }
}

const member = (attrs: unknown, name: string): unknown => {
  if (typeof attrs !== "object" || attrs === null) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(attrs, name)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
}

/**
 * Resolves every Overlay reachable from a target's data/filegroup closure.
 * Replacement destinations and source files are anchored to the Overlay's
 * declaring package, not to the eventual consumer.
 *
 * @category planning
 * @since 0.1.0
 */
export const resolve = async (options: {
  readonly root: string
  readonly consumer: Target.AnyTarget
  readonly packagePathOf: (target: Target.AnyTarget) => string
  readonly labelOf: (target: Target.AnyTarget) => string
}): Promise<Resolution> => {
  const direct: Array<Target.AnyTarget> = []
  targetsIn(member(Target.metadata(options.consumer).attrs, "data"), direct, new Set())
  const visited = new Set<Target.AnyTarget>()
  const overlays = new Set<Target.AnyTarget>()
  const walk = (target: Target.AnyTarget): void => {
    if (visited.has(target)) return
    visited.add(target)
    const metadata = Target.metadata(target)
    if (metadata.target === "Overlay") {
      overlays.add(target)
      const base: Array<Target.AnyTarget> = []
      targetsIn(member(metadata.attrs, "base"), base, new Set())
      for (const nested of base) walk(nested)
      return
    }
    // A Filegroup is a file-set union: an Overlay listed in its `srcs` is a
    // member of the consumer's own set and reaches it. Every other target
    // contributes its declared outputs, not its inputs, so its `data` is not
    // walked: descending there would hand one build's private source
    // substitution to every downstream consumer of its outputs.
    if (metadata.target !== "Filegroup") return
    const next: Array<Target.AnyTarget> = []
    targetsIn(member(metadata.attrs, "srcs"), next, new Set())
    for (const nested of next) walk(nested)
  }
  for (const target of direct) walk(target)

  const replacements: Array<Replacement> = []
  const destinations = new Map<string, string>()
  for (const overlay of overlays) {
    const metadata = Target.metadata(overlay)
    const packagePath = options.packagePathOf(overlay)
    const replace = member(metadata.attrs, "replace")
    if (typeof replace !== "object" || replace === null) continue
    for (const [declared, value] of Object.entries(replace)) {
      if (typeof value !== "object" || value === null || (value as { readonly _tag?: unknown })._tag !== "File") {
        continue
      }
      const path = Input.resolvePath(packagePath, declared)
      const earlier = destinations.get(path)
      const label = options.labelOf(overlay)
      if (earlier !== undefined && earlier !== label) {
        return {
          replacements,
          refusal: `Overlay conflict: ${earlier} and ${label} both replace ${path}`
        }
      }
      destinations.set(path, label)
      const source = Input.resolvePath(packagePath, String((value as { readonly path: unknown }).path))
      const digest = await Input.digestFile(NodePath.join(options.root, ...source.split("/")), {
        workspaceRoot: options.root
      })
      if (digest === undefined) {
        return { replacements, refusal: `Overlay ${label} replacement source is missing: ${source}` }
      }
      replacements.push({ overlay: label, path, source, digest })
    }
  }
  replacements.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : left.overlay < right.overlay ? -1 : 1
  )
  return { replacements }
}

/** Applies replacements to a scratch workspace without touching the source tree.
 * Paths must stay inside scratch. Destination directory links are refused;
 * an internal final file link is replaced, leaving its target untouched.
 *
 * @category execution
 * @since 0.1.0
 */
export const apply = async (root: string, replacements: ReadonlyArray<Replacement>): Promise<void> => {
  const canonical = await SafeFs.canonicalRoot(root)
  for (const replacement of replacements) {
    const source = NodePath.join(canonical, ...replacement.source.split("/"))
    const destination = NodePath.join(canonical, ...replacement.path.split("/"))
    for (const [what, path] of [["source", source], ["destination", destination]] as const) {
      if (!SafeFs.inside(canonical, path)) {
        throw new Error(`Overlay ${what} is outside the scratch workspace: ${path}`)
      }
    }
    const admitted = await SafeFs.resolveFile(source, { root: canonical, what: "Overlay source" })
    if (admitted === undefined) throw new Error(`Overlay source is missing: ${source}`)

    // Admit every existing parent before recursive mkdir: a missing descendant
    // must not hide a portal above it, including a dangling directory link.
    const parent = NodePath.dirname(destination)
    let ancestor = canonical
    for (const part of NodePath.relative(canonical, parent).split(NodePath.sep).filter(Boolean)) {
      ancestor = NodePath.join(ancestor, part)
      if (await SafeFs.resolveDirectory(ancestor, { root: canonical, what: "Overlay destination directory" })) continue
      const entry = await Fs.lstat(ancestor).catch((cause: unknown) => {
        if (SafeFs.errorCode(cause) === "ENOENT") return undefined
        throw cause
      })
      if (entry !== undefined) {
        throw new Error(`Overlay destination directory is not a real directory in scratch: ${ancestor}`)
      }
      break
    }
    const existing = await SafeFs.resolveFile(destination, { root: canonical, what: "Overlay destination" })
    if (existing === undefined) {
      const entry = await Fs.lstat(destination).catch((cause: unknown) => {
        if (SafeFs.errorCode(cause) === "ENOENT") return undefined
        throw cause
      })
      if (entry?.isSymbolicLink()) throw new Error(`Overlay destination is a dangling symbolic link: ${destination}`)
    }

    await Fs.mkdir(parent, { recursive: true })
    // Copy to a fresh entry and rename over the destination. copyFile directly
    // to an admitted internal link would still overwrite its target's bytes.
    const staging = await Fs.mkdtemp(NodePath.join(parent, ".smthrs-overlay-"))
    try {
      const staged = NodePath.join(staging, "replacement")
      await Fs.copyFile(admitted.path, staged, constants.COPYFILE_EXCL)
      await Fs.rename(staged, destination)
    } finally {
      await Fs.rm(staging, { recursive: true, force: true })
    }
  }
}
