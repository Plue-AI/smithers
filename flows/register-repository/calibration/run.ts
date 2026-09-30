/** Regenerate corpus.json and fit.json: `node --experimental-strip-types flows/register-repository/calibration/run.ts`. */
import { writeFileSync } from "node:fs"
import { fit } from "./fit.ts"
import { generate, SEED } from "./generate.ts"

const here = new URL(".", import.meta.url)
const cases = generate()
writeFileSync(new URL("corpus.json", here), JSON.stringify({ seed: SEED, synthetic: true, cases }, null, 1) + "\n")
writeFileSync(new URL("fit.json", here), JSON.stringify(fit(cases), null, 2) + "\n")
