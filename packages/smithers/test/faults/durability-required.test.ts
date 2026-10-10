/**
 * T-REL-04: the release tier of the Go-backed durability cases. The release
 * gate's "Exclusive fault matrix" runs these; `long/durability-long.test.ts`
 * runs the cases measured in tens of minutes or hours, nightly. The table and
 * the tier rule live in `harness/goFaultCases.ts`.
 */
import { registerGoFaultCases } from "./harness/goFaultRun.ts"

registerGoFaultCases("release")
