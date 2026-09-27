import * as Fs from "node:fs"
import * as NodePath from "node:path"

const manifest = JSON.parse(
  Fs.readFileSync(NodePath.resolve(import.meta.dirname, "../../../../../../package.json"), "utf8")
) as { readonly packageManager: string }

/**
 * The repository's pinned pnpm version. A fixture that runs a real pnpm
 * declares this pin so pnpm 11 never switches versions mid-test.
 */
export const repositoryPnpmVersion: string = manifest.packageManager.replace(/^pnpm@/, "")
