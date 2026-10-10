/**
 * T-REL-04: the long tier of the Go-backed durability cases, run nightly by
 * `//packages/smithers:faultsLong`. Each case here is measured in tens of
 * minutes or budgeted in hours, so the release gate does not wait on it. The
 * table and the tier rule live in `harness/goFaultCases.ts`.
 */
import { registerGoFaultCases } from "../harness/goFaultRun.ts"

registerGoFaultCases("long")
