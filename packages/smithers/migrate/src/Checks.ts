/**
 * The deterministic checks that run after a unit is transformed and before it
 * is accepted.
 *
 * These are the parts of the migration contract a machine can settle. The
 * prompt tells the agent not to recreate the JSX runtime, not to embed a
 * scheduler, not to hide an untranslatable construct behind `any`, and not to
 * touch run state. A prompt is a request; these checks are the enforcement, and
 * a failed check fails the round exactly as a failed test does.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { createHash } from "node:crypto"
import * as ts from "typescript/unstable/ast"
import * as Detect from "./Detect.ts"
import * as Fs from "./internal/Fs.ts"
import * as Ts from "./internal/Ts.ts"
import { io, type MigrateError } from "./MigrateError.ts"
import type { UnitPlan } from "./Units.ts"

/**
 * One check's verdict.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface CheckResult {
  readonly name: string
  readonly ok: boolean
  readonly findings: ReadonlyArray<{ readonly file: string; readonly line: number; readonly message: string }>
}

/**
 * What the unit looked like at its checkpoint: the text of the files it was
 * allowed to change, and a digest of every run-state path it was not.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface CheckpointFiles {
  /** Project-relative path to file text at the checkpoint. */
  readonly sources: ReadonlyMap<string, string>
  /**
   * Path to sha256 at the checkpoint, for run-state paths. Project-relative,
   * except gateway state, which lives outside the project and is keyed by its
   * absolute path and read from there.
   */
  readonly digests: ReadonlyMap<string, string>
  /**
   * Every directory that holds 0.x run state: the state directories, and the
   * parent of each database file and gateway state file. Project-relative,
   * except a gateway state directory, which is absolute.
   *
   * `digests` alone cannot prove run state is untouched, because it holds only
   * the paths that existed when the checkpoint was taken. A file written into
   * one of these directories afterwards is a write to run state that no digest
   * covers, so the check walks these roots and compares the file sets both
   * ways.
   */
  readonly runStateRoots?: ReadonlyArray<string> | undefined
  /**
   * The unit's own declared sources and targets.
   *
   * A run-state root is a directory, and 0.x keeps configuration and
   * workflow sources in the same directory as its run state
   * (`.smithers/smithers.config.ts` beside `.smithers/smithers.db`). A file
   * the unit was planned to rewrite or archive is the unit's, wherever it
   * sits, so it is left out of the byte-identity check. The exact run-state
   * paths are never sources: the scanner does not read them and the archive
   * refuses to move them.
   */
  readonly owned?: ReadonlyArray<string> | undefined
}

/**
 * The one constructor registry discovery accepts on a default export.
 *
 * `@smthrs/registry`'s `internal/ModuleMetadata.ts` tokenizes the module text
 * and requires the literal tokens `export default Flow . make (`. Nothing else
 * is discovered, so nothing else counts here: a description on a `Widget.make`,
 * on a bare `make`, or on a namespace alias is a description no registry ever
 * reads.
 */
const descriptorConstructor = "Flow.make"

/**
 * The options object of the default-exported flow declaration, when the module
 * has one in the shape discovery accepts.
 *
 * The object is looked for among the arguments rather than at a fixed index:
 * `@smthrs/flow`'s `Flow.make("tag", { ... })`, which a migrated
 * `flows/<name>/flow.ts` default-exports, names its tag first, and discovery
 * reads the declaration data out of the object wherever it sits.
 */
const defaultDescriptor = (source: ts.SourceFile): ts.ObjectLiteralExpression | undefined => {
  for (const statement of source.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals === true) continue
    const call = statement.expression
    if (!ts.isCallExpression(call)) continue
    if (Ts.calleeName(call) !== descriptorConstructor) continue
    const options = call.arguments.find((argument) => ts.isObjectLiteralExpression(argument))
    if (options !== undefined) return options
  }
  return undefined
}

/** The initializer of one property of an object literal, by name. */
const property = (options: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
  for (const member of options.properties) {
    if (!ts.isPropertyAssignment(member) || member.name === undefined) continue
    if (member.name.getText() === name) return member.initializer
  }
  return undefined
}

/**
 * Whether a flow module declares the description the registry reads.
 *
 * Parsed, not matched: `// description: "x"` satisfies a regular expression and
 * declares nothing, and a flow the registry will not list is a flow nobody can
 * run.
 */
const declaresDescription = (file: string, text: string): boolean => {
  const options = defaultDescriptor(Ts.parse(file, text))
  if (options === undefined) return false
  const value = property(options, "description")
  if (value === undefined) return false
  return (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) && value.text.trim() !== ""
}

/**
 * One durable flow a module declares: `export const X = <Flow>.make("<tag>", {
 * payload, success, body })`.
 *
 * The tag and the `body` are what separate a durable flow from an action:
 * `AgentAction.make("tag", { prompt })` also takes a tag, and carries no body.
 */
interface DeclaredFlow {
  readonly name: string
  readonly payload: string | undefined
  readonly success: string | undefined
}

/** A schema expression with its formatting removed, for comparison. */
const schemaText = (value: ts.Expression | undefined): string | undefined => {
  if (value === undefined) return undefined
  const text = value.getText().replaceAll(/\s+/g, " ").trim()
  // `Flow.make` takes struct FIELDS or a schema: `{ topic: Schema.String }`
  // and `Schema.Struct({ topic: Schema.String })` are one contract written
  // two ways, so both spell the same comparison key.
  return text.startsWith("{") ? `Schema.Struct(${text})` : text
}

const declaredFlows = (source: ts.SourceFile): ReadonlyArray<DeclaredFlow> => {
  const flows: Array<DeclaredFlow> = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      const call = declaration.initializer
      if (call === undefined || !ts.isCallExpression(call)) continue
      if (!Ts.calleeName(call).endsWith("make")) continue
      const [tag, options] = call.arguments
      if (tag === undefined || !(ts.isStringLiteral(tag) || ts.isNoSubstitutionTemplateLiteral(tag))) continue
      if (options === undefined || !ts.isObjectLiteralExpression(options)) continue
      if (property(options, "body") === undefined) continue
      if (!ts.isIdentifier(declaration.name)) continue
      flows.push({
        name: declaration.name.text,
        payload: schemaText(property(options, "payload")),
        success: schemaText(property(options, "success"))
      })
    }
  }
  return flows
}

/** The `X` of an arrow function whose whole body is `X.call(...)`. */
const delegateTarget = (value: ts.Expression): string | undefined => {
  if (!ts.isArrowFunction(value)) return undefined
  const body = ts.isBlock(value.body)
    ? value.body.statements.length === 1 && ts.isReturnStatement(value.body.statements[0]!)
      ? value.body.statements[0].expression
      : undefined
    : value.body
  if (body === undefined || !ts.isCallExpression(body)) return undefined
  const callee = body.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined
  return callee.name.text === "call" || callee.name.text === "child" ? callee.expression.text : undefined
}

/**
 * Whether the descriptor the registry admits describes the flow the engine
 * runs.
 *
 * A migrated module default-exports the flow itself, body and all, which is
 * what the tool emits and what this check wants to see: one declaration, so
 * the contract the control plane admits is the one that runs.
 *
 * Discovery reads the default export and never a named one, so the two ways a
 * module can still admit one thing and run another are both refused here. A
 * default export that names a durable flow the module declares beside it has
 * to reach it, by `body`; one that names nothing has to carry its own
 * behavior, or calling it fails with `missing_body` and nothing runs.
 */
const describesTheFlowItDeclares = (
  file: string,
  text: string
): ReadonlyArray<{ file: string; line: number; message: string }> => {
  const source = Ts.parse(file, text)
  const options = defaultDescriptor(source)
  // A module with no descriptor at all is already reported by the description
  // check; saying it twice would only hide which contract it broke.
  if (options === undefined) return []
  const line = Fs.positionAt(text, options.getStart(source)).line
  const flows = declaredFlows(source)
  const body = property(options, "body")
  if (flows.length === 0) {
    // A descriptor that declares a `model`, or the one flow it delegates to,
    // runs on the registry's `agent` delegate
    // (`@smthrs/registry`'s `Executable.ts` `delegateFor`), so it is executable
    // without a body of its own.
    const executable = body !== undefined ||
      property(options, "model") !== undefined ||
      property(options, "flows") !== undefined
    return executable ? [] : [{
      file,
      line,
      message: "the default descriptor declares no flow and no `body`, so calling it fails with `missing_body`"
    }]
  }
  if (body !== undefined) {
    const target = delegateTarget(body)
    return target !== undefined && flows.some((flow) => flow.name === target) ? [] : [{
      file,
      line,
      message: `the default descriptor's body does not call ${
        flows.map((flow) => flow.name).join(" or ")
      }, the flow this module declares`
    }]
  }
  const input = schemaText(property(options, "input"))
  const output = schemaText(property(options, "output"))
  const matched = flows.filter((flow) =>
    (flow.payload === undefined || flow.payload === input) && (flow.success === undefined || flow.success === output)
  )
  return matched.length > 0 ? [] : [{
    file,
    line,
    message: `the default descriptor admits ${input ?? "no input"} to ${output ?? "no output"}, which none of ${
      flows.map((flow) => flow.name).join(", ")
    } declares`
  }]
}

/**
 * A `TODO(migrate-smithers-v1)` marker is only allowed when the report names
 * the construct. This is what the checks compare against.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ReportedEntry {
  readonly construct: string
  readonly file: string
}

/**
 * The marker the migration leaves where a construct has no translation.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const marker = "TODO(migrate-smithers-v1)"

const reactImport = /from\s+["'](react|react-dom)(?:\/[^"']*)?["']/g

/**
 * The escape hatches the contract forbids, one pattern per kind.
 *
 * They are counted per kind rather than in aggregate. A unit that deletes an
 * `as any` and adds a `@ts-ignore` on the next line leaves the total unchanged
 * while hiding exactly what the contract says it must report.
 */
const escapeHatches: ReadonlyArray<readonly [string, RegExp]> = [
  ["as any", /\bas\s+any\b/g],
  ["as unknown as", /\bas\s+unknown\s+as\b/g],
  ["@ts-ignore", /@ts-ignore\b/g],
  ["@ts-expect-error", /@ts-expect-error\b/g]
]

const sqliteAccess =
  /new\s+Database\s*\(|from\s+["'](?:bun:sqlite|node:sqlite)["']|require\(["'](?:bun:sqlite|node:sqlite)["']\)/g

const schedulerLoop = /setInterval\s*\(|while\s*\(\s*(?:true|1)\s*\)/g

const jsxPragma = /@jsx(?:ImportSource|Runtime)\b/g

const seatLiteral = /\bseat\s*:\s*["'`]([^"'`]+)["'`]/g

const findAll = (
  file: string,
  text: string,
  pattern: RegExp,
  message: (match: string) => string
): ReadonlyArray<{ file: string; line: number; message: string }> => {
  const regexp = new RegExp(pattern.source, pattern.flags)
  const findings: Array<{ file: string; line: number; message: string }> = []
  let match = regexp.exec(text)
  while (match !== null) {
    findings.push({ file, line: Fs.positionAt(text, match.index).line, message: message(match[0]) })
    match = regexp.exec(text)
  }
  return findings
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/**
 * Runs every deterministic check for one unit.
 *
 * `changedFiles` is what the unit says it changed; `checkpointFiles` is what
 * those files looked like before it did. Checks that ask whether something was
 * *introduced* compare the two, so a project that already had an `as any` in a
 * file the unit touched does not fail a migration that did not add one. The
 * checkpoint text is also what a seat literal is checked against, so pass the
 * unit's old sources even when no check needs a before-and-after count.
 *
 * `decisions` is the text of the operator decisions this unit recorded. A seat
 * an operator chose is allowed; a seat nobody chose and no source named is not.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const run = (
  root: string,
  unit: UnitPlan,
  changedFiles: ReadonlyArray<string>,
  checkpointFiles: CheckpointFiles,
  reported: ReadonlyArray<ReportedEntry> = [],
  decisions: ReadonlyArray<string> = []
): Effect.Effect<ReadonlyArray<CheckResult>, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    const absolute = (file: string): string => path.join(root, ...file.split("/"))
    const flowsDir = unit.verification.discovery.flowsDir
    const specifierContext = unit.specifiers

    const texts = new Map<string, string>()
    for (const file of changedFiles) {
      const text = yield* Fs.readOption(absolute(file))
      if (text !== undefined) texts.set(file, text)
    }

    const inFlows = (file: string): boolean => file === flowsDir || file.startsWith(`${flowsDir}/`)
    const isSource = /\.(ts|tsx|js|jsx|mjs|mts|cjs|cts)$/

    const results: Array<CheckResult> = []
    const check = (
      name: string,
      findings: ReadonlyArray<{ file: string; line: number; message: string }>
    ): void => {
      results.push({ name, ok: findings.length === 0, findings })
    }

    check(
      "no old import remains",
      [...texts].flatMap(([file, text]) => {
        if (!isSource.test(file)) return []
        return Ts.moduleSpecifiers(Ts.parse(file, text))
          .filter((record) => Detect.isOldSpecifier(record.specifier, specifierContext))
          .map((record) => ({
            file,
            line: record.line,
            message: `${record.form} "${record.specifier}" still reaches the 0.x facade`
          }))
      })
    )

    check(
      "no JSX pragma remains",
      [...texts].flatMap(([file, text]) =>
        isSource.test(file) ? findAll(file, text, jsxPragma, (match) => `${match} has no JSX runtime to point at`) : []
      )
    )

    check(
      "no react import under the flows directory",
      [...texts].flatMap(([file, text]) =>
        inFlows(file) && isSource.test(file)
          ? findAll(file, text, reactImport, (match) => `${match.trim()} does not belong in a flow`)
          : []
      )
    )

    check(
      "no escape hatch introduced",
      [...texts].flatMap(([file, text]) => {
        if (!isSource.test(file)) return []
        const before = checkpointFiles.sources.get(file) ?? ""
        // Per kind, so swapping one hatch for another is caught: only the
        // occurrences of a kind beyond what the file already carried are new.
        return escapeHatches.flatMap(([kind, pattern]) => {
          const beforeCount = (before.match(new RegExp(pattern.source, pattern.flags)) ?? []).length
          const found = findAll(file, text, pattern, () => `${kind} hides a construct instead of reporting it`)
          return found.slice(beforeCount)
        }).sort((left, right) => left.line - right.line)
      })
    )

    check(
      "no scheduler loop under the flows directory",
      [...texts].flatMap(([file, text]) =>
        inFlows(file) && isSource.test(file)
          ? findAll(file, text, schedulerLoop, (match) => `${match.trim()} is a run loop; the engine owns scheduling`)
          : []
      )
    )

    check(
      "no direct database access under the flows directory",
      [...texts].flatMap(([file, text]) =>
        inFlows(file) && isSource.test(file)
          ? findAll(file, text, sqliteAccess, (match) => `${match.trim()} opens storage the host owns`)
          : []
      )
    )

    // Amendment 4 and 5: there is no default seat. Every seat a migrated file
    // names has to come from the model the old source named, or from a
    // decision the operator answered. A seat that comes from neither is an
    // invented model id, which is the one thing a migration must never ship.
    const sourceText = [...checkpointFiles.sources.values()].join("\n")
    check(
      "every seat comes from the source or from a decision",
      [...texts].flatMap(([file, text]) => {
        if (!isSource.test(file)) return []
        const regexp = new RegExp(seatLiteral.source, seatLiteral.flags)
        const findings: Array<{ file: string; line: number; message: string }> = []
        let match = regexp.exec(text)
        while (match !== null) {
          const seat = match[1] ?? ""
          const model = seat.includes(":") ? seat.slice(seat.indexOf(":") + 1) : seat
          // The model has to appear as a string the old source wrote, not as a
          // substring of prose: a seat `openai:gpt` is not justified by the
          // word "gpt" in a comment or a prompt sentence.
          const quoted = [`"${model}"`, `'${model}'`, `\`${model}\``, `("${model}")`, `('${model}')`]
          const justified = quoted.some((token) => sourceText.includes(token)) ||
            decisions.some((answer) => answer.includes(seat))
          if (!justified) {
            findings.push({
              file,
              line: Fs.positionAt(text, match.index).line,
              message: `seat "${seat}" names a model that is in neither the unit's source nor a recorded decision`
            })
          }
          match = regexp.exec(text)
        }
        return findings
      })
    )

    const flowModules = changedFiles.filter((file) => inFlows(file) && file.endsWith("/flow.ts"))
    check(
      "every flow module declares a description",
      flowModules.flatMap((file) => {
        const text = texts.get(file) ?? ""
        return declaresDescription(file, text)
          ? []
          : [{
            file,
            line: 1,
            message:
              "the registry needs `export default Flow.make(\"<tag>\", { description: \"...\" })` with a string literal to discover this flow"
          }]
      })
    )

    check(
      "every flow module's descriptor describes the flow it declares",
      flowModules.flatMap((file) => describesTheFlowItDeclares(file, texts.get(file) ?? ""))
    )

    const reportedFiles = new Set(reported.map((entry) => `${entry.file}::${entry.construct}`))
    check(
      "every TODO marker is reported",
      [...texts].flatMap(([file, text]) =>
        findAll(file, text, new RegExp(`${marker.replace(/[()]/g, "\\$&")}:?\\s*([^\\n]*)`, "g"), (match) => match)
          .flatMap((finding) => {
            const construct = finding.message.slice(marker.length).replace(/^:\s*/, "").trim()
            return reportedFiles.has(`${file}::${construct}`)
              ? []
              : [{
                ...finding,
                message: `${marker} for "${construct}" has no unresolved or unsupported report entry`
              }]
          })
      )
    )

    results.push(yield* runState(root, checkpointFiles))

    return results
  })

/**
 * Whether every 0.x run-state path holds exactly the bytes the checkpoint
 * recorded, and no run-state root has gained a file since.
 *
 * On its own because it is asked twice: once with the other checks, before
 * the archive, and once more over the final tree, after the archive and the
 * final verification have run their own commands.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const runState = (
  root: string,
  checkpointFiles: CheckpointFiles
): Effect.Effect<CheckResult, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // Gateway state is recorded absolute, because it lives outside the
    // project. It is read where it is; anything else joins under the root.
    const absolute = (file: string): string => path.isAbsolute(file) ? file : path.join(root, ...file.split("/"))
    const owned = new Set(checkpointFiles.owned ?? [])
    const findings: Array<{ file: string; line: number; message: string }> = []
    for (const [file, expected] of checkpointFiles.digests) {
      if (owned.has(file)) continue
      const target = absolute(file)
      // A link was digested by what it names (see Checkpoint.digest), so it is
      // compared the same way and never read through.
      const link = yield* Fs.linkTarget(target)
      if (link === undefined && !(yield* Fs.exists(target))) {
        findings.push({ file, line: 1, message: "run state was removed; the tool must never touch it" })
        continue
      }
      const bytes = link !== undefined
        ? Fs.linkRecord(link)
        : yield* fs.readFile(target).pipe(Effect.mapError(io(`could not read "${file}"`)))
      if (digest(bytes) !== expected) {
        findings.push({ file, line: 1, message: "run state changed; the tool must never write to it" })
      }
    }
    // The other direction: a file that appears under a run-state root after the
    // checkpoint is a write the checkpoint's digest map cannot see, because
    // that map holds only the paths that existed when it was taken.
    for (const runStateRoot of checkpointFiles.runStateRoots ?? []) {
      for (const file of yield* Fs.walkAll(absolute(runStateRoot))) {
        const relative = `${runStateRoot}/${file}`
        if (checkpointFiles.digests.has(relative) || owned.has(relative)) continue
        findings.push({
          file: relative,
          line: 1,
          message: "run state was added; the tool must never write to it"
        })
      }
    }
    return {
      name: "run state is byte-identical",
      ok: findings.length === 0,
      findings: findings.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
    }
  })

/**
 * Scans the project's flows directory with the registry and fails the check on
 * any warning.
 *
 * Discovery is the last word on whether a migrated flow is real: it is the same
 * scan the CLI runs, so a flow that discovery will not list is a flow nobody
 * can run.
 *
 * `@smthrs/registry` is an optional dependency loaded here, not at module load.
 * `scan` and `plan` never call this function, so reading a project costs
 * Effect, the platform layer, and TypeScript, and nothing from the 1.0 runtime.
 *
 * @category checks
 * @since 1.0.0-rc.0
 */
export const discovery = (
  root: string,
  flowsDir = "flows"
): Effect.Effect<CheckResult, MigrateError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const target = path.join(root, ...flowsDir.split("/"))
    if (!(yield* Fs.isDirectory(target))) {
      return {
        name: "registry discovery",
        ok: false,
        findings: [{ file: flowsDir, line: 1, message: "the flows directory does not exist" }]
      }
    }
    const Discovery = yield* Effect.tryPromise({
      try: () => import("@smthrs/registry/Discovery"),
      catch: io("could not load @smthrs/registry; install it to run the discovery check")
    })
    const scan = yield* Discovery.make(fs, path)
      .scan({ source: "project", root: target, naming: "path" })
      .pipe(Effect.mapError((cause) => io(`could not discover flows under "${flowsDir}"`)(cause)))
    return {
      name: "registry discovery",
      ok: scan.warnings.length === 0,
      findings: scan.warnings.map((warning) => ({
        file: path.relative(root, warning.path).split(path.sep).join("/"),
        line: 1,
        message: `${warning.code}: ${warning.message}`
      }))
    }
  })

/**
 * Reports whether every check passed.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const ok = (results: ReadonlyArray<CheckResult>): boolean => results.every((result) => result.ok)
