/**
 * The instances a re-run owes, taken from the baseline rather than typed out.
 *
 *   node lib/rerun-queue.mjs <dataset.json> <baseline.jsonl> <rerun.jsonl> \
 *     [--all|--remaining|--done|--count|--unclean]
 *
 * A re-run only measures a harness change if it meets **the same instances** as
 * the run it is compared against. So the population is derived, never declared:
 * it is exactly the set of ids the baseline ledger graded, and there is no flag
 * to add one or drop one. A re-run that cannot read the baseline has no
 * population and refuses to start.
 *
 * The order is the baseline's own — `lib/fullbench-queue.mjs`'s seeded draw —
 * filtered to that set. Two runs that meet the same instances in the same order
 * are comparable at every prefix, which is what makes a half-finished re-run
 * readable rather than merely incomplete.
 *
 * "What is left" is the same `isDone` rule the full benchmark resumes on: an
 * instance whose last row in the *re-run's* ledger is `graded` or `cleaned` is
 * finished, everything else runs from the top.
 *
 * Spends nothing, needs no docker.
 *
 * @since 0.1.0
 */
import { readFileSync } from "node:fs"
import { isDone, read } from "./fullbench-manifest.mjs"
import { drawOrder } from "./fullbench-queue.mjs"

/**
 * The ids a baseline ledger graded, in the dataset's seeded draw order.
 *
 * @category conversions
 * @since 0.1.0
 */
export const population = (datasetRows, baselinePath) => {
  const baseline = read(baselinePath)
  const graded = new Set()
  for (const [id, state] of baseline.states) {
    if (isDone(state)) graded.add(id)
  }
  if (graded.size === 0) {
    throw new Error(`${baselinePath} graded no instances, so a re-run of it has no population`)
  }
  const ordered = drawOrder(datasetRows).filter((id) => graded.has(id))
  if (ordered.length !== graded.size) {
    // An id in the baseline that the dataset does not hold means the two are
    // about different benchmarks, and a comparison across them would be a
    // comparison of populations rather than of harnesses.
    const missing = [...graded].filter((id) => !ordered.includes(id))
    throw new Error(`the dataset does not contain ${missing.length} baseline instance(s): ${missing.join(", ")}`)
  }
  return ordered
}

const main = () => {
  const [, , datasetPath, baselinePath, rerunPath, mode = "--remaining"] = process.argv
  if (datasetPath === undefined || baselinePath === undefined || rerunPath === undefined) {
    console.error(
      "usage: node lib/rerun-queue.mjs <dataset.json> <baseline.jsonl> <rerun.jsonl> [--all|--remaining|--done|--count|--unclean]"
    )
    process.exit(2)
  }
  let ids
  try {
    ids = population(JSON.parse(readFileSync(datasetPath, "utf8")), baselinePath)
  } catch (error) {
    console.error(`rerun-queue.mjs: ${error.message}`)
    process.exit(1)
  }
  const rerun = read(rerunPath)
  const remaining = ids.filter((id) => !isDone(rerun.states.get(id)))
  const done = ids.filter((id) => isDone(rerun.states.get(id)))

  switch (mode) {
    case "--all":
      process.stdout.write(`${ids.join("\n")}\n`)
      break
    case "--done":
      if (done.length > 0) process.stdout.write(`${done.join("\n")}\n`)
      break
    case "--count":
      process.stdout.write(`${done.length} ${remaining.length} ${ids.length}\n`)
      break
    // Graded but never cleaned — a kill between the verdict and the `docker
    // rmi`. Nothing visits those instances again, so their images are the only
    // ones that can be orphaned for the rest of the re-run.
    case "--unclean": {
      const lines = done
        .map((id) => rerun.states.get(id))
        .filter((state) => state.state !== "cleaned" && typeof state.image === "string")
        .map((state) => `${state.id} ${state.image}`)
      if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`)
      break
    }
    case "--remaining":
      if (remaining.length > 0) process.stdout.write(`${remaining.join("\n")}\n`)
      break
    default:
      console.error(`rerun-queue.mjs: unknown mode '${mode}'`)
      process.exit(2)
  }
}

if (import.meta.filename === process.argv[1]) main()
