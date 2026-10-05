import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * Generates apps/app/proof/mock-steps.json from the design mock's journeys
 * (.specs/design/mock/src/journeys), so the proof jobs read the mock's step
 * captions from the repository and never from a scratch copy.
 *
 * `bun apps/app/proof/mock-steps.ts` rewrites the file; `--check` exits 1 when
 * the committed file differs from the mock.
 */

export interface MockJourney {
  /** The journey's file name under journeys/, the `<journey file>` in a `<journey file>#<n>` reference. */
  readonly file: string
  readonly id: string
  readonly title: string
  readonly intro: string
  /** Step captions in play order; step n is steps[n - 1]. */
  readonly steps: ReadonlyArray<string>
}

export const MOCK_STEPS_PATH = "apps/app/proof/mock-steps.json"
const JOURNEYS_DIR = ".specs/design/mock/src/journeys"

interface JourneyShape { readonly id: string; readonly title: string; readonly intro: string; readonly steps: ReadonlyArray<{ readonly caption: string }> }

const isJourney = (value: unknown): value is JourneyShape =>
  typeof value === "object" && value !== null && Array.isArray((value as { steps?: unknown }).steps) && typeof (value as { setup?: unknown }).setup === "function"

/** Every journey the mock plays, in the player's order (journeys/index.ts JOURNEYS). */
export async function readMockJourneys(root: string): Promise<MockJourney[]> {
  const dir = resolve(root, JOURNEYS_DIR)
  const files = new Map<unknown, string>()
  for (const name of readdirSync(dir).filter(name => name.endsWith(".ts") && name !== "index.ts").sort()) {
    const module: Record<string, unknown> = await import(join(dir, name))
    for (const value of Object.values(module)) if (isJourney(value)) files.set(value, name.slice(0, -3))
  }
  const { JOURNEYS } = (await import(join(dir, "index.ts"))) as { JOURNEYS: ReadonlyArray<JourneyShape> }
  return JOURNEYS.map(journey => {
    const file = files.get(journey)
    if (file === undefined) throw new Error(`journey ${journey.id} is not exported from a file under ${JOURNEYS_DIR}`)
    return { file, id: journey.id, title: journey.title, intro: journey.intro, steps: journey.steps.map(step => step.caption) }
  })
}

export const renderMockSteps = (journeys: ReadonlyArray<MockJourney>): string => `${JSON.stringify(journeys, null, 1)}\n`

/** The committed mock-steps.json. */
export function readMockSteps(root: string): MockJourney[] {
  return JSON.parse(readFileSync(resolve(root, MOCK_STEPS_PATH), "utf8")) as MockJourney[]
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../../..")
  const rendered = renderMockSteps(await readMockJourneys(root))
  if (process.argv.includes("--check")) {
    const committed = readFileSync(resolve(root, MOCK_STEPS_PATH), "utf8")
    if (committed !== rendered) {
      console.error(`${MOCK_STEPS_PATH} is stale: run bun ${MOCK_STEPS_PATH.replace(/\.json$/, ".ts")}`)
      process.exit(1)
    }
    console.log(`${MOCK_STEPS_PATH} matches the mock.`)
  } else {
    writeFileSync(resolve(root, MOCK_STEPS_PATH), rendered)
    const journeys = JSON.parse(rendered) as MockJourney[]
    console.log(`wrote ${MOCK_STEPS_PATH}: ${journeys.length} journeys, ${journeys.reduce((sum, journey) => sum + journey.steps.length, 0)} steps`)
  }
}
