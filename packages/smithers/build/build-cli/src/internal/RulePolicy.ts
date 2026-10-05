/**
 * Package rule policy shared by planning, scheduling, and execution.
 *
 * @since 1.0.0
 */

import type { Mode, PlannedRule, Selection } from "./RuleContract.ts"

interface Policy {
  readonly overlay?: boolean
  readonly check?: boolean
  readonly outward?: boolean
  readonly attended?: boolean
  readonly keyOnly?: boolean
  readonly service?: boolean
  readonly exclusive?: boolean
  readonly writes?: boolean
  readonly cache?: "always" | "read" | "execute" | "check" | "clean-repository"
}

/** Every rule the planner selects natively; declaration bodies are named at runtime. */
type NativeRule = Exclude<Selection, { readonly family: "body" }>["rule"]

/** A row per native rule, so a new or renamed rule fails typecheck until it is stated here.
 * Declaration bodies may add rows; they are looked up through the string index.
 */
const policies: Readonly<Record<NativeRule, Policy>> & Readonly<Record<string, Policy>> = {
  "Agent.Diff": { outward: true, exclusive: true, writes: true },
  "Agent.Lint": { check: true },
  "Agent.Pr": { outward: true, exclusive: true, writes: true },
  "Alias": {},
  "Anvil.Fork": { outward: true, service: true },
  "Api.Compat": { cache: "always" },
  "Bundler.Rspack.build": { writes: true, cache: "always" },
  "Bundler.Rspack.resolve": { cache: "always" },
  "Cargo.AppSet": {},
  "Cargo.Build": { writes: true },
  "Cargo.Clippy": { writes: true, cache: "read" },
  "Cargo.Deny": { writes: true, cache: "read" },
  "Cargo.Doc": { writes: true },
  "Cargo.Fetch": { writes: true },
  "Cargo.Fmt": { check: true, cache: "read" },
  "Cargo.Nextest": { writes: true, cache: "read" },
  "Cargo.Test": { writes: true, cache: "read" },
  "Changesets.Publish": { outward: true },
  "Changesets.Version": { check: true, exclusive: true, writes: true, cache: "check" },
  "CloudRun.Preview": { outward: true },
  "Clean": { outward: true, keyOnly: true, writes: true },
  "Copy": { writes: true, cache: "always" },
  "Cron": { keyOnly: true },
  "Docker.Bake": { writes: true, cache: "always" },
  "Docker.Build": { writes: true, cache: "always" },
  "Docker.Push": { outward: true },
  "Docker.Serve": { outward: true, service: true },
  "Docker.Service": { outward: true, service: true },
  "Docs.Check": { check: true },
  "Docs.Page": { outward: true, attended: true, exclusive: true, writes: true },
  "FactoryProjection": { check: true },
  "Fetch": { writes: true, cache: "always" },
  "Filegroup": {},
  "Foundry.Build": { overlay: true, writes: true, cache: "always" },
  "Foundry.Fmt": { check: true, cache: "check" },
  "Foundry.Test": { overlay: true, cache: "execute" },
  // Scratch checks still census the live ignored tree and restore escaping
  // symlink portals. Keep their snapshots apart from every peer's writes.
  "Generate": { check: true, exclusive: true, cache: "check" },
  "Git.Commit": { outward: true, exclusive: true, writes: true },
  "Git.Pr": { outward: true },
  "Git.Submodule": { writes: true, cache: "always" },
  "Git.Submodules": { writes: true, cache: "always" },
  "Github.CiGen": { check: true, keyOnly: true },
  "Github.Pages": { outward: true },
  "Github.Pr": { outward: true },
  "Github.Release": { outward: true },
  "Github.Setup": { keyOnly: true },
  "Github.Workflow": { keyOnly: true },
  "Go.Binary": { cache: "always" },
  "Go.Fuzz": { cache: "always" },
  "Go.Generate": { check: true, exclusive: true, cache: "check" },
  "Go.Lint": { check: true, exclusive: true, cache: "check" },
  "Go.ModDownload": { cache: "always" },
  "Go.Packages": {},
  "Go.Test": { cache: "always" },
  "ImportClosure": {},
  "Install": {},
  "Literal": { writes: true, cache: "always" },
  "Markdown.CodeBlocks": { cache: "always" },
  "Materialize": { writes: true },
  "Memory.Retain": { outward: true },
  "Npm.Downstream": { cache: "always" },
  "Npm.Pack": { writes: true, cache: "always" },
  "Npm.Publish": { outward: true },
  "Npm.Published": { writes: true, cache: "always" },
  "Overlay": { cache: "always" },
  "Owners.Codeowners": { check: true },
  "Owners.Tree": { check: true },
  "Repo.Target": { cache: "clean-repository" },
  "Shell.Build": { overlay: true, writes: true, cache: "always" },
  "Shell.Diff": { check: true, exclusive: true },
  "Shell.Run": { overlay: true, outward: true },
  "Shell.Serve": { outward: true, service: true },
  "Shell.Test": { overlay: true, cache: "execute" },
  "Size.Budgets": { cache: "always" },
  "Suite": {},
  "TargetIndex": { check: true },
  "Test": { cache: "always" }
}

/** Looks up a rule's intrinsic policy; unknown target bodies keep their declaration policy.
 * @category policies
 * @since 1.0.0
 */
export const of = (rule: string): Policy => policies[rule] ?? {}

/** Whether a native rule adds cacheability beyond its declaration.
 * Cargo builds keep their incremental tree; only checks replay a verdict.
 * @category policies
 * @since 1.0.0
 */
export const cacheable = (rule: string, mode: Mode, repositoryDirty: boolean | undefined): boolean => {
  const cache = of(rule).cache
  return cache === "always" || cache === mode || (cache === "read" && mode !== "write") ||
    (cache === "clean-repository" && repositoryDirty === false)
}

/** Capabilities implied by the rule, invocation mode, and sandbox.
 * @category policies
 * @since 1.0.0
 */
export const capabilities = (rule: string, mode: Mode, sandbox: PlannedRule["sandbox"]): ReadonlyArray<string> => {
  const result = ["fs:read", "proc:spawn"]
  if (mode === "write" || of(rule).writes) result.push("fs:write")
  if (sandbox === "none" || (typeof sandbox === "object" && sandbox.network === true)) result.push("net:open")
  else if (typeof sandbox === "object" && sandbox.network === "loopback") result.push("net:loopback")
  return result
}
