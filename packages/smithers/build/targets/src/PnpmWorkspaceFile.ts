/**
 * Generated `pnpm-workspace.yaml`.
 *
 * The workspace definition decides which directories are packages, which makes
 * it part of the build definition. This target renders the file from attrs and
 * drift-checks the checked-in copy, so the PACKAGE.ts graph and the manager's
 * own discovery cannot disagree about workspace membership.
 *
 * The target is pnpm-specific because the file is: npm, Bun, and Yarn read
 * workspace membership from the root manifest's `workspaces` field, which the
 * `PackageJson` declaration already generates. Declaring any other manager is
 * a construction error.
 *
 * `packages` entries are plain strings, not {@link Input.Glob} declarations.
 * The generated file depends on the pattern text, not on which directories
 * currently match it.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as GeneratedFile from "./GeneratedFile.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link PnpmWorkspace}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  packageManager: Schema.optional(PackageManager.PackageManager),
  /** The workspace package globs, in pnpm-workspace.yaml's own syntax. */
  packages: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
  /**
   * The `allowBuilds` map: which dependencies may run lifecycle scripts.
   *
   * Rendered sorted by key, so reordering a literal in PACKAGE.ts is not drift.
   *
   * @default {}
   */
  allowBuilds: Schema.Record(Schema.String, Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed<Record<string, boolean>>({}))
  ),
  /** The `linkWorkspacePackages` policy. @default true */
  linkWorkspacePackages: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(true))
  ),
  /**
   * Additional pnpm settings rendered verbatim after the link policy, as
   * `name: value` lines. Values are booleans or strings: the two shapes the
   * settings a workspace file carries take. `verifyDepsBeforeRun` belongs
   * here, for example, because pnpm reads settings from this file alone.
   *
   * @default {}
   */
  settings: Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.String])).pipe(
    Schema.withConstructorDefault(Effect.succeed<Record<string, boolean | string>>({}))
  ),
  /** Whether to write the file or verify the checked-in copy. @default "check" */
  mode: Schema.Literals(["write", "check"]).pipe(
    Schema.withConstructorDefault(Effect.succeed("check" as const))
  ),
  /** Where the file is written, relative to `cwd`. @default "pnpm-workspace.yaml" */
  path: Schema.NonEmptyString.pipe(
    Schema.withConstructorDefault(Effect.succeed("pnpm-workspace.yaml"))
  ),
  /** The directory the path resolves against. @default the workspace root */
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link PnpmWorkspace}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/** A key YAML would read as a boolean or null rather than as a string. */
const yamlKeyword = /^(y|yes|n|no|on|off|true|false|null|~)$/i

/** A key YAML would read as a number rather than as a string. */
const numericLike = /^-?\d+(\.\d+)?$/

/** The alphabet a plain YAML mapping key needs nothing else for. */
const plainKey = /^[A-Za-z0-9_-]+$/

/**
 * Spells one mapping key the way the file needs it.
 *
 * Keys stay bare when YAML reads them as the string they are. Anything YAML
 * would mistype — `no` as a boolean, `1.0` as a number, a scope sigil as
 * syntax — is quoted, and double-quoted JSON spelling is valid YAML.
 */
const key = (value: string): string =>
  plainKey.test(value) && !yamlKeyword.test(value) && !numericLike.test(value)
    ? value
    : JSON.stringify(value)

/** Orders map keys by UTF-16 code unit, never by locale. */
const byCodeUnit = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/**
 * Renders the file contents for one declaration.
 *
 * The layout follows pnpm's own documentation: `packages`, then `allowBuilds`
 * when any are declared, then the link policy, with sections separated by one
 * blank line. Sequence entries are always quoted. The trailing newline is
 * deliberate: a file without one is a diff every editor offers to fix.
 *
 * @category constructors
 * @since 0.1.0
 */
export const render = (attrs: Attrs): string => {
  const lines = [
    "packages:",
    ...attrs.packages.map((entry) => `  - ${JSON.stringify(entry)}`)
  ]
  const allowBuilds = Object.keys(attrs.allowBuilds).sort(byCodeUnit)
  if (allowBuilds.length > 0) {
    lines.push("", "allowBuilds:")
    for (const name of allowBuilds) {
      lines.push(`  ${key(name)}: ${attrs.allowBuilds[name] === true}`)
    }
  }
  lines.push("", `linkWorkspacePackages: ${attrs.linkWorkspacePackages}`)
  for (const name of Object.keys(attrs.settings).sort(byCodeUnit)) {
    const value = attrs.settings[name]!
    lines.push(`${key(name)}: ${typeof value === "boolean" ? value : JSON.stringify(value)}`)
  }
  return `${lines.join("\n")}\n`
}

const definition = Target.make("PnpmWorkspace", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager"],
  kinds: ["build", "lint"],
  error: Schema.Union([GeneratedFile.WriteFileError, GeneratedFile.DriftError]),
  cache: false,
  outputs: (attrs) => attrs.mode === "write" ? { cwd: attrs.cwd, paths: [attrs.path] } : { cwd: attrs.cwd, paths: [] },
  // The lint form verifies the checked-in file; only the build form writes.
  attrsForKind: (kind, attrs) => kind === "lint" ? { ...attrs, mode: "check" as const } : attrs,
  implementation: (attrs) =>
    GeneratedFile.generateFile(attrs.mode, {
      path: attrs.cwd === "." ? attrs.path : `${attrs.cwd}/${attrs.path}`,
      contents: render(attrs)
    })
})

/**
 * Generates and drift-checks `pnpm-workspace.yaml`.
 *
 * Only pnpm reads this file, so the declaration refuses any other manager:
 * rendering a file the declared manager never reads would be a target that
 * reports success while producing nothing the workspace uses. The manager
 * itself comes from the workspace declaration, so a PACKAGE.ts writes none.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const workspaceFile = Smithers.PnpmWorkspace({
 *   packages: ["packages/*", "apps/*"],
 *   allowBuilds: { esbuild: false }
 * })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const PnpmWorkspace = Object.assign(
  (attrs: Parameters<typeof definition>[0]) => {
    const manager = (attrs as { readonly packageManager?: unknown }).packageManager
    // An omitted manager is the workspace's, resolved when the graph is
    // planned; the executor refuses there if the workspace declares something
    // other than pnpm. A declaration that names one here is checked now.
    if (manager !== undefined && (!PackageManager.isPackageManager(manager) || manager.name !== "pnpm")) {
      const declared = PackageManager.isPackageManager(manager) ? manager.name : "an undeclared manager"
      throw new Error(`PnpmWorkspace requires the pnpm declaration; this workspace declares ${declared}`)
    }
    return definition(attrs)
  },
  definition
)
