/**
 * Deterministic detection of everything a Smithers 0.x project binds to:
 * packages, lockfiles, imports, JSX pragmas, tsconfig chains, workflow and
 * prompt files, shared components, workflow UIs, tests, libraries, CLI
 * invocations in scripts, project configuration, and integrations.
 *
 * The detector reads. It never writes, never installs, and never evaluates
 * project code. Every rule here is a test case over the fixtures in
 * `test/fixtures`.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as ts from "typescript/unstable/ast"
import * as Constructs from "./Constructs.ts"
import * as Fs from "./internal/Fs.ts"
import * as Jsonc from "./internal/Jsonc.ts"
import * as Semver from "./internal/Semver.ts"
import * as Sort from "./internal/Sort.ts"
import * as Ts from "./internal/Ts.ts"
import { isTsconfig } from "./internal/Tsconfig.ts"
import * as Versions from "./internal/Versions.ts"
import type { MigrateError } from "./MigrateError.ts"

/**
 * Old package names that identify a 0.x project whatever their version.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const oldPackageNames: ReadonlyArray<string> = ["smthrs", "smithers-orchestrator"]

/**
 * The bare name a project inside the old monorepo depends on.
 *
 * `smithers` is not a Smithers package on the registry, so the name alone
 * proves nothing. A `file:` or `link:` spec pointing at a 0.x checkout does,
 * and so does a 0.x version. Plue's `.smithers/workflows/batch-issues` package
 * declares `"smithers": "file:../../../../smithers"` and imports
 * `createSmithers` from it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const localPackageName = "smithers"

/**
 * Scopes whose every package is 0.x.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const oldScopes: ReadonlyArray<string> = ["@smithers/", "@smithers-orchestrator/"]

/**
 * `@smthrs/<name>` packages that exist only in the 0.x tree. A dependency on
 * one of these is an old package however it is pinned: the name has no 1.0
 * release for a specifier to point at.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const deletedSmthrsPackages: ReadonlyArray<string> = [
  "accounts",
  "agents",
  "aws",
  "cloudflare",
  "components",
  "control-plane",
  "daytona",
  "db",
  "devtools",
  "driver",
  "errors",
  "gateway-client",
  "gateway-react",
  "gateway-ui",
  "gcp",
  "graph",
  "herdr",
  "integrations",
  "microsandbox",
  "openapi",
  "pi-plugin",
  "protocol",
  "react-reconciler",
  "review",
  "scheduler",
  "server",
  "telegram",
  "tool-context",
  "tui",
  "usage",
  "vcs",
  "vercel",
  "xstate"
]

/**
 * Packages recorded alongside the old ones because the dependency unit has to
 * decide what happens to them.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const companionPackages: ReadonlyArray<string> = [
  "@ai-sdk/",
  "@mdx-js/",
  "@types/mdx",
  "@types/react",
  "@types/react-dom",
  "ai",
  "effect",
  "react",
  "react-dom",
  "xstate",
  "zod"
]

/**
 * The foreign authoring APIs the detector recognizes by name. A workflow file
 * written against one of these is not a Smithers 0.x workflow, and the tool
 * refuses to guess at its semantics.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const foreignAuthoringApis: ReadonlyArray<string> = ["@smithers-ai/workflow"]

const manifestFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions"
] as const

/**
 * The manifest field a dependency was found in.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ManifestField = (typeof manifestFields)[number]

/**
 * Why a dependency counts as a Smithers 0.x package.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type OldPackageReason = "old-name" | "old-scope" | "deleted-package" | "old-version"

/**
 * One old package in one manifest.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface OldPackage {
  readonly name: string
  readonly version: string
  readonly field: ManifestField
  readonly reason: OldPackageReason
}

/**
 * One companion package the dependency unit has to decide about.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface CompanionPackage {
  readonly name: string
  readonly version: string
  readonly field: ManifestField
}

/**
 * One `package.json` the detector read.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ManifestFinding {
  readonly path: string
  readonly kind: "root" | "workspace-member" | "smithers" | "workflow-adjacent"
  readonly name: string | undefined
  readonly packageManager: string | undefined
  readonly workspaces: ReadonlyArray<string>
  readonly oldPackages: ReadonlyArray<OldPackage>
  readonly companions: ReadonlyArray<CompanionPackage>
  readonly scripts: ReadonlyArray<{ readonly name: string; readonly command: string }>
}

/**
 * One `tsconfig.json` in an `extends` chain, with only the settings the
 * migration has to remove.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface TsconfigFinding {
  readonly path: string
  readonly extends: string | undefined
  readonly jsx: string | undefined
  readonly jsxImportSource: string | undefined
  readonly paths: ReadonlyArray<string>
  readonly types: ReadonlyArray<string>
  readonly include: ReadonlyArray<string>
}

/**
 * A hit at a file position.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface FileHit {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly text: string
}

/**
 * One import of an old specifier.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ImportHit {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly specifier: string
  /** Local name to exported name. */
  readonly names: ReadonlyArray<{ readonly local: string; readonly imported: string }>
  readonly namespace: string | undefined
  readonly kind: "old" | "foreign" | "mdx" | "relative"
  /**
   * Whether the whole declaration is `import type`. A type-only import still
   * has to be rewritten, but it binds no value, so the catalog does not have to
   * hold its name.
   */
  readonly typeOnly: boolean
}

/**
 * The authoring API a workflow file is written against.
 *
 * `flows` is a file that already imports Smithers 1.0. It is not a thing to
 * migrate, and naming it is what makes the tool safe to run twice: a second
 * run over its own output has to recognize that output, not plan to rewrite
 * it into a second copy under a name derived from `flow.ts`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type WorkflowApi = "smthrs" | "smithers-orchestrator" | "foreign" | "flows" | "unknown"

/**
 * One workflow file.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface WorkflowFile {
  readonly path: string
  readonly kind: "jsx" | "tsx" | "ts" | "js" | "mdx"
  readonly api: WorkflowApi
  /** `smithers-*` header comments, by header name without the prefix. */
  readonly headers: ReadonlyMap<string, string>
  /** Relative specifiers this file imports, resolved to project paths. */
  readonly localImports: ReadonlyArray<string>
}

/**
 * One MDX prompt.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface PromptFile {
  readonly path: string
  readonly classification: "interpolation-only" | "jsx"
  /** The `props.<name>` identifiers the prompt interpolates. */
  readonly props: ReadonlyArray<string>
}

/**
 * One workflow UI file, and the `<UI entry>` that names it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface UiFile {
  /** The resolved project path, or the unresolved specifier when missing. */
  readonly path: string
  readonly resolved: boolean
  readonly referencedBy: ReadonlyArray<string>
}

/**
 * One old CLI invocation or Smithers environment variable in a script.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ScriptHit {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly text: string
  readonly kind: "package-runner" | "cli-verb" | "cli-entry" | "mcp" | "environment"
}

/**
 * The project configuration files a 0.x project carries.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ConfigFindings {
  readonly smithersConfig:
    | {
      readonly path: string
      readonly backend: string | undefined
      readonly repoCommands: ReadonlyMap<string, string>
    }
    | undefined
  readonly agents: ReadonlyArray<string>
  readonly preload: ReadonlyArray<{ readonly path: string; readonly mdxPlugin: boolean }>
  readonly bunfig: ReadonlyArray<{ readonly path: string; readonly preload: ReadonlyArray<string> }>
  readonly gateway: ReadonlyArray<string>
  readonly toon: ReadonlyArray<string>
  readonly listeners: ReadonlyArray<string>
  readonly packs: ReadonlyArray<string>
  readonly assetTypes: ReadonlyArray<string>
  readonly gitignore: ReadonlyArray<string>
  readonly skills: ReadonlyArray<string>
  readonly evals: ReadonlyArray<string>
}

/**
 * One integration seam: an import of an integration subpath, or an environment
 * name in a deployment manifest.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface IntegrationHit {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly integration: string
  readonly kind: "import" | "call" | "environment"
}

/**
 * A non-fatal detection diagnostic.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Warning {
  readonly code:
    | "unknown-authoring-api"
    | "effect-pin-conflict"
    | "unresolved-ui-entry"
    | "unparsable-manifest"
    | "unparsable-tsconfig"
    | "uncatalogued-import"
    | "mixed-authoring-api"
    | "already-migrated"
    | "incomplete-scan"
  readonly file: string
  readonly message: string
}

/**
 * One place a manifest declares `effect`.
 *
 * Every declaration is kept, with its file and its field, because the frozen
 * contract wants exactly one version in every manifest and every lockfile,
 * and a warning that names the field is one an operator can act on.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface EffectDeclaration {
  readonly file: string
  readonly field: string
  readonly version: string
}

/**
 * Everything the detector found.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Detection {
  readonly root: string
  readonly files: ReadonlyArray<string>
  readonly manifests: ReadonlyArray<ManifestFinding>
  readonly lockfiles: ReadonlyArray<string>
  readonly packageManager: string | undefined
  readonly tsconfigs: ReadonlyArray<TsconfigFinding>
  readonly pragmas: ReadonlyArray<FileHit>
  readonly imports: ReadonlyArray<ImportHit>
  readonly workflowFiles: ReadonlyArray<WorkflowFile>
  readonly prompts: ReadonlyArray<PromptFile>
  readonly components: ReadonlyArray<string>
  readonly uis: ReadonlyArray<UiFile>
  readonly tests: ReadonlyArray<string>
  readonly libs: ReadonlyArray<string>
  readonly scripts: ReadonlyArray<ScriptHit>
  readonly config: ConfigFindings
  readonly integrations: ReadonlyArray<IntegrationHit>
  readonly effectPin: string | undefined
  /** Every `effect` declaration in every manifest, in manifest order. */
  readonly effectDeclarations: ReadonlyArray<EffectDeclaration>
  readonly globalState: ReadonlyArray<string>
  readonly warnings: ReadonlyArray<Warning>
  /** File contents, by project-relative path, for every file a scanner reads. */
  readonly sources: ReadonlyMap<string, string>
}

/**
 * Options for {@link scan}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ScanOptions {
  readonly ignore?: ReadonlyArray<string> | undefined
  /** The environment the global-state paths are read from. Defaults to none. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
}

const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"]

const isSource = (file: string): boolean => sourceExtensions.some((extension) => file.endsWith(extension))

/**
 * Context an import needs before its specifier can be judged.
 *
 * Two of the rules are project specific and design section 3.2 gates both on
 * section 3.1's manifest reading. The bare name `smithers` is the old facade
 * only where a manifest says so. An `@smthrs/<name>` package that exists in
 * both trees is old only where a manifest pins it below `1.0.0`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface SpecifierContext {
  /** True when a manifest declares the bare name `smithers` as the old facade. */
  readonly localFacade?: boolean | undefined
  /** The `@smthrs/<name>` names the manifests reported as 0.x, without the scope. */
  readonly oldScoped?: ReadonlyArray<string> | undefined
}

/**
 * Reports whether an import specifier names a Smithers 0.x module.
 *
 * A name that only exists in the old tree is decided by name. A name that
 * exists in both trees is decided by what the manifests said about it, which is
 * why {@link SpecifierContext} is a parameter rather than a constant: a
 * project on `@smthrs/engine@1.0.0-rc.0` imports the new engine and a project
 * on `@smthrs/engine@0.35.0` imports the old one, and the two specifiers are
 * the same string.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const isOldSpecifier = (specifier: string, context: SpecifierContext = {}): boolean => {
  if (oldPackageNames.includes(specifier)) return true
  if (oldPackageNames.some((name) => specifier.startsWith(`${name}/`))) return true
  // The bare name only counts when a manifest declares it as the old facade.
  if (
    context.localFacade === true &&
    (specifier === localPackageName || specifier.startsWith(`${localPackageName}/`))
  ) {
    return true
  }
  if (oldScopes.some((scope) => specifier.startsWith(scope))) return true
  if (specifier.startsWith("@smthrs/")) {
    const name = specifier.slice("@smthrs/".length).split("/")[0] ?? ""
    return deletedSmthrsPackages.includes(name) || (context.oldScoped ?? []).includes(name)
  }
  return false
}

/**
 * Reports whether a dependency name and version is a Smithers 0.x package, and
 * why.
 *
 * A name that only exists in the old tree is decided by name. A name that
 * exists in both trees (`@smthrs/cli`, `engine`, `memory`, `testing`, and the
 * rest) is decided by version alone, so a project already on `1.0.0-rc.0` is
 * not reported as old. The bare name `smithers` is decided by its spec: a
 * `file:`, `link:`, or `workspace:` link into a 0.x checkout, or a 0.x version.
 *
 * A `@smthrs/` specifier that carries no version is old only when it is a
 * `file:` or `link:` path, which does point at a checkout on this machine.
 * `workspace:*`, `catalog:`, `*`, `latest`, an `npm:` alias, and a git URL are
 * not: `workspace:*` is how a 1.0 monorepo pins its own packages, and
 * reporting it old would have the project unit delete those dependencies from
 * `package.json`.
 *
 * That spec rule decides names that exist in both trees. A name in
 * {@link deletedSmthrsPackages} exists in neither, so it is decided by name
 * alone, exactly as {@link isOldSpecifier} decides an import of it.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const classifyPackage = (name: string, version: string): OldPackageReason | undefined => {
  if (oldPackageNames.includes(name)) return "old-name"
  if (name === localPackageName) {
    if (/^(?:file|link|workspace):/.test(version)) return "old-name"
    const parsed = Semver.parse(version)
    return parsed !== undefined && Semver.isBeforeOneZero(version) ? "old-version" : undefined
  }
  if (oldScopes.some((scope) => name.startsWith(scope))) return "old-scope"
  if (name.startsWith("@smthrs/")) {
    const bare = name.slice("@smthrs/".length)
    // Before the version, not after it. A deleted name has no 1.0 release, so
    // there is no specifier that makes it current, and a version test that ran
    // first dropped `@smthrs/components: workspace:*` out of `oldPackages`
    // altogether: no unit planned it, the archive left it in `package.json`,
    // and the postconditions read the same classification and passed over the
    // uninstallable dependency the project was left with.
    if (deletedSmthrsPackages.includes(bare)) return "deleted-package"
    const old = Semver.parse(version) === undefined
      ? /^(?:file|link):/.test(version)
      : Semver.isBeforeOneZero(version)
    return old ? "old-version" : undefined
  }
  return undefined
}

const readJson = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// Scanned, not matched. A tsconfig's own `"include": ["**\/*.ts"]` carries the
// two sequences a block-comment regular expression looks for, so matching one
// deletes the middle of the include list, and a tsconfig carrying a `smthrs/*`
// path mapping beside a `**\/*` include stops parsing altogether. The scanner
// in `internal/Jsonc.ts` is the one reader this package uses; `Archive` and the
// flow's postconditions read a tsconfig through the same function.
const readJsonWithComments = (text: string): Record<string, unknown> | undefined =>
  readJson(Jsonc.withoutComments(text))

const stringRecord = (value: unknown): ReadonlyArray<[string, string]> => {
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    typeof entry === "string" ? [[key, entry] as [string, string]] : []
  )
}

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.flatMap((entry) => (typeof entry === "string" ? [entry] : [])) : []

const scriptPatterns: ReadonlyArray<{ readonly kind: ScriptHit["kind"]; readonly pattern: RegExp }> = [
  { kind: "package-runner", pattern: /\b(?:bunx|npx|pnpm exec|pnpm dlx)\s+(?:smthrs|smithers-orchestrator)\b/g },
  {
    kind: "cli-verb",
    pattern:
      /\bsmithers\s+(up|workflow|init|gateway|serve|ps|logs|inspect|approve|deny|signal|cancel|pause|ui|gui|monitor|cron|eval|optimize|hijack|retry-task|rewind|fork|replay|timeline|snapshots|restore|revert|worktrees|human|ask-human|listeners|migrate|add|share|upgrade|docs|docs-full|graph|tree|diff|output|events|tail|down|bug|agents|memory|openapi|token|claude|supervise|gc)\b/g
  },
  { kind: "cli-entry", pattern: /apps\/cli\/src\/index\.js/g },
  { kind: "mcp", pattern: /--mcp\b/g },
  { kind: "environment", pattern: /\bSMITHERS_[A-Z_]+=/g }
]

const scriptFile = (file: string): boolean =>
  file.endsWith(".sh") ||
  file.endsWith("Makefile") ||
  file.endsWith("Justfile") ||
  file.endsWith("justfile") ||
  file.endsWith("Procfile") ||
  file.endsWith("bunfig.toml") ||
  /^\.github\/workflows\/.+\.ya?ml$/.test(file) ||
  /(^|\/)docker-compose[^/]*\.ya?ml$/.test(file)

const scanScriptText = (file: string, text: string): ReadonlyArray<ScriptHit> => {
  const hits: Array<ScriptHit> = []
  for (const { kind, pattern } of scriptPatterns) {
    const regexp = new RegExp(pattern.source, pattern.flags)
    let match = regexp.exec(text)
    while (match !== null) {
      const position = Fs.positionAt(text, match.index)
      hits.push({ file, ...position, text: match[0], kind })
      match = regexp.exec(text)
    }
  }
  return hits
}

const headerPattern = /^\/\/\s*smithers-([a-z-]+):\s*(.*)$/

const readHeaders = (text: string): ReadonlyMap<string, string> => {
  const headers = new Map<string, string>()
  for (const line of text.split("\n")) {
    const match = headerPattern.exec(line.trim())
    if (match === null) {
      if (line.trim() === "" || line.trim().startsWith("//") || line.trim().startsWith("/*")) continue
      break
    }
    headers.set(match[1] ?? "", (match[2] ?? "").trim())
  }
  return headers
}

const pragmaPattern = /@jsx(?:ImportSource|Runtime)\s+([^\s*]+)/g

const promptExpression = /\{([^{}]*)\}/g
const interpolationOnly = /^\s*(?:JSON\.stringify\(\s*)?props\.([A-Za-z_$][\w$]*)\s*\)?\s*$/

/**
 * Classifies one MDX prompt body and records the `props.<name>` identifiers it
 * interpolates.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const classifyPrompt = (
  text: string
): { readonly classification: PromptFile["classification"]; readonly props: ReadonlyArray<string> } => {
  const props = new Set<string>()
  let jsx = /^\s*import\s/m.test(text) || /^\s*export\s/m.test(text) || /<[A-Z][\w.]*/.test(text)
  const regexp = new RegExp(promptExpression.source, promptExpression.flags)
  let match = regexp.exec(text)
  while (match !== null) {
    const body = match[1] ?? ""
    const inner = interpolationOnly.exec(body)
    if (inner === null) {
      jsx = true
    } else {
      props.add(inner[1] ?? "")
    }
    match = regexp.exec(text)
  }
  return { classification: jsx ? "jsx" : "interpolation-only", props: [...props].sort() }
}

const integrationSubpaths = [
  "aws",
  "gcp",
  "vercel",
  "cloudflare",
  "daytona",
  "microsandbox",
  "telegram",
  "openapi",
  "xstate",
  "control-plane",
  "evals",
  "scorers",
  "memory",
  "sandbox",
  "gateway-client"
]

const integrationOf = (specifier: string): string | undefined => {
  for (const prefix of ["smthrs/", "smithers-orchestrator/"]) {
    if (!specifier.startsWith(prefix)) continue
    const rest = specifier.slice(prefix.length)
    if (integrationSubpaths.includes(rest)) return rest
    if (["linear", "zod", "mdx-plugin", "jsx-runtime", "ai"].includes(rest)) return rest
  }
  if (specifier.startsWith("@smthrs/integrations/")) return specifier.slice("@smthrs/integrations/".length)
  return undefined
}

const resolveRelative = (
  path: Path.Path,
  from: string,
  specifier: string,
  files: ReadonlySet<string>
): string | undefined => {
  const base = path.join(path.dirname(from), specifier).split(path.sep).join("/")
  const normalized = base.startsWith("./") ? base.slice(2) : base
  const candidates = [
    normalized,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".mdx"].map((extension) => `${normalized}${extension}`),
    ...[".ts", ".tsx", ".js", ".jsx"].map((extension) => `${normalized}/index${extension}`),
    normalized.replace(/\.js$/, ".ts"),
    normalized.replace(/\.js$/, ".tsx")
  ]
  return candidates.find((candidate) => files.has(candidate))
}

/**
 * Reads a project and reports everything a Smithers 0.x migration has to
 * account for.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const scan = (
  root: string,
  options: ScanOptions = {},
  parse: typeof Ts.parse = Ts.parse
): Effect.Effect<Detection, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const walked = yield* Fs.walkReport(root, options.ignore === undefined ? {} : { ignore: options.ignore })
    const files = walked.files
    const fileSet = new Set(files)
    const warnings: Array<Warning> = walked.skipped.map((skip) => ({
      code: "incomplete-scan",
      file: skip.path,
      message: skip.message
    }))
    const sources = new Map<string, string>()

    // A file the scan could not read is reported, never treated as empty:
    // a manifest that reads as nothing would plan a project with no
    // dependencies. Only the platform's typed NotFound is silence, because a
    // file that is not there was not there.
    const unreadable = new Set<string>()
    const readText = (file: string): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
      Effect.gen(function*() {
        const cached = sources.get(file)
        if (cached !== undefined) return cached
        // Reported once, however many scanners ask for the file.
        if (unreadable.has(file)) return undefined
        unreadable.add(file)
        const fs = yield* FileSystem.FileSystem
        const absolute = path.join(root, ...file.split("/"))
        // A path through a symbolic link may read a file from outside the
        // project, so it is reported rather than read.
        const link = yield* Fs.linkOnPath(root, file).pipe(Effect.provideService(Path.Path, path))
        if (link !== undefined) {
          warnings.push({
            code: "incomplete-scan",
            file,
            message: link === file
              ? `"${file}" is a symbolic link and was not read`
              : `"${file}" is reached through the symbolic link "${link}" and was not read`
          })
          return undefined
        }
        const info = yield* Effect.result(Fs.optionalNotFound(fs.stat(absolute)))
        if (info._tag === "Failure") {
          warnings.push({
            code: "incomplete-scan",
            file,
            message: `"${file}" could not be inspected: ${info.failure.message}`
          })
          return undefined
        }
        if (Option.isNone(info.success)) return undefined
        const size = Number(info.success.value.size)
        if (size > Fs.maxFileBytes) {
          warnings.push({
            code: "incomplete-scan",
            file,
            message: `"${file}" is ${size} bytes, above the ${Fs.maxFileBytes} byte scan limit, and was not read`
          })
          return undefined
        }
        const read = yield* Effect.result(Fs.readIfExists(absolute, file))
        if (read._tag === "Failure") {
          warnings.push({ code: "incomplete-scan", file, message: read.failure.message })
          return undefined
        }
        if (read.success !== undefined) {
          sources.set(file, read.success)
          unreadable.delete(file)
        }
        return read.success
      })

    // 3.1 Packages.
    const manifestPaths = files.filter((file) => file === "package.json" || file.endsWith("/package.json"))
    const manifests: Array<ManifestFinding> = []
    let packageManager: string | undefined
    const effectDeclarations: Array<EffectDeclaration> = []

    for (const file of manifestPaths) {
      const text = yield* readText(file)
      if (text === undefined) continue
      const json = readJson(text)
      if (json === undefined) {
        warnings.push({ code: "unparsable-manifest", file, message: `"${file}" is not valid JSON` })
        continue
      }
      const oldPackages: Array<OldPackage> = []
      const companions: Array<CompanionPackage> = []
      for (const field of manifestFields) {
        for (const [name, version] of stringRecord(json[field])) {
          const reason = classifyPackage(name, version)
          if (reason !== undefined) oldPackages.push({ name, version, field, reason })
          if (companionPackages.some((candidate) => name === candidate || name.startsWith(candidate))) {
            companions.push({ name, version, field })
            if (name === "effect") effectDeclarations.push({ file, field, version })
          }
        }
      }
      const manager = json["packageManager"]
      if (typeof manager === "string" && file === "package.json") packageManager = manager
      const workspacesValue = json["workspaces"]
      const workspaces = Array.isArray(workspacesValue)
        ? stringArray(workspacesValue)
        : stringArray((workspacesValue as { packages?: unknown } | undefined)?.packages)
      const kind: ManifestFinding["kind"] = file === "package.json"
        ? "root"
        : file === ".smithers/package.json"
        ? "smithers"
        : "workspace-member"
      manifests.push({
        path: file,
        kind,
        name: typeof json["name"] === "string" ? json["name"] : undefined,
        packageManager: typeof manager === "string" ? manager : undefined,
        workspaces,
        oldPackages,
        companions,
        scripts: stringRecord(json["scripts"]).map(([name, command]) => ({ name, command }))
      })
    }

    // The root manifest's declaration is the pin the report names; every
    // declaration is judged. Exactly one version, `4.0.0-rc.115`, is
    // acceptable: a range resolves to whatever is newest on install day, a
    // later prerelease is one this release was never built against, and two
    // manifests that disagree install two Effects.
    const rootDeclaration = effectDeclarations.find((entry) => entry.file === "package.json")
    const effectPin = (rootDeclaration ?? effectDeclarations[0])?.version
    for (const declaration of effectDeclarations) {
      if (declaration.version === Versions.effectVersion) continue
      warnings.push({
        code: "effect-pin-conflict",
        file: declaration.file,
        message:
          `${declaration.field}."effect" is "${declaration.version}"; Smithers 1.0 requires exactly ${Versions.effectVersion}`
      })
    }
    const distinctPins = [...new Set(effectDeclarations.map((entry) => entry.version))].sort()
    if (distinctPins.length > 1) {
      warnings.push({
        code: "effect-pin-conflict",
        file: rootDeclaration?.file ?? effectDeclarations[0]!.file,
        message: `the manifests declare effect as ${
          distinctPins.map((version) => `"${version}"`).join(", ")
        }; one version, ${Versions.effectVersion}, has to be declared everywhere`
      })
    }

    const lockfiles = files.filter((file) =>
      ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"].includes(
        file.split("/").pop() ?? ""
      )
    )
    // What the lockfiles resolved `effect` to. A manifest can pin the right
    // version while the lockfile still holds the one an earlier install
    // resolved, and the lockfile is what the next install obeys.
    for (const lockfile of lockfiles) {
      if (lockfile.endsWith("bun.lockb")) continue
      const lock = yield* readText(lockfile)
      if (lock === undefined) continue
      for (const resolved of resolvedEffectVersions(lock)) {
        if (resolved === Versions.effectVersion) continue
        warnings.push({
          code: "effect-pin-conflict",
          file: lockfile,
          message:
            `"${lockfile}" resolves effect to "${resolved}"; Smithers 1.0 requires exactly ${Versions.effectVersion}`
        })
      }
    }

    // 3.2 tsconfig chains.
    const tsconfigs: Array<TsconfigFinding> = []
    for (const file of files.filter(isTsconfig)) {
      const text = yield* readText(file)
      if (text === undefined) continue
      const json = readJsonWithComments(text)
      if (json === undefined) {
        warnings.push({ code: "unparsable-tsconfig", file, message: `"${file}" is not valid JSON` })
        continue
      }
      const compilerOptions = (json["compilerOptions"] ?? {}) as Record<string, unknown>
      tsconfigs.push({
        path: file,
        extends: typeof json["extends"] === "string" ? json["extends"] : undefined,
        jsx: typeof compilerOptions["jsx"] === "string" ? compilerOptions["jsx"] : undefined,
        jsxImportSource: typeof compilerOptions["jsxImportSource"] === "string"
          ? compilerOptions["jsxImportSource"]
          : undefined,
        paths: Object.keys((compilerOptions["paths"] ?? {}) as Record<string, unknown>).filter((key) =>
          key.startsWith("smthrs") || key.startsWith("@smithers/") || key.startsWith("@smthrs/")
        ),
        types: stringArray(compilerOptions["types"]),
        include: stringArray(json["include"])
      })
    }

    // A project inside the old monorepo depends on the facade by its bare
    // directory name, so `import { createSmithers } from "smithers"` is an old
    // import there and nowhere else.
    const localFacade = manifests.some((manifest) =>
      manifest.oldPackages.some((entry) => entry.name === localPackageName)
    )
    // Design 3.2 is gated by 3.1: an `@smthrs/<name>` that exists in both trees
    // is an old import only where a manifest pinned it below `1.0.0`.
    const oldScoped = [
      ...new Set(
        manifests.flatMap((manifest) =>
          manifest.oldPackages
            .filter((entry) => entry.name.startsWith("@smthrs/"))
            .map((entry) => entry.name.slice("@smthrs/".length))
        )
      )
    ].sort(Sort.byText)
    const specifierContext: SpecifierContext = { localFacade, oldScoped }

    // 3.2 Imports and pragmas, over every source file.
    const pragmas: Array<FileHit> = []
    const importHits: Array<ImportHit> = []
    const integrations: Array<IntegrationHit> = []
    const localImportsByFile = new Map<string, Array<string>>()
    const mdxImportsByFile = new Map<string, Array<string>>()
    // Files whose syntax tree holds a real JSX element. The parse is the one
    // the import walk already does, and it is the only reading that tells a
    // rendered element from the same characters inside a comment or a string.
    // A migrated flow whose JSDoc says "the old `<Sequence>` is one
    // `Node.andThen`" is the case: read as text it looks like a workflow, read
    // as syntax it is a comment.
    const jsxFiles = new Set<string>()
    // Files that import Smithers 1.0. `isOldSpecifier` has already decided
    // which `@smthrs/*` names this project's manifests pin to 0.x, so what is
    // left under the scope is the new tree.
    const newApiFiles = new Set<string>()

    for (const file of files.filter(isSource)) {
      const text = yield* readText(file)
      if (text === undefined) continue

      const pragmaRegexp = new RegExp(pragmaPattern.source, pragmaPattern.flags)
      let pragmaMatch = pragmaRegexp.exec(text)
      while (pragmaMatch !== null) {
        const value = pragmaMatch[1] ?? ""
        if (value === "smthrs" || value === "smithers-orchestrator" || pragmaMatch[0].includes("jsxRuntime")) {
          pragmas.push({ file, ...Fs.positionAt(text, pragmaMatch.index), text: pragmaMatch[0] })
        }
        pragmaMatch = pragmaRegexp.exec(text)
      }

      const parsed = parse(file, text)
      Ts.forEachNode(parsed, (node) => {
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) jsxFiles.add(file)
      })
      const local: Array<string> = []
      const mdx: Array<string> = []
      for (const record of Ts.imports(parsed)) {
        const names = [...record.names].map(([localName, imported]) => ({ local: localName, imported }))
        const specifier = record.specifier
        const integration = integrationOf(specifier)
        if (integration !== undefined) {
          integrations.push({ file, line: record.line, column: record.column, integration, kind: "import" })
        }
        if (specifier.startsWith("@smthrs/") && !isOldSpecifier(specifier, specifierContext)) newApiFiles.add(file)
        if (isOldSpecifier(specifier, specifierContext)) {
          importHits.push({
            file,
            line: record.line,
            column: record.column,
            specifier,
            names,
            namespace: record.namespace,
            typeOnly: record.typeOnly,
            kind: "old"
          })
          // A name the catalog does not know is a name the mapping cannot
          // decide, and a scan that silently drops it hides work from the
          // operator. Report it instead. A type-only import is exempt: the
          // catalog holds the values application code calls, and the old
          // facade's type exports are not among them.
          for (const { imported } of record.typeOnly ? [] : names) {
            if (imported === "default" || Constructs.isCatalogued(imported)) continue
            warnings.push({
              code: "uncatalogued-import",
              file,
              message: `"${imported}" from "${specifier}" has no construct-catalog row`
            })
          }
        } else if (foreignAuthoringApis.includes(specifier)) {
          importHits.push({
            file,
            line: record.line,
            column: record.column,
            specifier,
            names,
            namespace: record.namespace,
            typeOnly: record.typeOnly,
            kind: "foreign"
          })
        } else if (specifier.startsWith(".")) {
          const resolved = resolveRelative(path, file, specifier, fileSet)
          const target = resolved ?? specifier
          if (specifier.endsWith(".mdx")) {
            mdx.push(target)
            importHits.push({
              file,
              line: record.line,
              column: record.column,
              specifier: target,
              names,
              namespace: record.namespace,
              typeOnly: record.typeOnly,
              kind: "mdx"
            })
          } else {
            local.push(target)
            importHits.push({
              file,
              line: record.line,
              column: record.column,
              specifier: target,
              names,
              namespace: record.namespace,
              typeOnly: record.typeOnly,
              kind: "relative"
            })
          }
        }
      }
      localImportsByFile.set(file, local)
      mdxImportsByFile.set(file, mdx)

      for (const call of ["createSmithersCloudflare", "createExternalSmithers", "createSmithersPostgres"]) {
        const index = text.indexOf(`${call}(`)
        if (index >= 0) {
          integrations.push({ file, ...Fs.positionAt(text, index), integration: call, kind: "call" })
        }
      }
    }

    const importsByFile = new Map<string, Array<ImportHit>>()
    for (const hit of importHits) {
      const list = importsByFile.get(hit.file) ?? []
      list.push(hit)
      importsByFile.set(hit.file, list)
    }

    const oldImportFiles = new Set(
      importHits.filter((hit) => hit.kind === "old").map((hit) => hit.file)
    )

    // Every file that reaches the old facade, directly or through the pack's
    // own modules. A pack calls `createSmithers` in one module and imports the
    // bindings everywhere else: Plue's `batch-issues` components take `Task`
    // and `outputs` from `../smithers`, and eight of the thirteen name no old
    // package at all. They are still authored against the 0.x API, and a
    // migration that left them behind would move the workflow and not its
    // steps. The walk is capped so a cyclic import graph cannot stall a scan.
    const reachesFacade = new Set(oldImportFiles)
    for (let pass = 0; pass < 8; pass++) {
      let grew = false
      for (const [file, imported] of localImportsByFile) {
        if (reachesFacade.has(file)) continue
        if (!imported.some((next) => reachesFacade.has(next))) continue
        reachesFacade.add(file)
        grew = true
      }
      if (!grew) break
    }
    const pragmaFiles = new Set(pragmas.map((hit) => hit.file))

    // 3.3 Workflow files.
    // A workflow file lives in a workflow directory, or is a JSX file that
    // carries a pragma or calls the factory, or is a non-JSX module that
    // default-exports a rendered workflow. The last clause needs the default
    // export: a `.js` library that merely calls `createSmithers` and hands the
    // factory back (the old `examples/_example-kit.js` is exactly this) is a
    // library, not a workflow, and migrating it as one would produce a flow
    // nothing runs.
    const authors = /\b(createSmithers|createSmither|runWorkflow|smithers)\s*\(/
    // `export default smithers(...)`, `export default createSmithers(...)`, or
    // the same call behind a name the module default-exports.
    const defaultExportsFactory =
      /(^|\n)\s*export\s+default\s+[^\n;]*\b(createSmithers|createSmither|runWorkflow|smithers)\s*\(/
    const sourceHeader = /(^|\n)\s*\/\/\s*smithers-source:/
    const workflowShaped = (file: string, text: string): boolean => {
      const pack = /(^|\/)\.smithers\/workflows\/(.+)$/.exec(file)?.[2]
      const inWorkflowDirectory = pack !== undefined
      if (/\.[jt]sx$/.test(file)) {
        // A pack is a directory of its own under `.smithers/workflows/`, and
        // most of its `.tsx` files are components, not workflows. Plue's
        // `batch-issues` pack holds thirteen function components beside the one
        // `workflow.tsx` that default-exports the factory call. Position alone
        // decides a file that sits directly in the workflows directory; a file
        // nested inside a pack has to default-export the factory, or say what
        // it is with the `// smithers-source:` header the CLI reads.
        if (inWorkflowDirectory && pack.includes("/")) {
          return defaultExportsFactory.test(text) || sourceHeader.test(text)
        }
        return inWorkflowDirectory ||
          /^examples\/[^/]+\.(jsx|tsx)$/.test(file) ||
          pragmaFiles.has(file) ||
          authors.test(text)
      }
      // A `.ts` or `.mdx` file in the workflow directory is a schema, a config,
      // a prompt, or a helper far more often than it is a workflow. Plue's
      // `batch-issues` pack holds eleven schema modules, eight prompts, and a
      // config beside one `workflow.tsx`. It has to earn the name.
      const exportsDefault = /(^|\n)\s*export\s+default\b/.test(text)
      if (!exportsDefault) return false
      // A source file is judged by its syntax tree, which the import walk has
      // already built. `.mdx` is not parsed, so it keeps the text reading.
      const rendersJsx = isSource(file) ? jsxFiles.has(file) : /<[A-Z][\w.]*/.test(text)
      return (
        pragmaFiles.has(file) ||
        rendersJsx ||
        /\b(createSmithers|createSmither|runWorkflow)\s*\(/.test(text) ||
        (oldImportFiles.has(file) && /\bsmithers\s*\(/.test(text))
      )
    }

    const excludedWorkflow = (file: string): boolean =>
      file.endsWith(".log") ||
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
      file.includes("/.worktrees/") ||
      /(^|\/)\.smithers\/(prompts|components|ui|agents|skills|evals)\//.test(file)

    const workflowFiles: Array<WorkflowFile> = []
    for (const file of files) {
      if (!isSource(file) && !file.endsWith(".mdx")) continue
      if (excludedWorkflow(file)) continue
      const text = yield* readText(file)
      if (text === undefined) continue
      if (!workflowShaped(file, text)) continue
      const fileImports = importsByFile.get(file) ?? []
      // A pack that calls `createSmithers` in one module and imports the
      // bindings everywhere else is authoring against the old facade in every
      // one of those files, even though only the one module names it.
      const throughRelative = fileImports.some((hit) => hit.kind === "relative" && oldImportFiles.has(hit.specifier))
      const api: WorkflowApi = fileImports.some((hit) =>
          hit.kind === "old" && hit.specifier.startsWith("smithers-orchestrator")
        )
        ? "smithers-orchestrator"
        : fileImports.some((hit) => hit.kind === "old") || throughRelative
        ? "smthrs"
        : fileImports.some((hit) => hit.kind === "foreign")
        ? "foreign"
        // Old wins over new on a file that imports both: a half-migrated file
        // still has a 0.x half to migrate. Only a file with no old import at
        // all is already on 1.0.
        : newApiFiles.has(file)
        ? "flows"
        : "unknown"
      if (api === "flows") {
        warnings.push({
          code: "already-migrated",
          file,
          message: `"${file}" already imports the Smithers 1.0 authoring API and is not migrated again`
        })
      } else if (api === "foreign" || api === "unknown") {
        warnings.push({
          code: "unknown-authoring-api",
          file,
          message: api === "foreign"
            ? `"${file}" is written against ${
              fileImports.find((hit) => hit.kind === "foreign")?.specifier ?? "a foreign API"
            }, not Smithers 0.x`
            : `"${file}" looks like a workflow but imports no known authoring API`
        })
      } else {
        // A file can import both. Plue's `issue-pipeline.tsx` takes its
        // `createSmithers`, `Sequence`, and `Parallel` from
        // `@smithers-ai/workflow` and its agents and `Worktree` from
        // `smithers-orchestrator`. The inventory records only the 0.x half, so
        // the operator has to be told the other half is there and is not this
        // tool's to migrate.
        const other = fileImports.find((hit) => hit.kind === "foreign")
        if (other !== undefined) {
          warnings.push({
            code: "mixed-authoring-api",
            file,
            message:
              `"${file}" imports Smithers 0.x and "${other.specifier}" in the same file; only the 0.x half is inventoried`
          })
        }
      }
      const extension = file.split(".").pop() ?? ""
      const kind: WorkflowFile["kind"] = extension === "jsx"
        ? "jsx"
        : extension === "tsx"
        ? "tsx"
        : extension === "mdx"
        ? "mdx"
        : extension === "ts"
        ? "ts"
        : "js"
      workflowFiles.push({
        path: file,
        kind,
        api,
        headers: readHeaders(text),
        localImports: localImportsByFile.get(file) ?? []
      })
    }

    // 3.1 A manifest in a directory that holds a workflow file is the pack's
    // own manifest, not another member of the application's workspace.
    const workflowDirectories = new Set(
      workflowFiles.map((workflow) => workflow.path.split("/").slice(0, -1).join("/"))
    )
    for (const [index, manifest] of manifests.entries()) {
      if (manifest.kind !== "workspace-member") continue
      const directory = manifest.path.split("/").slice(0, -1).join("/")
      if (workflowDirectories.has(directory)) manifests[index] = { ...manifest, kind: "workflow-adjacent" }
    }

    // 3.3 Prompts.
    const workflowMdx = new Set(workflowFiles.flatMap((workflow) => mdxImportsByFile.get(workflow.path) ?? []))
    const prompts: Array<PromptFile> = []
    for (const file of files.filter((candidate) => candidate.endsWith(".mdx"))) {
      const inPromptDirectory = /(^|\/)(\.smithers|examples)\/prompts\//.test(file) || /(^|\/)prompts\//.test(file)
      if (!inPromptDirectory && !workflowMdx.has(file)) continue
      const text = yield* readText(file)
      if (text === undefined) continue
      prompts.push({ path: file, ...classifyPrompt(text) })
    }

    // 3.3 Components, UIs, tests, libraries.
    const workflowPaths = new Set(workflowFiles.map((workflow) => workflow.path))
    // A pack keeps its components in its own `components/` directory, so the
    // match is any `components/` directory inside a `.smithers` or `examples`
    // tree, not only the one at its root.
    const components = files.filter((file) =>
      /(^|\/)(\.smithers|examples)\/(?:.*\/)?components\//.test(file) && isSource(file) && reachesFacade.has(file)
    )

    const uiImportSpecifiers = [
      "smthrs/gateway-react",
      "smthrs/gateway-ui",
      "smthrs/ui",
      "smithers-orchestrator/gateway-react",
      "smithers-orchestrator/gateway-ui",
      "smithers-orchestrator/ui"
    ]
    const uiPaths = new Map<string, Array<string>>()
    for (const file of files) {
      if (!/(^|\/)(\.smithers|examples)\/ui\//.test(file)) continue
      if (!isSource(file)) continue
      uiPaths.set(file, [])
    }
    for (const hit of importHits) {
      if (!uiImportSpecifiers.includes(hit.specifier)) continue
      if (!uiPaths.has(hit.file)) uiPaths.set(hit.file, [])
    }
    for (const workflow of workflowFiles) {
      const text = sources.get(workflow.path)
      if (text === undefined) continue
      const parsed = parse(workflow.path, text)
      Ts.forEachNode(parsed, (node) => {
        if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) return
        if (Ts.tagName(node) !== "UI" && Ts.tagName(node) !== "TUI") return
        const entry = Ts.attributeText(node, "entry")
        if (entry === undefined) return
        const resolved = resolveRelative(path, workflow.path, entry, fileSet)
        const key = resolved ?? entry
        const referencedBy = uiPaths.get(key) ?? []
        referencedBy.push(workflow.path)
        uiPaths.set(key, referencedBy)
        if (resolved === undefined) {
          warnings.push({
            code: "unresolved-ui-entry",
            file: workflow.path,
            message: `<UI entry="${entry}"> does not resolve to a file in the project`
          })
        }
      })
    }
    const uis: Array<UiFile> = [...uiPaths]
      .map(([file, referencedBy]) => ({ path: file, resolved: fileSet.has(file), referencedBy: referencedBy.sort() }))
      .sort(Sort.by((entry) => entry.path))

    const tests = files.filter((file) =>
      isSource(file) &&
      (importsByFile.get(file) ?? []).some((hit) =>
        hit.specifier === "smthrs/testing" ||
        hit.specifier === "smithers-orchestrator/testing" ||
        hit.specifier === "@smthrs/testing"
      )
    )

    // Libraries: the transitive closure of relative imports from a workflow
    // that themselves reach the old facade, capped at depth 8 so a cyclic or
    // very deep import graph cannot stall a scan.
    const libs = new Set<string>()
    const seen = new Set<string>()
    let frontier = workflowFiles.flatMap((workflow) => workflow.localImports)
    for (let depth = 0; depth < 8 && frontier.length > 0; depth++) {
      const next: Array<string> = []
      for (const file of frontier) {
        if (seen.has(file) || workflowPaths.has(file)) continue
        seen.add(file)
        if (!fileSet.has(file)) continue
        if (reachesFacade.has(file)) libs.add(file)
        next.push(...(localImportsByFile.get(file) ?? []))
      }
      frontier = next
    }

    // 3.4 Scripts.
    const scripts: Array<ScriptHit> = []
    for (const manifest of manifests) {
      const text = sources.get(manifest.path)
      if (text === undefined) continue
      for (const script of manifest.scripts) {
        for (const hit of scanScriptText(manifest.path, script.command)) {
          const index = text.indexOf(script.command)
          const position = index >= 0 ? Fs.positionAt(text, index) : { line: 1, column: 1 }
          scripts.push({ ...hit, ...position })
        }
      }
    }
    for (const file of files.filter(scriptFile)) {
      const text = yield* readText(file)
      if (text === undefined) continue
      scripts.push(...scanScriptText(file, text))
    }
    for (const file of files.filter((candidate) => candidate.endsWith(".md"))) {
      const text = yield* readText(file)
      if (text === undefined) continue
      scripts.push(...scanScriptText(file, text).filter((hit) => hit.kind !== "environment"))
    }

    // 3.4 Config.
    const configFile = (predicate: (file: string) => boolean): ReadonlyArray<string> => files.filter(predicate)
    const smithersConfigPath = files.find((file) => /(^|\/)smithers\.config\.[tj]s$/.test(file))
    let smithersConfig: ConfigFindings["smithersConfig"]
    if (smithersConfigPath !== undefined) {
      const text = (yield* readText(smithersConfigPath)) ?? ""
      const backendMatch = /backend\s*[:=]\s*["']([a-z]+)["']/.exec(text)
      const repoCommands = new Map<string, string>()
      const block = /repoCommands\s*=\s*\{([\s\S]*?)\}/.exec(text) ?? /repoCommands\s*:\s*\{([\s\S]*?)\}/.exec(text)
      if (block !== null) {
        const entry = /([A-Za-z_$][\w$]*)\s*:\s*(?:"([^"]*)"|'([^']*)')/g
        let match = entry.exec(block[1] ?? "")
        while (match !== null) {
          repoCommands.set(match[1] ?? "", match[2] ?? match[3] ?? "")
          match = entry.exec(block[1] ?? "")
        }
      }
      smithersConfig = {
        path: smithersConfigPath,
        backend: backendMatch?.[1],
        repoCommands
      }
    }

    const preload: Array<{ path: string; mdxPlugin: boolean }> = []
    for (const file of configFile((candidate) => /(^|\/)preload\.[tj]s$/.test(candidate))) {
      const text = (yield* readText(file)) ?? ""
      preload.push({ path: file, mdxPlugin: /\bmdxPlugin\s*\(/.test(text) })
    }

    const bunfig: Array<{ path: string; preload: ReadonlyArray<string> }> = []
    for (const file of configFile((candidate) => candidate.endsWith("bunfig.toml"))) {
      const text = (yield* readText(file)) ?? ""
      const entries = new Set<string>()
      const regexp = /preload\s*=\s*\[([^\]]*)\]/g
      let match = regexp.exec(text)
      while (match !== null) {
        for (const part of (match[1] ?? "").split(",")) {
          const trimmed = part.trim().replace(/^["']|["']$/g, "")
          if (trimmed !== "") entries.add(trimmed)
        }
        match = regexp.exec(text)
      }
      bunfig.push({ path: file, preload: [...entries].sort() })
    }

    const config: ConfigFindings = {
      smithersConfig,
      agents: configFile((file) => /(^|\/)\.smithers\/agents(\.[tj]s|\/[^/]+\.[tj]s)$/.test(file)),
      preload,
      bunfig,
      gateway: configFile((file) => /(^|\/)\.smithers\/gateway\.[tj]s$/.test(file)),
      toon: configFile((file) => file.endsWith(".smithers/smithers.toon")),
      listeners: configFile((file) => file.endsWith(".smithers/listeners.json")),
      packs: configFile((file) => /(^|\/)\.smithers\/packs(\.lock|\/)/.test(file)),
      assetTypes: configFile((file) => /(^|\/)(types\/assets|mdx-assets)\.d\.ts$/.test(file)),
      gitignore: configFile((file) => file.endsWith(".gitignore")),
      skills: configFile((file) => /(^|\/)\.smithers\/skills\/.+\.md$/.test(file)),
      evals: configFile((file) => /(^|\/)\.smithers\/evals\//.test(file))
    }

    // 3.4 Integration environment names. A hit assigns this file to a unit;
    // it does not make dotenv contents safe for a model. Transform.capture
    // replaces `.env*` source text with a redacted assignment-name inventory.
    for (
      const file of files.filter((candidate) => /(^|\/)(\.env[^/]*|wrangler\.[a-z]+|vercel\.json)$/.test(candidate))
    ) {
      const text = yield* readText(file)
      if (text === undefined) continue
      const regexp = /\bSMITHERS_[A-Z_]+/g
      let match = regexp.exec(text)
      while (match !== null) {
        integrations.push({ file, ...Fs.positionAt(text, match.index), integration: match[0], kind: "environment" })
        match = regexp.exec(text)
      }
    }

    const environment = options.environment ?? {}
    // `TMPDIR` ends in a separator on macOS and does not on Linux, and
    // `RunState.scan` joins the same two parts with `path.join`. Concatenating
    // them here reported `/tmpsmithers-gateway` on Linux, so the two halves of
    // one detection disagreed about the path the operator is told to look at.
    const under = (directory: string | undefined, child: string): string | undefined => {
      const trimmed = directory?.replace(/\/+$/, "")
      return trimmed === undefined || trimmed === "" ? undefined : `${trimmed}/${child}`
    }
    const globalState = [
      environment["SMITHERS_HOME"],
      under(environment["HOME"], ".smithers"),
      under(environment["TMPDIR"], "smithers-gateway")
    ].flatMap((entry) => (entry === undefined ? [] : [entry]))

    return {
      root,
      files,
      manifests,
      lockfiles,
      packageManager,
      tsconfigs,
      pragmas,
      imports: importHits,
      workflowFiles,
      prompts,
      components,
      uis,
      tests,
      libs: [...libs].sort(),
      scripts,
      config,
      integrations,
      effectPin,
      effectDeclarations,
      globalState,
      warnings,
      sources
    }
  })

/**
 * Every version a lockfile resolved the `effect` package to, deduplicated and
 * sorted. Reads the four lockfile dialects by their own spelling of a resolved
 * package: `effect@<version>` keys (pnpm, bun, yarn classic), the
 * `node_modules/effect` entry (npm), and a yarn berry `effect@npm:` key with
 * its `version:` line.
 *
 * @category scanners
 * @since 1.0.0-rc.0
 */
export const resolvedEffectVersions = (lock: string): ReadonlyArray<string> => {
  const found = new Set<string>()
  for (const match of lock.matchAll(/(?<![\w@/.-])effect@(\d[^\s"',:()]*)/g)) found.add(match[1]!)
  for (const match of lock.matchAll(/"node_modules\/effect":\s*\{[^}]*?"version":\s*"([^"]+)"/g)) found.add(match[1]!)
  for (const match of lock.matchAll(/^"?effect@npm:[^\n]*:\n\s+version:? "?([^"\n]+)"?/gm)) found.add(match[1]!)
  return [...found].sort()
}
