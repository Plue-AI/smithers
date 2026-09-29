/**
 * Archiving: what happens to a unit's old sources once it verifies, and the
 * deterministic rewrites that run in the same step.
 *
 * A unit's sources fall into two kinds and they get opposite treatment.
 *
 * A source the migration *replaced* — a `.jsx` workflow whose content now
 * lives in `flows/<name>/flow.ts`, a `preload.js` the 1.0 runtime has no use
 * for — moves to `<reportDir>/archive/<original path>`. Deleting it would throw
 * away the only readable record of what the migration was working from; leaving
 * it in place would keep JSX in the typecheck and in the registry's discovery
 * path, which is exactly the "compatibility library" outcome the product rule
 * forbids. Moving it is the only answer that is both auditable and final.
 * `keepOldSources` leaves them where they are for an operator who wants to diff
 * by hand, and the report says so.
 *
 * A source the migration *edits* — `package.json`, a `tsconfig`, `.gitignore` —
 * is never archived. Archiving those would delete the project's manifest and
 * its TypeScript configuration, which is what this module did before the file
 * kinds were told apart. They are rewritten in place instead, by the pure
 * functions below: a dependency edit is deterministic, so no model decides it.
 * The rewrites are a backstop rather than the whole job — the agent is asked to
 * rewrite manifests too — and {@link module:MigrateFlow.postconditions} is what
 * checks the result.
 *
 * @since 1.0.0-rc.0
 */

import { Action } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Detect from "../Detect.ts"
import * as CliScripts from "../internal/CliScripts.ts"
import * as Fs from "../internal/Fs.ts"
import * as Jsonc from "../internal/Jsonc.ts"
import * as Versions from "../internal/Versions.ts"
import { io, make, MigrateError } from "../MigrateError.ts"
import * as Report from "../Report.ts"
import * as Units from "../Units.ts"

/**
 * The Effect version every migrated project ends on. One pin, repository wide.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const effectVersion = Versions.effectVersion

/**
 * The version every `@smthrs/*` package a migrated project depends on ends on.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const smithersVersion = Versions.smithersVersion

/**
 * What a manifest rewrite removes and adds.
 *
 * Both lists come from the scan: `remove` is what the manifests actually
 * declared, `add` is what the migrated sources actually import. Neither is
 * guessed here.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ManifestRewrite {
  readonly remove: ReadonlyArray<string>
  readonly add: ReadonlyArray<string>
  readonly flowsDir?: string | undefined
}

/**
 * Every manifest field a dependency can be declared or pinned in. The rewrite
 * clears 0.x names from all six, and the project postcondition checks the
 * same six, because a name that survives in `overrides` or `resolutions`
 * still pins a package the migrated project no longer declares.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions"
] as const

const sorted = (record: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))

/**
 * The version a package name is pinned to in a migrated project, or
 * `undefined` when this package has no pin for it.
 *
 * A name with no pin is refused rather than written as `"*"`. A floating
 * specifier is never a correct pin, and for the `effect` family it is at odds
 * with the release policy's single-version invariant.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const pinFor = (name: string): string | undefined =>
  name === "effect" || name.startsWith("@effect/")
    ? effectVersion
    : name.startsWith("@smthrs/")
    ? smithersVersion
    : undefined

/**
 * What one script line became, and why.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ScriptRewrite {
  readonly name: string
  readonly before: string
  readonly after: string
  readonly unsupported?: string | undefined
}

/**
 * Rewrites the old CLI invocations in a script map.
 *
 * `smithers up <file>` and `smithers workflow run <file>` become
 * `smthrs flow start <flow>`, with explicit input and detach flag translation.
 * A command that cannot be safely mapped is left exactly as it is and reported: silently deleting a
 * script an operator depends on would be worse than leaving one that fails
 * loudly.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const rewriteScripts = (
  scripts: Readonly<Record<string, string>>
): ReadonlyArray<ScriptRewrite> =>
  Object.entries(scripts).map(([name, before]) => ({ name, before, ...CliScripts.rewrite(before, Units.flowName) }))

/**
 * Rewrites a `package.json`: old packages out, the 1.0 packages in, the old
 * CLI invocations rewritten, and every dependency map left sorted so two runs
 * produce the same bytes.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const rewriteManifest = (
  text: string,
  rewrite: ManifestRewrite
): { readonly text: string; readonly scripts: ReadonlyArray<ScriptRewrite> } => {
  const manifest = JSON.parse(text) as Record<string, unknown>
  const removed = new Set(rewrite.remove)
  for (const field of dependencyFields) {
    const map = manifest[field]
    if (typeof map !== "object" || map === null) continue
    const kept = Object.fromEntries(
      Object.entries(map as Record<string, string>).filter(([name]) => !removed.has(name))
    )
    if (Object.keys(kept).length === 0) delete manifest[field]
    else manifest[field] = sorted(kept)
  }
  if (rewrite.add.length > 0) {
    const dependencies = { ...(manifest.dependencies as Record<string, string> | undefined) }
    // A name this package has no pin for is not added. Writing `"*"` would put
    // a floating specifier in a project manifest the migration claims to have
    // pinned.
    let added = false
    for (const name of rewrite.add) {
      const pin = pinFor(name)
      if (pin === undefined) continue
      dependencies[name] = pin
      added = true
    }
    if (added) manifest.dependencies = sorted(dependencies)
  }
  const scripts = typeof manifest.scripts === "object" && manifest.scripts !== null
    ? rewriteScripts(manifest.scripts as Record<string, string>)
    : []
  if (scripts.length > 0) {
    manifest.scripts = Object.fromEntries(scripts.map((entry) => [entry.name, entry.after]))
  }
  return { text: `${JSON.stringify(manifest, null, 2)}\n`, scripts }
}

/**
 * A tsconfig's text with its comments removed, so `JSON.parse` can read it.
 *
 * A `tsconfig.json` is JSON with comments by convention and by TypeScript's own
 * parser, and every reader of one in this package needs the same stripping.
 *
 * Scanned rather than matched, because a tsconfig is full of text that looks
 * like a comment and is not: `"include": ["**\/*.ts", "**\/*.tsx"]` carries two
 * `/*` sequences and one `*\/` between them, so a regular expression that
 * treats them as a block comment deletes the middle of the include list and
 * leaves valid JSON that names the wrong files. Trailing commas go the same
 * way. The scanner lives in `internal/Jsonc.ts` so the detector, this module,
 * and the postconditions all read a tsconfig the same way; `Detect` cannot
 * import this module, because this module imports `Detect`.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const withoutComments = Jsonc.withoutComments

const stripComments = withoutComments

/**
 * Reports whether a tsconfig `paths` key maps a 0.x specifier.
 *
 * The one predicate both halves of the decision use: {@link rewriteTsconfig}
 * removes exactly the keys this returns true for, and
 * {@link module:MigrateFlow.postconditions} refuses a project unit for exactly
 * the keys this returns true for. Written twice, the two spellings drift —
 * three literal prefixes in the rewrite against `Detect.isOldSpecifier` in the
 * postcondition meant a bare `smithers` key in a project inside the old
 * monorepo survived the rewrite and then deterministically failed the unit's
 * own check, after the archive had already run.
 *
 * A key is a specifier with a trailing wildcard, so the wildcard comes off and
 * the rest is judged the way an import is judged: by name where the name only
 * exists in the old tree, and by what the manifests said where it exists in
 * both.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const isOldPathsKey = (key: string, specifiers: Detect.SpecifierContext = {}): boolean =>
  Detect.isOldSpecifier(key.replace(/\*+$/, ""), specifiers)

/**
 * Reports whether a JSX import source identifies a retired Smithers runtime.
 * Uses the same manifest evidence as legacy imports; JSX mode alone does not
 * identify a runtime.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const isOldJsxImportSource = (source: unknown, specifiers: Detect.SpecifierContext = {}): boolean =>
  typeof source === "string" && Detect.isOldSpecifier(source, specifiers)

/**
 * Removes retired Smithers JSX settings and old path mappings from a tsconfig.
 * Unrelated JSX settings are preserved, including a mode without an explicit
 * import source, because retained UI may still need them.
 *
 * Which mappings are old is {@link isOldPathsKey}'s answer, and the unit's own
 * scan is what it is answered from: `smithers` is the old facade where a
 * manifest declares it and an ordinary name everywhere else.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const rewriteTsconfig = (text: string, specifiers: Detect.SpecifierContext = {}): string => {
  const config = JSON.parse(stripComments(text)) as Record<string, unknown>
  const before = JSON.stringify(config)
  const options = config.compilerOptions
  if (typeof options === "object" && options !== null) {
    const compiler = options as Record<string, unknown>
    if (isOldJsxImportSource(compiler.jsxImportSource, specifiers)) {
      delete compiler.jsx
      delete compiler.jsxImportSource
    }
    const paths = compiler.paths
    if (typeof paths === "object" && paths !== null) {
      const kept = Object.fromEntries(
        Object.entries(paths as Record<string, unknown>).filter(([key]) => !isOldPathsKey(key, specifiers))
      )
      if (Object.keys(kept).length !== Object.keys(paths).length) {
        if (Object.keys(kept).length === 0) delete compiler.paths
        else compiler.paths = kept
      }
    }
  }
  return JSON.stringify(config) === before ? text : `${JSON.stringify(config, null, 2)}\n`
}

/**
 * Adds the 1.0 runtime state directory to a `.gitignore`, once.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const rewriteGitignore = (text: string, flowsState = ".flows/"): string => {
  const lines = text.split("\n")
  if (lines.some((line) => line.trim() === flowsState || line.trim() === flowsState.replace(/\/$/, ""))) return text
  const body = text.endsWith("\n") || text === "" ? text : `${text}\n`
  return `${body}${flowsState}\n`
}

/**
 * Which project sources are rewritten in place instead of archived.
 *
 * Manifests, TypeScript configurations, and ignore files get deterministic
 * rewrites here. Documentation and command scripts detected by `Detect` are
 * rewritten by the transform and must keep that content in the project.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const isRewritable = (file: string): boolean => {
  const name = file.split("/").pop() ?? file
  return name === "package.json" || name === ".gitignore" || /^tsconfig(\..+)?\.json$/.test(name) ||
    file.endsWith(".md") ||
    file.endsWith(".sh") ||
    file.endsWith("Makefile") ||
    file.endsWith("Justfile") ||
    file.endsWith("justfile") ||
    file.endsWith("Procfile") ||
    file.endsWith("bunfig.toml") ||
    /^\.github\/workflows\/.+\.ya?ml$/.test(file) ||
    /(^|\/)docker-compose[^/]*\.ya?ml$/.test(file)
}

/**
 * One script the migration could not rewrite, and why.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const UnsupportedScript = Schema.Struct({
  script: Schema.String,
  file: Schema.String,
  reason: Schema.String
})

/**
 * What one archive step did: every file it moved or rewrote, and every script
 * line it had to leave alone.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const Result = Schema.Struct({
  changed: Schema.Array(Report.ChangedFile),
  unsupportedScripts: Schema.Array(UnsupportedScript)
})

/**
 * What one archive step did.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Result = typeof Result.Type

/**
 * The archive step: rewrite what a 1.0 project keeps, move the rest aside.
 *
 * @category actions
 * @since 1.0.0-rc.0
 */
export const action = Action.make("smithers/migrate-v1/Archive", {
  payload: {
    root: Schema.String,
    unit: Schema.String,
    kind: Schema.Literals(["dependencies", "workflow", "integration", "project"]),
    sources: Schema.Array(Schema.String),
    /** What the unit wrote. A target is never archived, whatever else it is. */
    targets: Schema.Array(Schema.String),
    archiveDir: Schema.String,
    keepOldSources: Schema.Boolean,
    /** Every project-relative path holding 0.x run state. Nothing here is ever moved. */
    runStatePaths: Schema.optional(Schema.Array(Schema.String)),
    /** What the manifests said about the names that exist in both trees. */
    specifiers: Schema.optional(Schema.Struct({
      localFacade: Schema.optional(Schema.Boolean),
      oldScoped: Schema.optional(Schema.Array(Schema.String))
    }))
  },
  success: Result,
  error: MigrateError,
  tier: "irreversible"
})

/**
 * Pins `effect` to the version this release ships, wherever the manifest
 * already declares it.
 *
 * In place rather than through {@link rewriteManifest}'s `add`, which would put
 * the name in `dependencies` and leave the copy in `devDependencies` behind.
 */
const pinEffect = (text: string): string => {
  const manifest = JSON.parse(text) as Record<string, unknown>
  let moved = false
  for (const field of dependencyFields) {
    const map = manifest[field]
    if (typeof map !== "object" || map === null) continue
    const record = map as Record<string, string>
    if (record["effect"] === undefined || record["effect"] === effectVersion) continue
    record["effect"] = effectVersion
    moved = true
  }
  return moved ? `${JSON.stringify(manifest, null, 2)}\n` : text
}

/** Every dependency name in a manifest that names a 0.x package. */
const oldNames = (manifest: Record<string, unknown>): ReadonlyArray<string> => {
  const found = new Set<string>()
  for (const field of dependencyFields) {
    const map = manifest[field]
    if (typeof map !== "object" || map === null) continue
    for (const [name, version] of Object.entries(map as Record<string, string>)) {
      if (Detect.classifyPackage(name, typeof version === "string" ? version : "") !== undefined) found.add(name)
    }
  }
  return [...found].sort()
}

/**
 * Applies the deterministic rewrite one kept file gets, or returns `undefined`
 * when the file is not one this module rewrites.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const rewritten = (
  file: string,
  text: string,
  specifiers: Detect.SpecifierContext = {},
  kind: "dependencies" | "project" = "project"
): { readonly text: string; readonly scripts: ReadonlyArray<ScriptRewrite> } | undefined => {
  const name = file.split("/").pop() ?? file
  if (name === "package.json") {
    // Later source units still typecheck against 0.x imports, so the first unit
    // may pin and add packages but must leave removals and CLI rewrites to the
    // final project unit.
    if (kind === "dependencies") return { text: pinEffect(text), scripts: [] }
    const manifest = JSON.parse(text) as Record<string, unknown>
    const rewrite = rewriteManifest(text, { remove: oldNames(manifest), add: [] })
    return { text: pinEffect(rewrite.text), scripts: rewrite.scripts }
  }
  if (/^tsconfig(\..+)?\.json$/.test(name)) return { text: rewriteTsconfig(text, specifiers), scripts: [] }
  if (name === ".gitignore") return { text: rewriteGitignore(text), scripts: [] }
  return undefined
}

const under = (file: string, root: string): boolean => file === root || file.startsWith(`${root}/`)

/**
 * Rewrites what the project keeps and archives what it does not.
 *
 * Two phases, in this order: every archive copy is written first, and only
 * then is any source removed. A failure in the first phase has moved nothing,
 * and a failure in the second leaves the copies beside the sources rather than
 * a file that exists in neither place. The caller runs this inside the
 * checkpoint's restoring scope, and that scope reads the tree at the moment it
 * fails, so either failure — and any failure after this step returns — puts
 * every source back and takes its archive copy with it.
 *
 * @category execution
 * @since 1.0.0-rc.0
 */
export const run = (payload: {
  readonly root: string
  readonly unit: string
  readonly kind: "dependencies" | "workflow" | "integration" | "project"
  readonly sources: ReadonlyArray<string>
  readonly targets: ReadonlyArray<string>
  readonly archiveDir: string
  readonly keepOldSources: boolean
  readonly runStatePaths?: ReadonlyArray<string> | undefined
  readonly specifiers?:
    | { readonly localFacade?: boolean | undefined; readonly oldScoped?: ReadonlyArray<string> | undefined }
    | undefined
}): Effect.Effect<Result, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sources = [...payload.sources].sort()
    // Tool code gets the same rule the agent gets. An archive that can reach a
    // run-state path is an archive that can move a database, and the deterministic
    // checks run before this step, so nothing downstream would see it.
    for (const file of sources) {
      for (const guarded of payload.runStatePaths ?? []) {
        if (under(file, guarded)) {
          return yield* Effect.fail(make(
            "run-state-blocked",
            `the archive refused to move "${file}", which is 0.x run state`,
            `unit: ${payload.unit}\nrun-state path: ${guarded}`
          ))
        }
      }
    }

    const changed: Array<Report.ChangedFile> = []
    const unsupportedScripts: Array<typeof UnsupportedScript.Type> = []

    // The files a 1.0 project keeps: rewritten in place, never moved.
    const rewritable = payload.kind === "dependencies" || payload.kind === "project"
      ? sources.filter(isRewritable)
      : []
    for (const file of rewritable) {
      const target = path.join(payload.root, ...file.split("/"))
      // Absent is the one answer that means "nothing to rewrite"; every other
      // failure is this step failing, and the checkpoint's restoring scope is
      // what a failure here is for.
      const before = yield* Fs.readIfExists(target, file)
      if (before === undefined) continue
      const result = yield* Effect.try({
        try: () =>
          rewritten(
            file,
            before,
            payload.specifiers ?? {},
            payload.kind === "dependencies" ? "dependencies" : "project"
          ),
        catch: io(`could not rewrite ${file}`)
      })
      if (result === undefined) continue
      for (const script of result.scripts) {
        if (script.unsupported === undefined) continue
        unsupportedScripts.push({ script: script.name, file, reason: script.unsupported })
      }
      if (result.text === before) continue
      yield* fs.writeFileString(target, result.text).pipe(Effect.mapError(io(`could not rewrite ${file}`)))
      changed.push({ path: file, change: "modified", bytes: new TextEncoder().encode(result.text).length })
    }

    // A project with no ignore file gets one: `.flows/` is runtime state a
    // migrated project writes on its first run, and a repository that commits
    // it has committed a database. The file is a target of the project unit,
    // so writing it is inside the unit's own file set.
    if (payload.kind === "project" && payload.targets.includes(".gitignore")) {
      const target = path.join(payload.root, ".gitignore")
      if ((yield* Fs.readIfExists(target, ".gitignore")) === undefined) {
        const text = rewriteGitignore("")
        yield* fs.writeFileString(target, text).pipe(Effect.mapError(io("could not create .gitignore")))
        changed.push({ path: ".gitignore", change: "added", bytes: new TextEncoder().encode(text).length })
      }
    }

    if (payload.keepOldSources) return { changed, unsupportedScripts }

    // Only a unit whose sources were *replaced* archives anything. A
    // `dependencies` unit owns the manifests and an `integration` unit owns
    // application files that call a 0.x integration; both are rewritten where
    // they are, and moving them would delete the project's own code.
    const archives = payload.kind === "workflow" || payload.kind === "project"
    // Phase one: every copy is written before anything is removed.
    const archivable = archives
      ? sources.filter((file) => !rewritable.includes(file) && !payload.targets.includes(file))
      : []
    const copied: Array<{ readonly file: string; readonly bytes: number }> = []
    for (const file of archivable) {
      const source = path.join(payload.root, ...file.split("/"))
      // Archiving reads the source and then removes it. Through a link that
      // copies a file from outside the project into the archive, so a linked
      // source, or one under a linked directory, is refused.
      const link = yield* Fs.linkOnPath(payload.root, file)
      if (link !== undefined) {
        return yield* Effect.fail(
          make(
            "invalid-layout",
            link === file
              ? `${file} is a symbolic link and will not be archived through it`
              : `${file} is reached through the symbolic link "${link}" and will not be archived through it`
          )
        )
      }
      const info = yield* Fs.optionalNotFound(fs.stat(source)).pipe(
        Effect.mapError(io(`could not inspect ${file} to archive it`))
      )
      const bytes = yield* Fs.optionalNotFound(fs.readFile(source)).pipe(
        Effect.mapError(io(`could not read ${file} to archive it`))
      )
      if (bytes._tag === "None") continue
      const target = path.join(payload.archiveDir, ...file.split("/"))
      yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
        Effect.mapError(io(`could not create ${path.dirname(target)}`))
      )
      yield* fs.writeFile(target, bytes.value).pipe(Effect.mapError(io(`could not archive ${file}`)))
      // The copy is the record of the file as it was, permissions included:
      // an executable source reads back as one from the archive.
      if (info._tag === "Some") {
        yield* fs.chmod(target, info.value.mode & 0o777).pipe(
          Effect.mapError(io(`could not keep the mode of ${file} in its archive copy`))
        )
      }
      copied.push({ file, bytes: bytes.value.length })
    }
    // Phase two: now that every copy exists, the originals go.
    for (const entry of copied) {
      yield* fs.remove(path.join(payload.root, ...entry.file.split("/"))).pipe(
        Effect.mapError(io(`could not remove ${entry.file} after archiving it`))
      )
      changed.push({ path: entry.file, change: "archived", bytes: entry.bytes })
    }
    return { changed, unsupportedScripts }
  })

/**
 * The archive action's implementation.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = action.toLayer(run)
