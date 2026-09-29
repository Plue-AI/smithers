/**
 * Adapts the core rules still planned in PackageExec to the rule contract.
 * Native lane rules must be selected where their payload is constructed.
 *
 * @since 1.0.0
 */

import type * as Rule from "./RuleContract.ts"

const nativeLanes = {
  "Fetch": true,
  "Shell.Serve": true,
  "Docker.Serve": true,
  "Docker.Service": true,
  "Docker.Push": true,
  "Anvil.Fork": true,
  "ImportClosure": true,
  "Test": true,
  "Bundler.Rspack.resolve": true,
  "Bundler.Rspack.build": true,
  "Agent.Lint": true,
  "Agent.Diff": true,
  "Agent.Pr": true,
  "Docs.Page": true,
  "Docs.Check": true,
  "Git.Commit": true,
  "Github.CiGen": true,
  "Github.Setup": true,
  "Github.Workflow": true,
  "Github.Pr": true,
  "Npm.Pack": true,
  "Copy": true,
  "Literal": true,
  "Git.Submodules": true,
  "Git.Submodule": true,
  "Changesets.Version": true,
  "Size.Budgets": true,
  "Markdown.CodeBlocks": true,
  "Npm.Published": true,
  "Api.Compat": true,
  "Overlay": true,
  "Cron": true,
  "Npm.Downstream": true,
  "Npm.Publish": true,
  "Changesets.Publish": true,
  "Github.Release": true,
  "Github.Pages": true,
  "Git.Pr": true,
  "Memory.Retain": true,
  "Cargo.Fetch": true,
  "Cargo.Build": true,
  "Cargo.Test": true,
  "Cargo.Nextest": true,
  "Cargo.Clippy": true,
  "Cargo.Deny": true,
  "Cargo.Fmt": true,
  "Cargo.Doc": true,
  "Repo.Target": true
} satisfies Record<Exclude<Rule.Selection, { readonly lane: undefined }>["rule"], true>
const laneRules: ReadonlySet<string> = new Set(Object.keys(nativeLanes))

/** Narrows an already resolved command at the planner boundary.
 * @category planning
 * @since 1.0.0
 */
export const argvOf = (argv: ReadonlyArray<string> | undefined): Rule.Argv | undefined =>
  argv === undefined || argv.length === 0 ? undefined : [argv[0]!, ...argv.slice(1)]

/** Selects only the core rules whose payload remains in shared node fields.
 * A missing executable leaves a refusal for the centralized planner to report.
 * Unknown declaration names use the explicit body boundary; native names cannot.
 * @category planning
 * @since 1.0.0
 */
export const select = (rule: string, command: ReadonlyArray<string> | undefined): Rule.Selection | undefined => {
  const argv = argvOf(command)
  switch (rule) {
    case "Shell.Build":
    case "Shell.Test":
    case "Shell.Run":
    case "Shell.Diff":
      return argv === undefined ? undefined : { family: "process", rule, lane: undefined, argv }
    case "Go.Binary":
    case "Go.ModDownload":
    case "Go.Test":
    case "Go.Fuzz":
    case "Go.Lint":
    case "Go.Generate":
    case "Foundry.Build":
    case "Foundry.Test":
    case "Foundry.Fmt":
      return argv === undefined ? undefined : { family: "language", rule, lane: undefined, argv }
    case "Docker.Build":
    case "Docker.Bake":
      return argv === undefined ? undefined : { family: "container", rule, lane: undefined, argv }
    case "Generate":
    case "Owners.Codeowners":
    case "Owners.Tree":
      return { family: "generated", rule, lane: undefined }
    case "Filegroup":
    case "Cargo.AppSet":
    case "Go.Packages":
    case "Suite":
    case "Alias":
    case "Materialize":
    case "Clean":
    case "Install":
      return { family: "value", rule, lane: undefined }
    default:
      if (laneRules.has(rule)) throw new TypeError(`${rule} requires its native planned payload`)
      return { family: "body", rule: rule as Rule.BodyRuleName, lane: undefined }
  }
}
