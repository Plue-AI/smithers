/**
 * The public command-line projection for flows.
 *
 * Every top-level module under `src/` is exported here and is also reachable
 * as `@smthrs/cli/<Module>`. The modules under `src/cli/`, `src/evaluation/`,
 * `src/history/`, `src/operator/`, and `src/suggest/` that `package.json`
 * exports are subpath-only: `@smthrs/cli/<dir>/<Module>` resolves, and no
 * namespace here does. `test/Readme.test.ts` compares `README.md` against
 * both lists: its table against these namespaces and their runtime exports,
 * and its subpath-only section against the nested export map, so a module
 * that reaches one spelling and not the other fails the suite.
 *
 * @since 0.1.0
 */

/**
 * @category agents
 * @since 1.0.0
 */
export * as Agents from "./Agents.ts"
/**
 * @category layers
 * @since 1.0.0
 */
export * as Application from "./Application.ts"
/**
 * @category layers
 * @since 1.0.0
 */
export * as BunControl from "./BunControl.ts"
/**
 * @category reporting
 * @since 1.0.0
 */
export * as Bug from "./Bug.ts"
/**
 * @category protocol
 * @since 1.0.0
 */
export * as ClaudeMirror from "./ClaudeMirror.ts"
/**
 * @category node
 * @since 1.0.0
 */
export * as CloudSession from "./CloudSession.ts"
/**
 * @category errors
 * @since 1.0.0
 */
export * as CliError from "./CliError.ts"
/**
 * @category node
 * @since 1.0.0
 */
export * as CodexAuth from "./CodexAuth.ts"
/**
 * @category commands
 * @since 1.0.0
 */
export * as Command from "./Command.ts"
/**
 * @category presentation
 * @since 1.0.0
 */
export * as Audience from "./Audience.ts"
/**
 * @category execution
 * @since 1.0.0
 */
export * as Detached from "./Detached.ts"
/**
 * @category diagnostics
 * @since 1.0.0
 */
export * as Doctor from "./Doctor.ts"
/**
 * @category configuration
 * @since 1.0.0
 */
export * as Environment from "./Environment.ts"
/**
 * @category execution
 * @since 1.0.0
 */
export * as ExecutorOwnership from "./ExecutorOwnership.ts"
/**
 * @category diagnostics
 * @since 1.0.0
 */
export * as Forensics from "./Forensics.ts"
/**
 * @category retention
 * @since 1.0.0
 */
export * as Gc from "./Gc.ts"
/**
 * @category scaffolding
 * @since 1.0.0
 */
export * as Init from "./Init.ts"
/**
 * @category migration
 * @since 1.0.0
 */
export * as Legacy from "./Legacy.ts"
/**
 * @category node
 * @since 1.0.0
 */
export * as NodeControl from "./NodeControl.ts"
/**
 * @category projections
 * @since 1.0.0
 */
export * as NodeOutput from "./NodeOutput.ts"
/**
 * @category output
 * @since 1.0.0
 */
export * as Output from "./Output.ts"
/**
 * @category project
 * @since 1.0.0
 */
export * as Project from "./Project.ts"
/**
 * @category models
 * @since 1.0.0-rc.0
 */
export * as Providers from "./Providers.ts"
/**
 * @category serve
 * @since 1.0.0
 */
export * as Serve from "./Serve.ts"
/**
 * @category suggestions
 * @since 1.0.0-rc.0
 */
export * as Suggest from "./Suggest.ts"
/**
 * @category output
 * @since 1.0.0-rc.0
 */
export * as Ui from "./Ui.ts"
/**
 * @category refusals
 * @since 1.0.0
 */
export * as Unsupported from "./Unsupported.ts"
/**
 * @category update
 * @since 1.0.0
 */
export * as Update from "./Update.ts"
/**
 * @category models
 * @since 1.0.0
 */
export * as Verb from "./Verb.ts"
/**
 * @category configuration
 * @since 1.0.0
 */
export * as Version from "./Version.ts"
/**
 * @category commands
 * @since 1.0.0
 */
export * as Cli from "./Cli.ts"
