/** Files read by the hygiene gate and package-scoped repository input groups. */
export const listFiles: (
  root: string,
  options?: { readonly includeUntracked?: boolean; readonly projectedTree?: boolean }
) => string[]
