/**
 * FACTORY.ts module validation.
 *
 * The factory module sits beside `WORKSPACE.ts` (`.smithers/FACTORY.ts`, or
 * the root `FACTORY.ts` beside a root `WORKSPACE.ts`) and exports exactly one
 * factory declaration under the export name `factory`, and at most one home
 * declaration under the export name `home`. It may import `WORKSPACE.ts`
 * and its siblings; it never imports a `PACKAGE.ts`, which the loader's
 * static import scan enforces, because a factory names the targets it needs
 * by label (`S.label("//:ci")`) and never by value. `Smithers.Flow` values
 * exported beside the factory are plain data and pass through.
 *
 * @since 1.0.0
 */

import * as Factory from "@smthrs/targets/Factory"
import * as Home from "@smthrs/targets/Home"
import * as Package from "@smthrs/targets/Package"
import * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { byCodeUnit } from "./internal/Text.ts"
import { PackageError } from "./PackageError.ts"

/**
 * One evaluated, validated FACTORY.ts module.
 *
 * @category models
 * @since 1.0.0
 */
export interface LoadedFactory {
  /** The workspace-relative module path, `.smithers/FACTORY.ts`. */
  readonly file: string
  /** The validated factory declaration. */
  readonly factory: Factory.Declaration
  /** The validated home declaration, when the module exports one. */
  readonly home: Home.Declaration | undefined
}

/**
 * The factory declaration file beside one workspace declaration file:
 * `.smithers/FACTORY.ts` beside `.smithers/WORKSPACE.ts`, `FACTORY.ts`
 * beside a root `WORKSPACE.ts`.
 *
 * @category discovery
 * @since 1.0.0
 */
export const factoryFileBeside = (workspaceFile: string): string =>
  workspaceFile.endsWith("/WORKSPACE.ts")
    ? `${workspaceFile.slice(0, -"WORKSPACE.ts".length)}FACTORY.ts`
    : "FACTORY.ts"

/**
 * Validates one evaluated factory module namespace.
 *
 * @category loading
 * @since 1.0.0
 */
export const validateFactoryModule = (namespace: unknown, file: string): LoadedFactory => {
  if (typeof namespace !== "object" || namespace === null) {
    throw new PackageError("module_import_failed", "FACTORY.ts did not evaluate to a module namespace", {
      path: file
    })
  }
  let factory: Factory.Declaration | undefined
  let home: Home.Declaration | undefined
  for (const [name, value] of Object.entries(namespace).sort(([left], [right]) => byCodeUnit(left, right))) {
    if (Factory.isFactoryDeclaration(value)) {
      if (name !== "factory") {
        throw new PackageError(
          "factory_export_duplicate",
          `a factory declaration is exported as ${JSON.stringify(name)}; the one legal export name is factory`,
          { path: file }
        )
      }
      if (factory !== undefined) {
        throw new PackageError("factory_export_duplicate", "FACTORY.ts exports more than one factory declaration", {
          path: file
        })
      }
      factory = value
      continue
    }
    if (Home.isHomeDeclaration(value)) {
      if (name !== "home") {
        throw new PackageError(
          "factory_export_duplicate",
          `a home declaration is exported as ${JSON.stringify(name)}; the one legal export name is home`,
          { path: file }
        )
      }
      if (home !== undefined) {
        throw new PackageError("factory_export_duplicate", "FACTORY.ts exports more than one home declaration", {
          path: file
        })
      }
      home = value
      continue
    }
    if (name === "factory") {
      throw new PackageError("factory_export_missing", "the factory export is not an S.Factory value", { path: file })
    }
    if (name === "home") {
      throw new PackageError("factory_export_missing", "the home export is not an S.Factory.Home value", {
        path: file
      })
    }
    if (Target.isTarget(value)) {
      throw new PackageError(
        "naked_target_export",
        `FACTORY.ts exports a naked target ${
          JSON.stringify(name)
        }; a factory names targets by label (S.label), and targets are addressable only through a Package map`,
        { path: file }
      )
    }
    if (Package.isPackage(value)) {
      throw new PackageError("factory_export_duplicate", `FACTORY.ts exports a Package value ${JSON.stringify(name)}`, {
        path: file
      })
    }
    if (WorkspaceDeclaration.isWorkspaceDeclaration(value)) {
      throw new PackageError(
        "factory_export_duplicate",
        `FACTORY.ts exports a workspace declaration ${JSON.stringify(name)}; the workspace is declared in WORKSPACE.ts`,
        { path: file }
      )
    }
  }
  if (factory === undefined) {
    throw new PackageError("factory_export_missing", "FACTORY.ts has no factory export", { path: file })
  }
  return { file, factory, home }
}
