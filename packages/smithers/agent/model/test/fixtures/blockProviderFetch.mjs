import { writeFileSync } from "node:fs"

globalThis.fetch = async () => {
  const marker = process.env.SMITHERS_EVALUATOR_FETCH_MARKER
  if (marker !== undefined) writeFileSync(marker, "called")
  throw new Error("Live provider request during a non-live test run")
}
