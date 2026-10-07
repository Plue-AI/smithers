import { StdError } from "@smthrs/std/StdError"

// Host readiness is diagnostic only. It cannot substitute for the two real
// reference-host checks or enable a fallback executor.
export const dependencies = [
  "T-FLW-01", "T-COL-03", "T-TRM-07", "T-TRM-01", "T-APP-09", "T-APP-10", "T-APP-12"
] as const
export type Providers = Partial<Record<typeof dependencies[number], true>>

export const unavailable = (providers: Providers = {}): StdError => {
  const missing = dependencies.filter((ticket) => providers[ticket] !== true)
  return new StdError({
    code: "provider_unavailable",
    message: `Agent terminal unavailable: ${missing.length > 0 ? `missing ${missing.join(", ")}; ` : ""}requires C-J3-10 and C-COL-04 through the composed install.`
  })
}
