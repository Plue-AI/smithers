/**
 * Package dependency declaration checks.
 *
 * @since 0.1.0
 */

import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"
import * as Runtime from "./Runtime.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link DepsLint}.
 *
 * `cwd` is the workspace-relative package directory the tool runs in and
 * defaults to the workspace root. Both tools read the manifest from `cwd`,
 * so `packageJson` and `sources` are declared key material.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  runtime: Schema.optional(Runtime.Runtime),
  packageManager: Schema.optional(PackageManager.PackageManager),
  packageJson: Input.File,
  sources: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  tool: Schema.Literals(["knip", "depcheck"]),
  ignoreDependencies: Schema.Array(Schema.NonEmptyString),
  ignoreBinaries: Schema.Array(Schema.NonEmptyString),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link DepsLint}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * The `node -e` program that materializes the generated knip configuration.
 * It creates the parent directory of the path in `argv[1]` and writes the
 * JSON text in `argv[2]` to it.
 */
const writeProgram = [
  "const fs=require(\"node:fs\");",
  "const path=require(\"node:path\");",
  "fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true});",
  "fs.writeFileSync(process.argv[1],process.argv[2]);"
].join("")

/**
 * Builds the generated knip configuration from the declared ignore lists,
 * with keys in a fixed order so equal attrs always produce equal JSON.
 */
const knipConfig = (attrs: Attrs): string => {
  const config: Record<string, ReadonlyArray<string>> = {}
  if (attrs.ignoreBinaries.length > 0) config["ignoreBinaries"] = attrs.ignoreBinaries
  if (attrs.ignoreDependencies.length > 0) config["ignoreDependencies"] = attrs.ignoreDependencies
  return JSON.stringify(config)
}

/**
 * Deterministic SHA-256 hex fingerprint naming the generated knip
 * configuration file, so distinct ignore sets sharing one `cwd` never race on
 * one path.
 *
 * The 32-bit FNV-1a this replaced had real collisions: two ordinary ignore
 * lists could name one file, and whichever target wrote last decided the
 * configuration the other one was judged under.
 */
const fingerprint = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

/**
 * Plans missing, unused, and undeclared dependency checks.
 *
 * For `depcheck` the body records one {@link Exec.Exec} run from `cwd` with
 * both ignore lists forwarded as `--ignores`, following tevm's `lint:deps`
 * scripts. Knip runs with `--dependencies`, so this dependency target does not
 * accidentally turn unused files or exports into additional gates. Knip
 * accepts ignores only through configuration, so when either list is non-empty
 * the plan first writes a derived knip config under the resolved workspace
 * cache directory and passes it to knip with `--config`, replacing ambient
 * knip configuration; with no ignores knip runs under its own config discovery.
 * The plan uses {@link Exec.cacheDirectoryToken}; the
 * exec layer substitutes the resolved host path immediately before spawn, so
 * the directory stays out of attrs and every step key.
 * Tools resolve through `pnpm exec`, matching the pnpm workspace install
 * target. Key material contains package.json and source digests, dependency
 * target keys, selected tool, and ignore lists. Executing the plan requires
 * {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const DepsLint = Target.make("DepsLint", {
  attrs: Attrs,
  workspaceAttrs: ["packageManager", "runtime"],
  kinds: ["lint"],
  success: Exec.Result,
  error: Exec.ExecError,
  implementation: (attrs) => {
    if (attrs.tool === "depcheck") {
      const ignores = [...new Set([...attrs.ignoreDependencies, ...attrs.ignoreBinaries])]
      return Exec.runTool({
        cwd: attrs.cwd,
        argv: PackageManager.exec(attrs.packageManager, [
          "depcheck",
          ...(ignores.length === 0 ? [] : [`--ignores=${ignores.join(",")}`])
        ])
      })
    }
    if (attrs.ignoreDependencies.length === 0 && attrs.ignoreBinaries.length === 0) {
      return Exec.runTool({
        cwd: attrs.cwd,
        argv: PackageManager.exec(attrs.packageManager, ["knip", "--dependencies"])
      })
    }
    const config = knipConfig(attrs)
    const configPath = `${Exec.cacheDirectoryToken}/knip-${fingerprint(config)}.json`
    return Exec.runTool({
      cwd: ".",
      argv: Runtime.evaluate(attrs.runtime, writeProgram, [configPath, config])
    }).pipe(
      Node.bindPlanned((written) =>
        Exec.runTool({
          cwd: attrs.cwd,
          argv: PackageManager.exec(attrs.packageManager, ["knip", "--dependencies", "--config", configPath]),
          after: written
        })
      )
    )
  }
})
