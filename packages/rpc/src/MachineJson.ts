/** Reviewed image additions, shared by Settings and failed TODOs. */
export const MACHINE_JSON_PATH = ".smithers/machine.json"
export const IMAGE_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]{0,127}$/

/** Preserve package order and produce a proposal affecting only machine.json. */
export const addImagePackage = (current: string | null | undefined, name: string): { readonly next: string; readonly diff: string } => {
  if (!IMAGE_PACKAGE_PATTERN.test(name)) throw new Error("Invalid Debian package name")
  const value: unknown = current == null ? { packages: [] } : JSON.parse(current)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid machine.json")
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => key !== "packages")) throw new Error("Invalid machine.json")
  // The only allowed values are package-name strings, which contain no colon.
  // Count JSON property tokens as well as decoded keys so duplicate (including
  // escaped) packages fields cannot be silently collapsed by JSON.parse.
  if (current != null && (current.match(/"(?:[^"\\]|\\.)*"\s*:/g)?.length ?? 0) !== Object.keys(object).length) throw new Error("Invalid machine.json")
  const packages = Object.hasOwn(object, "packages") ? object.packages : []
  if (!Array.isArray(packages) || packages.length > 64 || packages.some(item => typeof item !== "string" || !IMAGE_PACKAGE_PATTERN.test(item))) throw new Error("Invalid machine.json packages")
  if (packages.includes(name)) throw new Error("Package already present")
  if (packages.length === 64) throw new Error("At most 64 packages")
  const next = JSON.stringify({ packages: [...packages, name] }, null, 2) + "\n"
  const old = current == null ? [] : current.replace(/\n$/, "").split("\n")
  const lines = next.replace(/\n$/, "").split("\n")
  const diff = `--- ${current == null ? "/dev/null" : `a/${MACHINE_JSON_PATH}`}\n+++ b/${MACHINE_JSON_PATH}\n@@ -${old.length ? "1" : "0"},${old.length} +1,${lines.length} @@\n` + old.map(line => `-${line}\n`).join("") + lines.map(line => `+${line}\n`).join("")
  return { next, diff }
}
