/**
 * Docker service, OCI build, bake, and outward push target declarations.
 *
 * `Docker.Serve`/`Docker.Service` run an image as a scoped,
 * readiness-gated service through the supervisor (`docker run --rm`, the
 * declared `init` commands as post-readiness `docker exec`), exactly the
 * way `Shell.Serve` supervises a host process. `Docker.Build` and
 * `Docker.Bake` are cached builds that capture an OCI archive directory
 * through the CAS. `Docker.Push` is an outward effect: uncached,
 * approval-gated, and run only with its declared secrets.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

const imageFields = {
  image: Schema.NonEmptyString,
  tag: Schema.optional(Schema.NonEmptyString)
} as const

/**
 * Attrs for `S.Docker.Serve` and `S.Docker.Service`.
 *
 * @category attrs
 * @since 0.1.0
 */
export const ServeAttrs = Schema.Struct({
  ...imageFields,
  env: Schema.optional(Attr.Env),
  ports: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  volumes: Schema.optional(Schema.Record(Schema.String, Schema.NonEmptyString)),
  readiness: Schema.optional(Attr.Readiness),
  health: Schema.optional(Attr.Health),
  stop: Schema.optional(Attr.Stop),
  init: Schema.optional(Schema.Array(Schema.NonEmptyArray(Schema.NonEmptyString))),
  command: Schema.optional(Schema.NonEmptyArray(Schema.NonEmptyString)),
  sandbox: Schema.optional(Attr.Sandbox)
})

/**
 * Attrs for a Dockerfile build.
 *
 * @category attrs
 * @since 0.1.0
 */
export const BuildAttrs = Schema.Struct({
  dockerfile: Input.File,
  context: Schema.NonEmptyString,
  platforms: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  buildArgs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  data: Schema.optional(Attr.Data),
  sandbox: Schema.optional(Attr.Sandbox)
})

/**
 * Attrs for a buildx bake target.
 *
 * @category attrs
 * @since 0.1.0
 */
export const BakeAttrs = Schema.Struct({
  config: Input.File,
  target: Schema.NonEmptyString,
  data: Schema.optional(Attr.Data),
  sandbox: Schema.optional(Attr.Sandbox)
})

/**
 * Attrs for an outward image push.
 *
 * @category attrs
 * @since 0.1.0
 */
export const PushAttrs = Schema.Struct({
  image: Target.Target,
  registry: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  tags: Schema.NonEmptyArray(Schema.Unknown),
  gates: Schema.optional(Attr.Gates),
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Attr.Approval
})

const serveDefinition = Target.make("Docker.Serve", {
  attrs: ServeAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Docker.Serve")
})

const serviceDefinition = Target.make("Docker.Service", {
  attrs: ServeAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Docker.Service")
})

/**
 * The declared output path one docker image build writes to.
 *
 * A constant path collides the moment one package declares two image builds,
 * and a lossy slug collides for `a/b` and `a?b` alike. The readable slug is
 * kept for a legible tree and a digest of the label settles the name, so two
 * declarations that differ in any labelled part name two outputs.
 *
 * The label is the ordered parts of the declaration rather than one joined
 * string, digested through `JSON.stringify`, so no separator can be forged: a
 * dockerfile named `a` under context `b/c` and one named `a/b` under context
 * `c` are two labels, not one. Joining them with a separator character would
 * either be forgeable, when the separator can appear in a path, or would put
 * an unprintable byte in this source file and make it unreadable to `git
 * diff` and to every plain-text search.
 *
 * `@smthrs/build-cli` still derives its own output directory for these two
 * rules, so the path the executor writes is not yet this one. Until that
 * import lands, this is the declared path the planner reads in the old executor and
 * the two disagree in the build system.
 *
 * @category accessors
 * @since 0.1.0
 */
export const imageOutputPath = (name: string, label: ReadonlyArray<unknown>): string => {
  const slug = name
    .replaceAll(/[^A-Za-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64)
  const digest = createHash("sha256").update(JSON.stringify(label), "utf8").digest("hex").slice(0, 12)
  return slug === "" ? `docker-image-${digest}` : `docker-image-${slug}-${digest}`
}

/**
 * Renders a build-arg table as ordered pairs.
 *
 * `JSON.stringify` preserves insertion order, so the same table written with
 * its keys in two orders would otherwise digest to two different names for one
 * build. Sorting by key makes the label a function of the table's contents.
 * The values are `Schema.Unknown`, and a stamp is an object, so each value is
 * carried through as it is rather than coerced to a string.
 */
const orderedBuildArgs = (
  buildArgs: Readonly<Record<string, unknown>> | undefined
): ReadonlyArray<readonly [string, unknown]> | null =>
  buildArgs === undefined
    ? null
    : Object.entries(buildArgs).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)

const buildDefinition = Target.make("Docker.Build", {
  attrs: BuildAttrs,
  kinds: ["build"],
  cache: true,
  // Everything a Dockerfile build reads that is plain declaration data is in
  // the label. Two builds over one dockerfile and one context that differ
  // only in their platforms or their build args are two images and must not
  // share an output tree. `data` and `sandbox` are deliberately absent: a
  // target has no declaration-time identity to digest, so a build that varies
  // only by a `data` edge still shares this path.
  outputs: (attrs) => ({
    cwd: ".",
    paths: [
      imageOutputPath(attrs.context, [
        "Docker.Build",
        attrs.dockerfile.path,
        attrs.context,
        attrs.platforms === undefined ? null : [...attrs.platforms],
        orderedBuildArgs(attrs.buildArgs)
      ])
    ]
  }),
  implementation: () => Target.notImplemented("Docker.Build")
})

const bakeDefinition = Target.make("Docker.Bake", {
  attrs: BakeAttrs,
  kinds: ["build"],
  cache: true,
  outputs: (attrs) => ({
    cwd: ".",
    paths: [imageOutputPath(attrs.target, ["Docker.Bake", attrs.config.path, attrs.target])]
  }),
  implementation: () => Target.notImplemented("Docker.Bake")
})

const pushDefinition = Target.make("Docker.Push", {
  attrs: PushAttrs,
  kinds: ["run"],
  cache: false,
  implementation: () => Target.notImplemented("Docker.Push")
})

/**
 * Runs an image as a scoped service.
 *
 * @category targets
 * @since 0.1.0
 */
export const Serve = serveDefinition

/**
 * Alias-shaped Docker service constructor used by viem.
 *
 * @category targets
 * @since 0.1.0
 */
export const Service = serviceDefinition

/**
 * Builds a Dockerfile into a captured OCI archive directory.
 *
 * @category targets
 * @since 0.1.0
 */
export const Build = buildDefinition

/**
 * Builds one declared buildx bake target into a captured OCI archive directory.
 *
 * @category targets
 * @since 0.1.0
 */
export const Bake = bakeDefinition

/**
 * Declares an approval-gated, uncached image push.
 *
 * @category targets
 * @since 0.1.0
 */
export const Push = pushDefinition
