/**
 * Tagged diagnostics for PACKAGE.ts / WORKSPACE.ts routing.
 *
 * Every failure in discovery, loading, and indexing carries one stable code
 * from the routing plan's diagnostic model, the workspace-relative path it
 * concerns when one exists, and — for cycles — the full import chain.
 * Human text renders at the CLI boundary; the code is the contract.
 *
 * @since 0.1.0
 */

import * as Data from "effect/Data"

/**
 * The stable diagnostic codes.
 *
 * The base set is the routing plan's section-10 minimum; `unknown_agent`,
 * `unknown_flag`, and `private_owner_conflict` extend it for index-time
 * reference resolution and private-target owner binding.
 *
 * @category models
 * @since 0.1.0
 */
export type Code =
  | "workspace_root_invalid"
  | "local_repository_invalid"
  | "nested_workspace_undeclared"
  | "inventory_failed"
  | "invalid_inventory_path"
  | "inventory_limit_exceeded"
  | "module_missing"
  | "module_not_regular"
  | "module_outside_workspace"
  | "module_link_collision"
  | "module_too_large"
  | "package_syntax_unsupported"
  | "workspace_syntax_unsupported"
  | "module_compile_failed"
  | "module_import_failed"
  | "declaration_dependency_unresolved"
  | "declaration_dependency_mismatch"
  | "package_import_cycle"
  | "runtime_import_cycle"
  | "unsupported_module_specifier"
  | "package_static_runtime_mismatch"
  | "workspace_export_missing"
  | "workspace_export_duplicate"
  | "factory_export_missing"
  | "factory_export_duplicate"
  | "factory_imports_package"
  | "package_export_missing"
  | "invalid_package_export"
  | "naked_target_export"
  | "invalid_package_options"
  | "invalid_target_key"
  | "invalid_target_value"
  | "invalid_workspace_options"
  | "package_mutated_after_declare"
  | "duplicate_package_path"
  | "case_collision"
  | "duplicate_label"
  | "target_multiple_labels"
  | "unknown_label"
  | "no_default_target"
  | "unknown_agent"
  | "unknown_flag"
  | "unknown_team"
  | "undeclared_host_bin"
  | "illegal_data_target"
  | "private_owner_conflict"
  | "manifest_encode_failed"
  | "manifest_drift"
  | "manifest_write_failed"
  | "watch_refresh_failed"

/**
 * Extra facts one diagnostic may carry.
 *
 * @category models
 * @since 0.1.0
 */
export interface Details {
  readonly path?: string | undefined
  readonly label?: string | undefined
  readonly chain?: ReadonlyArray<string> | undefined
  readonly cause?: unknown
}

/**
 * One routing diagnostic.
 *
 * @category errors
 * @since 0.1.0
 */
export class PackageError extends Data.TaggedError("smithers-build/PackageError")<{
  readonly code: Code
  readonly path: string | undefined
  readonly label: string | undefined
  readonly chain: ReadonlyArray<string> | undefined
  readonly message: string
  readonly cause?: unknown
}> {
  constructor(code: Code, message: string, details: Details = {}) {
    const chain = details.chain === undefined ? "" : ` (chain: ${details.chain.join(" -> ")})`
    const where = details.path === undefined ? "" : ` [${details.path}]`
    super({
      code,
      path: details.path,
      label: details.label,
      chain: details.chain,
      message: `${code}: ${message}${where}${chain}`,
      ...(details.cause === undefined ? {} : { cause: details.cause })
    })
  }
}

/**
 * Checks whether a value is a routing diagnostic.
 *
 * @category guards
 * @since 0.1.0
 */
export const isPackageError = (value: unknown): value is PackageError => value instanceof PackageError
