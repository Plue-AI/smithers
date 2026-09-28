/**
 * Handling of filesystem resources that carry `.` or `..` segments.
 *
 * @since 1.0.0-rc.1
 */

const selectsFilesystem = (action: string): boolean => action === "*" || action.startsWith("fs:")

const isDotSegment = (segment: string): boolean => segment === "." || segment === ".."

/**
 * Reports whether a resource for a filesystem action (`fs:*`, or the `*`
 * wildcard that selects it) contains a `.` or `..` path segment.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const hasDotSegment = (action: string, resource: string): boolean =>
  selectsFilesystem(action) && resource.split("/").some(isDotSegment)

/**
 * Lexically normalizes a relative resource: drops `.` and empty segments and
 * folds `name/..`. Returns `undefined` when a `..` climbs above the start,
 * and `.` for an empty result.
 */
const normalizeRelative = (resource: string): string | undefined => {
  const out: Array<string> = []
  for (const segment of resource.split("/")) {
    if (segment === "" || segment === ".") {
      continue
    }
    if (segment === "..") {
      if (out.length === 0) {
        return undefined
      }
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.length === 0 ? "." : out.join("/")
}

/**
 * The resource forms a pattern must select for a filesystem resource with a
 * dot segment, or `undefined` when no pattern may select it.
 *
 * The matcher compares text, so `/w/**` textually selects `/w/../etc/passwd`
 * and `src/**` selects `src/../../etc`. An absolute resource is what an
 * adapter produces after canonicalizing; one that still carries a dot segment
 * skipped that step, so it is refused. A relative resource is a flow's
 * declared scope (`fs:read:.`, `fs:write:./src/./out`) that a consumer
 * resolves against the workspace root later; it is accepted only when it
 * stays inside its starting directory, and a pattern must select both the
 * written text and its lexical normal form. Resources with glob
 * metacharacters before a `..` are refused, since a `*` may span segments and
 * the fold would be unsound.
 *
 * Returns `[resource]` for anything without a dot segment or outside the
 * filesystem.
 *
 * @since 1.0.0-rc.1
 * @private
 */
export const dotSegmentForms = (action: string, resource: string): ReadonlyArray<string> | undefined => {
  if (!hasDotSegment(action, resource)) {
    return [resource]
  }
  if (resource.startsWith("/") || resource.includes("\\") || /^[A-Za-z]:/.test(resource) || resource.startsWith("~")) {
    return undefined
  }
  const segments = resource.split("/")
  const lastParent = segments.lastIndexOf("..")
  if (lastParent >= 0 && segments.slice(0, lastParent).some((segment) => /[*?]/.test(segment))) {
    return undefined
  }
  const normal = normalizeRelative(resource)
  return normal === undefined ? undefined : [resource, normal]
}
