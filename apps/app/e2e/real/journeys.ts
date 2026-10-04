/**
 * Reference-host journeys that exclusive smthrs targets own. Ordinary real-E2E
 * runs neither discover them nor owe them coverage; a journey target enables
 * exactly one by naming its spec in SMITHERS_JOURNEY.
 */
export const journeySpecs = [
  "j1-activation.spec.ts",
  "todo-from-issue.spec.ts",
  "todo-needs-you.spec.ts",
  "todo-evidence.spec.ts",
  "todo-merge.spec.ts"
] as const

/** The journey specs this run leaves out: all of them, except the one SMITHERS_JOURNEY enables. */
export const ignoredJourneys = (env: Record<string, string | undefined>): ReadonlyArray<string> => {
  const enabled = env.SMITHERS_JOURNEY ?? (env.SMITHERS_J1_ACTIVATION === "1" ? "j1-activation.spec.ts" : undefined)
  return journeySpecs.filter((spec) => spec !== enabled)
}
