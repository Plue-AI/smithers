/** Only the opt-in controlled process rehearsal injects this adapter. */
import { serve } from "../../coding/serve-host.ts"
import { make } from "./rehearsal-mutations.ts"

await serve({ fileMutationProvider: make })
