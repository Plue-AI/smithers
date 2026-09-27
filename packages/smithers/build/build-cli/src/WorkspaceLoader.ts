/**
 * WORKSPACE.ts module validation.
 *
 * The workspace module exports exactly one `Workspace` declaration under the
 * export name `Workspace`. It may import its `.smithers/agents.js` and
 * `.smithers/sandbox.js` siblings and the root Package for git hooks; the
 * relationship is one-way — no Package module may import WORKSPACE.ts, which
 * the loader's static import scan enforces.
 *
 * @since 0.1.0
 */

import * as Package from "@smthrs/targets/Package"
import * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { byCodeUnit } from "./internal/Text.ts"
import { PackageError } from "./PackageError.ts"

/**
 * Validates one evaluated workspace module namespace.
 *
 * @category loading
 * @since 0.1.0
 */
export const validateWorkspaceModule = (
  namespace: unknown,
  file: string
): WorkspaceDeclaration.WorkspaceDeclaration => {
  if (typeof namespace !== "object" || namespace === null) {
    throw new PackageError("module_import_failed", "WORKSPACE.ts did not evaluate to a module namespace", {
      path: file
    })
  }
  let workspace: WorkspaceDeclaration.WorkspaceDeclaration | undefined
  for (const [name, value] of Object.entries(namespace).sort(([left], [right]) => byCodeUnit(left, right))) {
    if (WorkspaceDeclaration.isWorkspaceDeclaration(value)) {
      if (name !== "Workspace") {
        throw new PackageError(
          "workspace_export_duplicate",
          `a workspace declaration is exported as ${JSON.stringify(name)}; the one legal export name is Workspace`,
          { path: file }
        )
      }
      if (workspace !== undefined) {
        throw new PackageError(
          "workspace_export_duplicate",
          "WORKSPACE.ts exports more than one workspace declaration",
          {
            path: file
          }
        )
      }
      workspace = value
      continue
    }
    if (Target.isTarget(value)) {
      throw new PackageError(
        "naked_target_export",
        `WORKSPACE.ts exports a naked target ${
          JSON.stringify(name)
        }; targets are addressable only through a Package map`,
        { path: file }
      )
    }
    if (Package.isPackage(value)) {
      throw new PackageError(
        "workspace_export_duplicate",
        `WORKSPACE.ts exports a Package value ${JSON.stringify(name)}`,
        {
          path: file
        }
      )
    }
  }
  if (workspace === undefined) {
    throw new PackageError("workspace_export_missing", "WORKSPACE.ts has no Workspace export", { path: file })
  }
  return workspace
}
