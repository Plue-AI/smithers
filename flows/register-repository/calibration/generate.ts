/**
 * Synthetic calibration corpus for S1-S5. NOT recorded from real repositories: each case draws
 * its signal values from a seeded log-normal whose median is a documented per-label multiple of a
 * per-language, per-band human baseline. See docs/mvp/research/registration-scores-calibration.md.
 */
import { BANDS, type CorpusCase, type Deterministic, LANGUAGES, type Label } from "./fit.ts"

/** Human median per signal (duplicated blocks per KLOC, churn share, lexicon and stubs per KLOC, unused-export share). */
const BASE: Record<Deterministic, number> = { duplicates: 4, churn: 0.12, lexicon: 0.8, stubs: 0.6, "dead-code": 0.1 }
/** Multiples of the human median by label; agent churn and clone growth follow GitClear's 2x and up to 8x reports, the rest are assumptions. */
const MULTIPLE: Record<Label, Record<Deterministic, number>> = {
  human: { duplicates: 1, churn: 1, lexicon: 1, stubs: 1, "dead-code": 1 },
  hybrid: { duplicates: 1.5, churn: 1.3, lexicon: 1.8, stubs: 1.6, "dead-code": 1.3 },
  agent: { duplicates: 2.5, churn: 1.9, lexicon: 3.5, stubs: 3, "dead-code": 1.8 }
}
const LANGUAGE_SCALE = { ts: 1, python: 0.9, go: 0.8, rust: 0.7 } as const
const BAND_SCALE = { small: 0.7, medium: 1, large: 1.3 } as const
const SIGMA = 0.55
export const PER_STRATUM: Record<Label, number> = { human: 12, agent: 8, hybrid: 5 }
export const SEED = 3150

const generator = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

export const generate = (): ReadonlyArray<CorpusCase> => {
  const next = generator(SEED)
  const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next())
  const cases: Array<CorpusCase> = []
  for (const language of LANGUAGES) {
    for (const band of BANDS) {
      for (const label of ["human", "agent", "hybrid"] as const) {
        for (let index = 0; index < PER_STRATUM[label]; index++) {
          const values = Object.fromEntries(
            (Object.keys(BASE) as Array<Deterministic>).map((id) => {
              const median = BASE[id] * LANGUAGE_SCALE[language] * BAND_SCALE[band] * MULTIPLE[label][id]
              return [id, Math.round(median * Math.exp(SIGMA * normal()) * 10_000) / 10_000]
            })
          ) as Record<Deterministic, number>
          cases.push({ id: `${language}-${band}-${label}-${String(index).padStart(2, "0")}`, language, band, label, values })
        }
      }
    }
  }
  return cases
}
