/**
 * An invalid image package proposal refused before producing a diff.
 * @since 1.0.0
 * @category errors
 */
export class MachineJsonRejected extends Error {
  readonly _tag = "MachineJsonRejected"
  readonly code:
    | "invalid_name"
    | "invalid_json"
    | "invalid_document"
    | "invalid_packages"
    | "duplicate_package"
    | "package_limit"
  constructor(
    code:
      | "invalid_name"
      | "invalid_json"
      | "invalid_document"
      | "invalid_packages"
      | "duplicate_package"
      | "package_limit",
    message: string
  ) {
    super(message)
    this.code = code
    this.name = "MachineJsonRejected"
  }
}

/**
 * Reviewed image additions, shared by Settings and failed TODOs.
 * @since 1.0.0
 * @category constants
 */
export const MACHINE_JSON_PATH = ".smithers/machine.json"
/**
 * Matches bounded Debian package names accepted in image proposals.
 * @since 1.0.0
 * @category constants
 */
export const IMAGE_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]{0,127}$/

/**
 * Preserve package order and produce a proposal affecting only machine.json.
 * @since 1.0.0
 * @category constructors
 */
export const addImagePackage = (
  current: string | null | undefined,
  name: string
): { readonly next: string; readonly diff: string } => {
  if (!IMAGE_PACKAGE_PATTERN.test(name)) throw new MachineJsonRejected("invalid_name", "Invalid Debian package name")
  let value: unknown = { packages: [] }
  if (current != null) {
    try {
      value = JSON.parse(current)
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause
      throw new MachineJsonRejected("invalid_json", "Invalid machine.json JSON")
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MachineJsonRejected("invalid_document", "Invalid machine.json")
  }
  const object = value as Record<string, unknown>
  if (Object.keys(object).some((key) => key !== "packages")) {
    throw new MachineJsonRejected("invalid_document", "Invalid machine.json")
  }
  // The only allowed values are package-name strings, which contain no colon.
  // Count JSON property tokens as well as decoded keys so duplicate (including
  // escaped) packages fields cannot be silently collapsed by JSON.parse.
  if (current != null && (current.match(/"(?:[^"\\]|\\.)*"\s*:/g)?.length ?? 0) !== Object.keys(object).length) {
    throw new MachineJsonRejected("invalid_document", "Invalid machine.json")
  }
  const packages = Object.hasOwn(object, "packages") ? object.packages : []
  if (
    !Array.isArray(packages) || packages.length > 64 ||
    packages.some((item) => typeof item !== "string" || !IMAGE_PACKAGE_PATTERN.test(item))
  ) throw new MachineJsonRejected("invalid_packages", "Invalid machine.json packages")
  if (packages.includes(name)) throw new MachineJsonRejected("duplicate_package", "Package already present")
  if (packages.length === 64) throw new MachineJsonRejected("package_limit", "At most 64 packages")
  const next = JSON.stringify({ packages: [...packages, name] }, null, 2) + "\n"
  const old = current == null ? [] : current.replace(/\n$/, "").split("\n")
  const lines = next.replace(/\n$/, "").split("\n")
  const diff =
    `--- ${current == null ? "/dev/null" : `a/${MACHINE_JSON_PATH}`}\n+++ b/${MACHINE_JSON_PATH}\n@@ -${
      old.length ? "1" : "0"
    },${old.length} +1,${lines.length} @@\n` + old.map((line) => `-${line}\n`).join("") + lines.map((line) =>
      `+${line}\n`
    ).join("")
  return { next, diff }
}
