import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"

export const directoryVariable = "SMITHERS_LIBRARIAN_STATE_DIR"
export const inRootVariable = "SMITHERS_LIBRARIAN_STATE_IN_ROOT"

const inside = (parent: string, child: string): boolean => {
  const from = resolve(parent), to = resolve(child)
  return to === from || to.startsWith(from.endsWith(sep) ? from : from + sep)
}
const truthy = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase())

export const defaultStateRoot = (
  root: string,
  environment: Readonly<Record<string, string | undefined>> = {}
): string => {
  const repository = resolve(root)
  const parent = dirname(repository)
  if (parent !== repository) return join(parent, ".smithers-librarian-state", basename(repository))
  const base = environment.XDG_STATE_HOME?.trim() || join(environment.HOME?.trim() || tmpdir(), ".local", "state")
  return join(
    resolve(base),
    "smithers",
    "librarian",
    createHash("sha256").update(repository).digest("hex").slice(0, 16)
  )
}

export const resolveStateRoot = (options: {
  readonly root: string
  readonly explicit?: string | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
}): string => {
  const environment = options.environment ?? {}
  const root = resolve(options.root)
  const named = (options.explicit ?? environment[directoryVariable] ?? "").trim()
  const optedIn = truthy(environment[inRootVariable])
  const stateRoot = named === "" ? (optedIn ? root : defaultStateRoot(root, environment)) : resolve(root, named)
  if (dirname(root) !== root && inside(root, stateRoot) && !optedIn) {
    throw new Error(
      `Refusing to keep librarian runtime state inside the served repository; pass --state-dir outside it or set ${inRootVariable}=1`
    )
  }
  return stateRoot
}
