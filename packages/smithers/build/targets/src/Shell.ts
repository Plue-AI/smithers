/**
 * PACKAGE.ts shell target flavors: `S.Shell.Build`, `S.Shell.Test`,
 * `S.Shell.Run`, `S.Shell.Serve`, and `S.Shell.Diff`.
 *
 * Phase W2 gives `Build`, `Test`, `Run`, and `Diff` real plan-time bodies:
 * each plans the one shared {@link Exec.runTool} exec node whose payload is
 * built by {@link execPayload}. Tool references, flag references, and bun
 * templates appear in the payload as sentinel argv tokens; the package
 * executor resolves them against the workspace immediately before spawn and
 * records the resolutions as key material. `Serve` stays a typed
 * `NotImplemented` refusal — service execution is a later lane.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Runtime from "./Runtime.ts"
import type * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

const durationPattern = /^(\d+)(ms|s|m|h)$/

const parsedDurationMs = (text: string): number | undefined => {
  const match = durationPattern.exec(text)
  if (match === null) return undefined
  const unit = match[2]
  return Number(match[1]) * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000)
}

/**
 * A declared tool duration such as `"90s"` or `"6h"`: digits followed by
 * `ms`, `s`, `m`, or `h`, whose value lies in the shared exec range of 1 ms
 * to {@link Exec.maximumTimeoutMs}. A duration outside that range fails at
 * declaration, not when the target runs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Duration = Schema.NonEmptyString.check(
  Schema.isPattern(durationPattern),
  Schema.makeFilter((text) => {
    const ms = parsedDurationMs(text)
    return ms !== undefined && Number.isSafeInteger(ms) && ms >= 1 && ms <= Exec.maximumTimeoutMs
      ? undefined
      : `timeout ${JSON.stringify(text)} must be between 1ms and ${Exec.maximumTimeoutMs}ms`
  })
)

/** The attr fields every Shell flavor shares. */
const sharedFields = {
  bin: Schema.optional(Attr.Executable),
  bun: Schema.optional(Schema.NonEmptyString),
  shell: Schema.optional(Schema.NonEmptyString),
  script: Schema.optional(Input.File),
  using: Schema.optional(Attr.Using),
  // Executables the process spawns by itself, not through argv. Their bytes
  // are key material and an absent one refuses the target.
  tools: Schema.optional(Schema.Array(Reference.Tool)),
  args: Schema.optional(Attr.Args),
  runtimeArgs: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Attr.Env),
  data: Schema.optional(Attr.Data),
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  hosts: Schema.optional(Attr.HostPlatforms),
  runtime: Schema.optional(Schema.Union([Runtime.Runtime, Runtime.NodeDeclaration, Runtime.BunDeclaration])),
  timeout: Schema.optional(Duration)
} as const

const executableSelectors = ["bin", "bun", "shell", "script"] as const

const executableIssue = (attrs: ExecAttrs): string | undefined => {
  const selected = executableSelectors.filter((selector) => attrs[selector] !== undefined)
  if (selected.length !== 1) {
    return `shell declaration requires exactly one of ${executableSelectors.join(", ")}; received ${
      selected.length === 0 ? "none" : selected.join(", ")
    }`
  }
  if (
    attrs.shell !== undefined &&
    (attrs.args !== undefined || attrs.runtimeArgs !== undefined || attrs.using !== undefined)
  ) {
    return "shell text cannot take args, runtimeArgs, or using; put arguments in the shell text or use bin"
  }
  if (attrs.bun !== undefined && (attrs.args !== undefined || attrs.runtimeArgs !== undefined)) {
    return "bun templates cannot take args or runtimeArgs"
  }
  if (attrs.using !== undefined && attrs.bun === undefined) return "using is only supported by bun templates"
  if (attrs.script !== undefined && attrs.runtimeArgs !== undefined) return "script cannot take runtimeArgs"
  return undefined
}
const executableCheck = Schema.makeFilter(executableIssue)

/**
 * Attrs for {@link Build}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildAttrs = Schema.Struct({
  ...sharedFields,
  outDirs: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  outFiles: Schema.optional(Schema.Array(Schema.NonEmptyString))
}).check(
  executableCheck,
  Schema.makeFilter((attrs) =>
    (attrs.outDirs?.length ?? 0) + (attrs.outFiles?.length ?? 0) === 0
      ? "Shell.Build requires at least one outDirs or outFiles entry"
      : undefined
  )
)

/**
 * Attrs for {@link Test}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestAttrs = Schema.Struct({
  ...sharedFields,
  /**
   * Puts the test in the exclusive tier: wildcard `test` and `ci` selections
   * omit it unless `--include-exclusive` is set, and once selected it runs
   * alone in its executor invocation.
   */
  exclusive: Schema.optional(Schema.Boolean),
  services: Schema.optional(Attr.Services),
  gates: Schema.optional(Attr.Gates),
  shards: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))
}).check(executableCheck)

/**
 * Attrs for {@link Run}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RunAttrs = Schema.Struct({
  ...sharedFields,
  manual: Schema.optional(Schema.Boolean),
  approval: Schema.optional(Attr.Approval),
  services: Schema.optional(Attr.Services),
  gates: Schema.optional(Attr.Gates)
}).check(executableCheck)

/**
 * Attrs for {@link Serve}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ServeAttrs = Schema.Struct({
  ...sharedFields,
  services: Schema.optional(Attr.Services),
  readiness: Schema.optional(Attr.Readiness),
  health: Schema.optional(Attr.Health),
  stop: Schema.optional(Attr.Stop)
}).check(executableCheck)

/**
 * Attrs for {@link Diff}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DiffAttrs = Schema.Struct({
  ...sharedFields,
  changes: Schema.Array(Schema.NonEmptyString)
}).check(executableCheck)

/**
 * Renders the sentinel argv token for one tool reference.
 *
 * The token is inert text: the plan-time body records it in the exec payload,
 * and the package executor replaces it with the resolved absolute executable
 * path immediately before spawn. The resolution — path, package version, or
 * host probe output — is key material at that point; the token itself never
 * reaches a spawned process.
 *
 * @category tokens
 * @since 0.1.0
 */
export const toolToken = (tool: Reference.Tool): string => `{smthrs:tool:${JSON.stringify(tool)}}`

/**
 * The sentinel argv token for a build target used as a tool edge,
 * `bin: sdk.buildCli`.
 *
 * A target cannot be serialized into a token the way a reference can, and it
 * does not have to be: a declaration names exactly one `bin`, so the planner
 * knows which dependency the token stands for and substitutes the executable
 * that target declares it produces.
 *
 * @category tokens
 * @since 0.1.0
 */
export const targetBinToken = "{smthrs:target-bin}"

/**
 * The sentinel argv token for a workspace flag reference, `S.Flags.<name>`.
 *
 * @category tokens
 * @since 0.1.0
 */
export const flagToken = (name: string): string => `{smthrs:flag:${name}}`

/**
 * The sentinel argv token for the bun binary that runs `bun:` templates.
 *
 * @category tokens
 * @since 0.1.0
 */
export const bunToken = "{smthrs:bun}"

/**
 * The sentinel argv token for the generated bun template program file.
 *
 * @category tokens
 * @since 0.1.0
 */
export const bunProgramToken = "{smthrs:bun-program}"

/**
 * The sentinel argv token for a package-relative generator script path.
 *
 * @category tokens
 * @since 0.1.0
 */
export const scriptToken = (path: string): string => `${Exec.scriptTokenPrefix}${path}}`

/**
 * The argv[0] a declared `script` runs under, chosen from its extension.
 *
 * A repository writes generator and harness scripts in both dialects — the
 * design corpus has `.sh` scripts on `S.Shell.*` and on `S.Generate`, and
 * `.mjs` scripts on `S.Generate` — and the same file must spawn the same way
 * under either rule. A shell script runs under `/bin/sh`; anything else runs
 * under the workspace runtime, which is what a JavaScript generator needs.
 *
 * @category tokens
 * @since 0.1.0
 */
export const scriptInterpreterToken = (path: string): string =>
  /\.(?:sh|bash)$/.test(path) ? "/bin/sh" : Exec.runtimeBinToken

/**
 * Wall-clock bound for one build-system tool process.
 *
 * Package-mode targets include multi-minute compiles (tsc, relay-compiler
 * over a production tree), so the bound is deliberately far above the
 * ten-minute exec default.
 *
 * @category constants
 * @since 0.1.0
 */
export const packageExecTimeoutMs = 30 * 60 * 1000

/**
 * Parses a {@link Duration} to milliseconds. Unrecognized text uses the
 * package execution default.
 *
 * @category utilities
 * @since 0.1.0
 */
export const durationMs = (text: string): number => parsedDurationMs(text) ?? packageExecTimeoutMs

/**
 * The attr fields {@link execPayload} reads. Every Shell flavor and the
 * Generate bin form share this shape.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecAttrs {
  readonly bin?: Reference.Tool | Target.AnyTarget | undefined
  readonly bun?: string | undefined
  readonly shell?: string | undefined
  readonly script?: Input.File | undefined
  readonly using?: Readonly<Record<string, Reference.Tool>> | undefined
  readonly tools?: ReadonlyArray<Reference.Tool> | undefined
  readonly args?: ReadonlyArray<string | Reference.FlagRef> | undefined
  readonly runtimeArgs?: ReadonlyArray<string> | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly timeout?: string | undefined
  readonly secrets?: ReadonlyArray<Secret.HttpCredential> | undefined
}

const resolveArgs = (args: ReadonlyArray<string | Reference.FlagRef> | undefined): Array<string> =>
  (args ?? []).map((entry) => typeof entry === "string" ? entry : flagToken(entry.name))

/**
 * Builds the canonical exec payload one shell-shaped declaration plans.
 *
 * The same builder backs the target's plan-time body and the package
 * executor's spawn, so the two can never drift: the executor takes this
 * payload, substitutes the sentinel tokens with resolved tool paths, applies
 * the sandbox wrapper, and hands the result to the shared exec
 * implementation.
 *
 * - `shell` runs through `/bin/sh -c`, so the declared text keeps its
 *   shell semantics (`$TMPDIR` expansion, globs).
 * - `bun` templates run as `bun <generated program>`; the program file is
 *   generated by the executor from the resolved `using` tools plus the
 *   template text.
 * - `bin` spawns the referenced tool directly; `runtimeArgs` are runtime
 *   flags, so a non-runtime `bin` with `runtimeArgs` runs under the
 *   workspace runtime binary.
 *
 * @category constructors
 * @since 0.1.0
 */
export const execPayload = (attrs: ExecAttrs): Exec.CallPayload => {
  if (attrs.bin !== undefined || attrs.bun !== undefined || attrs.shell !== undefined || attrs.script !== undefined) {
    const issue = executableIssue(attrs)
    if (issue !== undefined) throw new TypeError(issue)
  }
  const environment = attrs.env === undefined ? {} : { ...attrs.env }
  const args = resolveArgs(attrs.args)
  let argv: [string, ...Array<string>]
  if (attrs.shell !== undefined) {
    argv = ["/bin/sh", "-c", attrs.shell]
  } else if (attrs.script !== undefined) {
    argv = [scriptInterpreterToken(attrs.script.path), scriptToken(attrs.script.path), ...args]
  } else if (attrs.bun !== undefined) {
    argv = [bunToken, bunProgramToken]
  } else if (attrs.bin !== undefined) {
    const runtimeArgs = attrs.runtimeArgs ?? []
    // A build target as the tool edge is never a JavaScript runtime, so it
    // never takes runtime flags; it is the program itself. Running it under
    // the workspace runtime would spawn the wrong program and dropping the
    // flags would spawn the right one with a different argv, so the
    // declaration is rejected instead.
    if (Target.isTarget(attrs.bin)) {
      if (runtimeArgs.length > 0) {
        throw new Error(
          "a shell declaration whose bin is a build target cannot take runtimeArgs; " +
            "they are flags for a JavaScript runtime the built binary is not"
        )
      }
      argv = [targetBinToken, ...args]
    } else if (attrs.bin._tag === "RuntimeBin") {
      argv = [toolToken(attrs.bin), ...runtimeArgs, ...args]
    } else if (runtimeArgs.length > 0) {
      argv = [toolToken(Reference.runtimeBin), ...runtimeArgs, toolToken(attrs.bin), ...args]
    } else {
      argv = [toolToken(attrs.bin), ...args]
    }
  } else {
    throw new Error("shell declaration names no executable")
  }
  return {
    cwd: ".",
    argv,
    env: environment,
    timeoutMs: attrs.timeout === undefined ? packageExecTimeoutMs : durationMs(attrs.timeout)
  }
}

/** Plans the shared exec node for one shell-shaped declaration. */
const planExec = (attrs: ExecAttrs) =>
  Exec.runTool({
    ...execPayload(attrs),
    secrets: attrs.secrets === undefined ? [] : [...attrs.secrets]
  })

const buildDefinition = Target.make("Shell.Build", {
  attrs: BuildAttrs,
  hosts: (attrs) => attrs.hosts,
  success: Exec.Result,
  error: Exec.ExecError,
  kinds: ["build"],
  implementation: (attrs) => planExec(attrs)
})

const testDefinition = Target.make("Shell.Test", {
  attrs: TestAttrs,
  hosts: (attrs) => attrs.hosts,
  success: Exec.Result,
  error: Exec.ExecError,
  kinds: ["test"],
  implementation: (attrs) => planExec(attrs)
})

const runDefinition = Target.make("Shell.Run", {
  attrs: RunAttrs,
  manual: (attrs) => attrs.manual === true,
  hosts: (attrs) => attrs.hosts,
  success: Exec.Result,
  error: Exec.ExecError,
  kinds: ["run"],
  implementation: (attrs) => planExec(attrs)
})

const serveDefinition = Target.make("Shell.Serve", {
  attrs: ServeAttrs,
  hosts: (attrs) => attrs.hosts,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Shell.Serve")
})

const diffDefinition = Target.make("Shell.Diff", {
  attrs: DiffAttrs,
  hosts: (attrs) => attrs.hosts,
  success: Exec.Result,
  error: Exec.ExecError,
  kinds: ["run", "lint"],
  implementation: (attrs) => planExec(attrs)
})

/**
 * Exactly one executable selector and only the options that selector consumes.
 * @category models
 * @since 0.1.0
 */
export type Executable =
  | {
    readonly shell: string
    readonly bin?: never
    readonly bun?: never
    readonly script?: never
    readonly args?: never
    readonly runtimeArgs?: never
    readonly using?: never
  }
  | {
    readonly bin: NonNullable<ExecAttrs["bin"]>
    readonly shell?: never
    readonly bun?: never
    readonly script?: never
    readonly using?: never
  }
  | {
    readonly script: Input.File
    readonly shell?: never
    readonly bin?: never
    readonly bun?: never
    readonly runtimeArgs?: never
    readonly using?: never
  }
  | {
    readonly bun: string
    readonly shell?: never
    readonly bin?: never
    readonly script?: never
    readonly args?: never
    readonly runtimeArgs?: never
  }

const exclusive = <D extends (attrs: never) => unknown>(
  definition: D
): Pick<D, keyof D> & ((attrs: Parameters<D>[0] & Executable) => ReturnType<D>) =>
  definition as Pick<D, keyof D> & ((attrs: Parameters<D>[0] & Executable) => ReturnType<D>)

/**
 * A tool run producing the declared output directories.
 *
 * @category targets
 * @since 0.1.0
 */
export const Build = exclusive(buildDefinition)

/**
 * A tool run whose exit status is the test verdict.
 *
 * @category targets
 * @since 0.1.0
 */
export const Test = exclusive(testDefinition)

/**
 * A tool run executed only when named explicitly.
 *
 * @category targets
 * @since 0.1.0
 */
export const Run = exclusive(runDefinition)

/**
 * A scoped long-running service with the readiness/health/stop probe
 * contract.
 *
 * @category targets
 * @since 0.1.0
 */
export const Serve = exclusive(serveDefinition)

/**
 * A tool run whose writes are mechanically confined to the declared
 * `changes` write-set; check mode diffs, write mode applies.
 *
 * @category targets
 * @since 0.1.0
 */
export const Diff = exclusive(diffDefinition)
